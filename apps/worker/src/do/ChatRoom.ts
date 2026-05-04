// SPDX-License-Identifier: Apache-2.0

// ChatRoom Durable Object — one instance per room. SPEC §9.
//
// Uses the **WebSocket Hibernation API**: between message bursts the JS
// isolate is unloaded and idle rooms cost zero GB-s. Identity for an open
// socket survives via `ws.serializeAttachment(...)`; per-room SQLite state
// survives via `ctx.storage.sql`.
//
// References:
//   - https://developers.cloudflare.com/durable-objects/best-practices/websockets/
//   - cloudflare/workers-chat-demo (canonical hibernation pattern)
//
// Critical invariants:
//   1. Never the legacy `ws.addEventListener` API. The four overrides
//      (`fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`)
//      are class methods, called by the runtime on traffic.
//   2. Never iterate a `Map<userId, ws>` instance field — it dies at
//      hibernation. Use `ctx.getWebSockets()`.
//   3. The `send` path wraps insert + ack-send in
//      `ctx.blockConcurrencyWhile(...)` so a checkpoint between durable
//      write and acknowledgement is impossible (SPEC §9 acceptance
//      criterion: "killing the DO mid-write does not lose acknowledged
//      messages").

import { DurableObject } from "cloudflare:workers";
import {
  type ClientMsg,
  ClientMsgSchema,
  ErrorCodes,
  MAX_BODY_CHARS,
  PROTOCOL_VERSION,
  type ServerMsg,
  type WireMessage,
  id,
} from "@loomwiki/shared";
import type { Env } from "../env.js";
import { type MirrorMessage, mirrorMessageToD1 } from "../lib/d1-mirror.js";
import { RollingWindowLimiter } from "../lib/rate-limit.js";
import {
  appendMessage,
  applyDelete,
  applyEdit,
  clearPendingMirror,
  getMessageById,
  getPendingMirrorRows,
  getRecent,
  getRecentSince,
  getRoomId,
  hasPendingMirror,
  initStorage,
  markPendingMirror,
  setRoomId,
} from "./storage.js";

// SPEC §9 caps.
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_PER_WINDOW = 100;
// Reconnect-resume payload cap (SPEC §9 prompt: "capped at 200 to bound
// payload"). Fresh connects (no `sinceMessageId`) get the most recent 50.
const WELCOME_MAX_RESUME = 200;
const WELCOME_DEFAULT_RECENT = 50;
// Mirror reconciliation: if any rows are pending, schedule an alarm 60s out
// to retry. Cleared once the queue drains.
const MIRROR_RETRY_ALARM_MS = 60_000;
// Per-alarm batch cap — a long mirror outage can't queue an unbounded retry.
const MIRROR_RETRY_BATCH = 100;

/** Per-WS attachment shape. Survives hibernation. */
interface WsAttachment {
  userId: string;
  roomId: string;
  /**
   * Last server messageId delivered to this socket. We don't need it for
   * correctness (reconnect via `sinceMessageId` is the resume mechanism),
   * but having it persists "this client has seen up to here" across
   * hibernation in case future surfaces (presence, read receipts) need it.
   */
  lastSeenId?: string;
}

function readAttachment(ws: WebSocket): WsAttachment | null {
  const raw = ws.deserializeAttachment();
  if (raw && typeof raw === "object" && "userId" in raw && "roomId" in raw) {
    return raw as WsAttachment;
  }
  return null;
}

function sendServer(ws: WebSocket, msg: ServerMsg): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket closed mid-send; the runtime fires webSocketClose shortly.
  }
}

function sendError(ws: WebSocket, code: string, message: string, tempId?: string): void {
  const env: ServerMsg =
    tempId !== undefined
      ? { kind: "error", code, message, tempId }
      : { kind: "error", code, message };
  sendServer(ws, env);
}

