// SPDX-License-Identifier: Apache-2.0

// Room-scoped routes:
//
//   GET  /:rid             — room metadata (M1)
//   GET  /:rid/messages    — historical scrollback from D1 (M2)
//   GET  /:rid/ws          — WebSocket upgrade → ChatRoom DO (M2)
//
// Auth + membership are verified once per request here. The DO trusts the
// upgrade because the route layer has already validated `workspace_id`,
// room existence, and room_members. Any caller that wants to forge identity
// must defeat the Hono auth middleware first.

import { type Message, parseMessageRow, parseRoomRow } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, type WireMessage, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import type { Env } from "../env.js";
import { serializeRoom } from "../lib/serialize.js";
import type { AuthEnv } from "../middleware/auth.js";

const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

function messageToWire(m: Message): WireMessage {
  // Tombstoned: blank body on the wire so a deleted message can never leak
  // via the historical scrollback route. D1 retains the body for any future
  // hard-erase / GDPR path.
  return {
    id: m.id,
    room_id: m.room_id,
    user_id: m.user_id,
    body: m.deleted_at !== null ? "" : m.body,
    parent_id: m.parent_id,
    created_at: m.created_at,
    edited_at: m.edited_at,
    deleted_at: m.deleted_at,
  };
}

async function loadMemberRoom(
  env: Env,
  userId: string,
  workspaceId: string,
  rid: string,
): Promise<void> {
  const row = await env.DB.prepare("SELECT * FROM rooms WHERE id = ?").bind(rid).first();
  if (!row) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Room not found", { status: 404 });
  }
  const room = parseRoomRow(row);
  if (room.workspace_id !== workspaceId) {
    // Cross-workspace defense in depth: 404, not 403, so we don't confirm
    // existence to a caller authenticated to a different workspace.
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Room not found", { status: 404 });
  }
  const member = await env.DB.prepare(
    "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1",
  )
    .bind(rid, userId)
    .first();
  if (!member) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Not a member of this room", { status: 403 });
  }
}

export const roomsRoute = new Hono<AuthEnv>()
  .get("/:rid", async (c) => {
    const rid = c.req.param("rid");

    const row = await c.env.DB.prepare("SELECT * FROM rooms WHERE id = ?").bind(rid).first();
    if (!row) {
      throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Room not found", { status: 404 });
    }
    const room = parseRoomRow(row);

    if (room.workspace_id !== c.var.workspace.id) {
      throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Room not found", { status: 404 });
    }

    const member = await c.env.DB.prepare(
      "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1",
    )
      .bind(rid, c.var.user.id)
      .first();
    if (!member) {
      throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Not a member of this room", { status: 403 });
    }

    return c.json(apiOk({ room: serializeRoom(room) }));
  })
  .get("/:rid/messages", async (c) => {
    const rid = c.req.param("rid");
    await loadMemberRoom(c.env, c.var.user.id, c.var.workspace.id, rid);

    const before = c.req.query("before");
    const limitRaw = c.req.query("limit");
    let limit = HISTORY_DEFAULT_LIMIT;
    if (limitRaw !== undefined) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "limit must be a positive integer", {
          status: 400,
        });
      }
      limit = Math.min(parsed, HISTORY_MAX_LIMIT);
    }

    // We fetch limit+1 so we can compute hasMore without a second query.
    const fetched = limit + 1;
    const rows = before
      ? await c.env.DB.prepare(
          "SELECT * FROM messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
        )
          .bind(rid, before, fetched)
          .all()
      : await c.env.DB.prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?")
          .bind(rid, fetched)
          .all();

    const parsed = rows.results.map(parseMessageRow);
    const hasMore = parsed.length > limit;
    const trimmed = hasMore ? parsed.slice(0, limit) : parsed;
    // Return oldest-first within the page so callers can append directly.
    trimmed.reverse();

    return c.json(apiOk({ messages: trimmed.map(messageToWire), hasMore }));
  })
  .get("/:rid/ws", async (c) => {
    const rid = c.req.param("rid");
    if (c.req.header("Upgrade") !== "websocket") {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "expected websocket upgrade", {
        status: 426,
      });
    }
    await loadMemberRoom(c.env, c.var.user.id, c.var.workspace.id, rid);

    const stubId = c.env.CHAT_ROOM.idFromName(rid);
    const stub = c.env.CHAT_ROOM.get(stubId);

    // Forward to the DO with identity headers. Source headers are immutable;
    // we synthesize a fresh Request with the originals + the trusted
    // identity bound from auth middleware. The DO will refuse the upgrade
    // if these are missing.
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-loomwiki-user-id", c.var.user.id);
    headers.set("x-loomwiki-room-id", rid);
    const forwarded = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
    });

    return stub.fetch(forwarded);
  });