export class ChatRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly limiter: RollingWindowLimiter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    initStorage(this.sql);
    this.limiter = new RollingWindowLimiter(RATE_LIMIT_PER_WINDOW, RATE_LIMIT_WINDOW_MS);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected upgrade", { status: 426 });
    }

    const userId = request.headers.get("x-loomwiki-user-id");
    const roomId = request.headers.get("x-loomwiki-room-id");
    if (!userId || !roomId) {
      // The route layer in apps/worker/src/routes/rooms.ts is responsible
      // for setting these. If they're missing, the upgrade was forged or
      // the route layer regressed — fail closed.
      return new Response("missing identity headers", { status: 400 });
    }

    // Persist roomId so the alarm path (mirror retry) can recover it even
    // when zero sockets are open.
    setRoomId(this.sql, roomId);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation API: the runtime owns the lifecycle from here. Class
    // methods (`webSocketMessage`/`webSocketClose`/`webSocketError`) handle
    // incoming traffic without keeping the isolate warm.
    this.ctx.acceptWebSocket(server);

    const attachment: WsAttachment = { userId, roomId };
    server.serializeAttachment(attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: ArrayBuffer | string): Promise<void> {
    const attachment = readAttachment(ws);
    if (!attachment) {
      sendError(ws, ErrorCodes.AUTH_REQUIRED, "session lost; reconnect");
      ws.close(1011, "session lost");
      return;
    }

    let parsed: ClientMsg;
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      const json: unknown = JSON.parse(text);
      const result = ClientMsgSchema.safeParse(json);
      if (!result.success) {
        sendError(ws, ErrorCodes.VALIDATION_FAILED, "invalid envelope");
        return;
      }
      parsed = result.data;
    } catch {
      sendError(ws, ErrorCodes.VALIDATION_FAILED, "malformed JSON");
      return;
    }

    switch (parsed.kind) {
      case "hello":
        await this.handleHello(ws, attachment, parsed.sinceMessageId);
        return;
      case "ping":
        sendServer(ws, { kind: "pong" });
        return;
      case "send":
        await this.handleSend(ws, attachment, parsed);
        return;
      case "edit":
        await this.handleEdit(ws, attachment, parsed.messageId, parsed.body);
        return;
      case "delete":
        await this.handleDelete(ws, attachment, parsed.messageId);
        return;
    }
  }

  override webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    // Hibernation does not require explicit cleanup — the runtime drops the
    // socket. We still call close() to finalize the close handshake when
    // the peer initiated.
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    console.warn("[chatroom] websocket error", { error: String(error) });
    try {
      ws.close(1011, "internal error");
    } catch {
      // Already closed.
    }
  }

  override async alarm(): Promise<void> {
    await this.flushPendingMirror();
    if (hasPendingMirror(this.sql)) {
      await this.ctx.storage.setAlarm(Date.now() + MIRROR_RETRY_ALARM_MS);
    }
  }

  // ---------- handlers ----------

  private async handleHello(
    ws: WebSocket,
    attachment: WsAttachment,
    sinceMessageId: string | undefined,
  ): Promise<void> {
    let recentMessages: WireMessage[];
    let hasMore: boolean;
    if (sinceMessageId !== undefined) {
      const page = getRecentSince(this.sql, attachment.roomId, sinceMessageId, WELCOME_MAX_RESUME);
      recentMessages = page.messages;
      hasMore = page.hasMore;
    } else {
      recentMessages = getRecent(this.sql, attachment.roomId, WELCOME_DEFAULT_RECENT);
      // Fresh clients without a cursor get the most-recent N. If the room
      // has more history beyond that, it's reachable via REST scrollback;
      // we still flag it so UIs can show a "load older" affordance.
      hasMore = recentMessages.length === WELCOME_DEFAULT_RECENT;
    }

    sendServer(ws, {
      kind: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      roomId: attachment.roomId,
      recentMessages,
      hasMore,
    });

    if (recentMessages.length > 0) {
      const last = recentMessages[recentMessages.length - 1];
      if (last) {
        const next: WsAttachment = { ...attachment, lastSeenId: last.id };
        ws.serializeAttachment(next);
      }
    }
  }

  private async handleSend(
    ws: WebSocket,
    attachment: WsAttachment,
    env: { tempId: string; body: string; parentId?: string },
  ): Promise<void> {
    if (env.body.length > MAX_BODY_CHARS) {
      sendError(ws, ErrorCodes.VALIDATION_FAILED, "body exceeds 4096 chars", env.tempId);
      return;
    }
    if (!this.limiter.tryAcquire(Date.now())) {
      sendError(ws, ErrorCodes.RATE_LIMITED, "100 msg/sec/room cap reached", env.tempId);
      return;
    }

    const messageId = id();
    const createdAt = Math.floor(Date.now() / 1000);
    const parentId = env.parentId ?? null;

    let wireMessage: WireMessage | null = null;

    // Insert + ack must be atomic. blockConcurrencyWhile prevents a
    // checkpoint from landing between durable write and ack — SPEC §9
    // acceptance criterion ("crashing the DO mid-write does not lose
    // acknowledged messages").
    await this.ctx.blockConcurrencyWhile(async () => {
      appendMessage(this.sql, {
        id: messageId,
        userId: attachment.userId,
        body: env.body,
        parentId,
        createdAt,
        pendingMirror: true,
      });
      sendServer(ws, { kind: "ack", tempId: env.tempId, messageId });
      wireMessage = {
        id: messageId,
        room_id: attachment.roomId,
        user_id: attachment.userId,
        body: env.body,
        parent_id: parentId,
        created_at: createdAt,
        edited_at: null,
        deleted_at: null,
      };
    });

    if (!wireMessage) return;

    this.broadcastExcept(ws, { kind: "message", message: wireMessage });

    // D1 mirror: best-effort, off the ack critical path.
    this.scheduleMirror({
      id: messageId,
      roomId: attachment.roomId,
      userId: attachment.userId,
      body: env.body,
      parentId,
      createdAt,
      editedAt: null,
      deletedAt: null,
    });
  }

  private async handleEdit(
    ws: WebSocket,
    attachment: WsAttachment,
    messageId: string,
    newBody: string,
  ): Promise<void> {
    if (newBody.length > MAX_BODY_CHARS) {
      sendError(ws, ErrorCodes.VALIDATION_FAILED, "body exceeds 4096 chars");
      return;
    }
    const existing = getMessageById(this.sql, attachment.roomId, messageId);
    if (!existing) {
      sendError(ws, ErrorCodes.NOT_FOUND, "message not found");
      return;
    }
    if (existing.user_id !== attachment.userId) {
      sendError(ws, ErrorCodes.FORBIDDEN, "not message author");
      return;
    }
    if (existing.deleted_at !== null) {
      // Editing a tombstone is meaningless and would cause body to leak past
      // the rowToWire blanking.
      sendError(ws, ErrorCodes.CONFLICT, "message is deleted");
      return;
    }

    const editedAt = Math.floor(Date.now() / 1000);
    applyEdit(this.sql, messageId, newBody, editedAt);

    const broadcast: ServerMsg = {
      kind: "edited",
      messageId,
      body: newBody,
      editedAt,
    };
    sendServer(ws, broadcast);
    this.broadcastExcept(ws, broadcast);

    this.scheduleMirror({
      id: messageId,
      roomId: attachment.roomId,
      userId: existing.user_id,
      body: newBody,
      parentId: existing.parent_id,
      createdAt: existing.created_at,
      editedAt,
      deletedAt: null,
    });
  }

  private async handleDelete(
    ws: WebSocket,
    attachment: WsAttachment,
    messageId: string,
  ): Promise<void> {
    const existing = getMessageById(this.sql, attachment.roomId, messageId);
    if (!existing) {
      sendError(ws, ErrorCodes.NOT_FOUND, "message not found");
      return;
    }
    if (existing.user_id !== attachment.userId) {
      sendError(ws, ErrorCodes.FORBIDDEN, "not message author");
      return;
    }
    if (existing.deleted_at !== null) return; // idempotent

    const deletedAt = Math.floor(Date.now() / 1000);
    applyDelete(this.sql, messageId, deletedAt);

    const broadcast: ServerMsg = { kind: "deleted", messageId, deletedAt };
    sendServer(ws, broadcast);
    this.broadcastExcept(ws, broadcast);

    this.scheduleMirror({
      id: messageId,
      roomId: attachment.roomId,
      userId: existing.user_id,
      // Body intentionally retained in D1 alongside deleted_at so a future
      // GDPR-style "hard erase" path can scrub deliberately. The on-wire
      // shape blanks it via rowToWire.
      body: existing.body,
      parentId: existing.parent_id,
      createdAt: existing.created_at,
      editedAt: existing.edited_at,
      deletedAt,
    });
  }

  // ---------- broadcast / mirror plumbing ----------

  private broadcastExcept(except: WebSocket, msg: ServerMsg): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(payload);
      } catch {
        // Drop and let webSocketClose run.
      }
    }
  }

  private scheduleMirror(msg: MirrorMessage): void {
    this.ctx.waitUntil(this.tryMirror(msg));
  }

  private async tryMirror(msg: MirrorMessage): Promise<void> {
    try {
      await mirrorMessageToD1(this.env, msg);
      clearPendingMirror(this.sql, msg.id);
    } catch (err) {
      console.warn("[chatroom] mirror failed", { id: msg.id, err: String(err) });
      markPendingMirror(this.sql, msg.id);
      await this.ensureRetryAlarm();
    }
  }

  private async ensureRetryAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      await this.ctx.storage.setAlarm(Date.now() + MIRROR_RETRY_ALARM_MS);
    }
  }

  private async flushPendingMirror(): Promise<void> {
    const roomId = getRoomId(this.sql);
    if (!roomId) {
      // Nothing has ever been written to this DO yet — nothing to mirror.
      return;
    }
    const pending = getPendingMirrorRows(this.sql, MIRROR_RETRY_BATCH);
    for (const row of pending) {
      try {
        await mirrorMessageToD1(this.env, {
          id: row.id,
          roomId,
          userId: row.user_id,
          body: row.body,
          parentId: row.parent_id,
          createdAt: row.created_at,
          editedAt: row.edited_at,
          deletedAt: row.deleted_at,
        });
        clearPendingMirror(this.sql, row.id);
      } catch (err) {
        console.warn("[chatroom] alarm mirror retry failed", { id: row.id, err: String(err) });
        // Leave pending_mirror=1; next alarm will retry.
        return;
      }
    }
  }
}
