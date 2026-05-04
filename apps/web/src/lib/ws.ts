// SPDX-License-Identifier: Apache-2.0

// Typed ChatRoom WebSocket client for the browser. Job: don't lose
// messages.
//
//   - Exponential reconnect with jitter (250ms → 30s).
//   - Heartbeat ping every 30s; force-close after 10s of no pong.
//   - Send queue buffers while disconnected; flushed on (re)open.
//   - On reconnect, sends `hello { sinceMessageId: lastReceivedServerId }`
//     so the server replays only what we missed (UUIDv7 cursor — SPEC §9).
//   - Each enqueued send carries a stable client `tempId` so the eventual
//     `ack` can deduplicate against the optimistic-UI entry.
//
// Auth is the Cloudflare Access cookie set by the browser on the upgrade
// request — there is no header to attach, the WebSocket constructor sends
// cookies for same-origin URLs automatically.
//
// The `WebSocketCtor` constructor parameter is a test seam: pass a fake to
// avoid relying on `globalThis.WebSocket` in unit tests.

import {
  type ClientMsg,
  PROTOCOL_VERSION,
  type ServerMsg,
  ServerMsgSchema,
} from "@loomwiki/shared";

export interface ChatClientOptions {
  url: string;
  /** Resume cursor on first connect — pass undefined for a fresh client. */
  initialSinceMessageId?: string;
  /** Override for tests. Defaults to `globalThis.WebSocket`. */
  WebSocketCtor?: typeof WebSocket;
  /** Test seam: schedule a callback. Defaults to `setTimeout`. */
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  /** Backoff knobs (defaults match SPEC + M2 prompt). */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  jitterFraction?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

export type ChatClientEvent =
  | { kind: "open" }
  | { kind: "close"; reason: string }
  | { kind: "server"; msg: ServerMsg }
  | { kind: "error"; error: Error };

export type ChatClientListener = (e: ChatClientEvent) => void;

interface QueuedSend {
  envelope: ClientMsg;
}

const DEFAULTS = {
  initialBackoffMs: 250,
  maxBackoffMs: 30_000,
  jitterFraction: 0.2,
  pingIntervalMs: 30_000,
  pongTimeoutMs: 10_000,
} as const;

// W3C WebSocket readyState constants. We reference these directly
// instead of `WebSocket.CONNECTING / .OPEN / etc.` so the client works
// in environments where `globalThis.WebSocket` is absent (Node, happy-dom
// in tests). The fake-WS test seam already mirrors these numeric values.
const WS_OPEN = 1;

export class ChatClient {
  private readonly opts: Required<
    Omit<ChatClientOptions, "initialSinceMessageId" | "WebSocketCtor" | "setTimer" | "clearTimer">
  > & {
    initialSinceMessageId?: string | undefined;
    WebSocketCtor: typeof WebSocket;
    setTimer: typeof setTimeout;
    clearTimer: typeof clearTimeout;
  };

  private socket: WebSocket | null = null;
  private listeners: Set<ChatClientListener> = new Set();
  private sendQueue: QueuedSend[] = [];
  private lastReceivedServerId: string | undefined;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private pongDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  constructor(options: ChatClientOptions) {
    this.opts = {
      url: options.url,
      initialSinceMessageId: options.initialSinceMessageId,
      WebSocketCtor: options.WebSocketCtor ?? globalThis.WebSocket,
      setTimer: options.setTimer ?? setTimeout,
      clearTimer: options.clearTimer ?? clearTimeout,
      initialBackoffMs: options.initialBackoffMs ?? DEFAULTS.initialBackoffMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
      jitterFraction: options.jitterFraction ?? DEFAULTS.jitterFraction,
      pingIntervalMs: options.pingIntervalMs ?? DEFAULTS.pingIntervalMs,
      pongTimeoutMs: options.pongTimeoutMs ?? DEFAULTS.pongTimeoutMs,
    };
    if (options.initialSinceMessageId !== undefined) {
      this.lastReceivedServerId = options.initialSinceMessageId;
    }
  }

  on(listener: ChatClientListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Idempotent. Opens a socket if one is not already open or opening. */
  connect(): void {
    if (this.socket && this.socket.readyState <= WS_OPEN) return;
    this.closedByUser = false;
    this.openSocket();
  }

  /** Closes permanently — no reconnect. */
  close(): void {
    this.closedByUser = true;
    this.cancelReconnect();
    this.cancelPingTimers();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // already closed
      }
    }
  }

  /**
   * Send a `send` envelope. Buffered if not currently connected; flushed
   * on (re)connect. Caller supplies a `tempId` so optimistic UI can
   * reconcile against the eventual `ack`.
   */
  sendMessage(tempId: string, body: string, parentId?: string): void {
    const envelope: ClientMsg =
      parentId !== undefined
        ? { kind: "send", tempId, body, parentId }
        : { kind: "send", tempId, body };
    this.enqueue(envelope);
  }

  edit(messageId: string, body: string): void {
    this.enqueue({ kind: "edit", messageId, body });
  }

  delete(messageId: string): void {
    this.enqueue({ kind: "delete", messageId });
  }

  /** Inspect-only — used by tests to assert on flush behavior. */
  pendingSendCount(): number {
    return this.sendQueue.length;
  }

  // ---------- internals ----------

  private enqueue(envelope: ClientMsg): void {
    this.sendQueue.push({ envelope });
    this.flushQueue();
  }

  private flushQueue(): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    while (this.sendQueue.length > 0) {
      const head = this.sendQueue[0];
      if (!head) break;
      try {
        this.socket.send(JSON.stringify(head.envelope));
        this.sendQueue.shift();
      } catch {
        // Send raised — leave in queue, the close handler will trigger
        // reconnect, and the next open will flush again.
        return;
      }
    }
  }

  private openSocket(): void {
    let socket: WebSocket;
    try {
      socket = new this.opts.WebSocketCtor(this.opts.url);
    } catch (err) {
      this.emitError(err);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => this.handleOpen());
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", (event) => this.handleClose(event));
    socket.addEventListener("error", () => {
      // The WebSocket spec emits a generic Event on error; close follows.
      // We only emit a typed error if we actually have one (handled in
      // openSocket's try/catch and in handleClose's reason).
    });
  }

  private handleOpen(): void {
    this.reconnectAttempts = 0;
    this.cancelReconnect();

    // First frame is always `hello` so the server can resume from our
    // cursor. We send it directly (not via the queue) so a stuffed queue
    // can't push a `send` in front of `hello`.
    const hello: ClientMsg =
      this.lastReceivedServerId !== undefined
        ? {
            kind: "hello",
            protocolVersion: PROTOCOL_VERSION,
            sinceMessageId: this.lastReceivedServerId,
          }
        : { kind: "hello", protocolVersion: PROTOCOL_VERSION };
    try {
      this.socket?.send(JSON.stringify(hello));
    } catch (err) {
      this.emitError(err);
      return;
    }

    this.flushQueue();
    this.startPing();
    this.emit({ kind: "open" });
  }

  private handleMessage(event: MessageEvent): void {
    const raw = typeof event.data === "string" ? event.data : "";
    let parsed: ServerMsg;
    try {
      const json: unknown = JSON.parse(raw);
      const result = ServerMsgSchema.safeParse(json);
      if (!result.success) {
        this.emitError(new Error("malformed server envelope"));
        return;
      }
      parsed = result.data;
    } catch {
      this.emitError(new Error("non-JSON server frame"));
      return;
    }

    if (parsed.kind === "pong") {
      this.handlePong();
      // Don't surface pong to listeners — it's heartbeat plumbing.
      return;
    }

    if (parsed.kind === "welcome") {
      const last = parsed.recentMessages[parsed.recentMessages.length - 1];
      if (last) this.lastReceivedServerId = last.id;
    } else if (parsed.kind === "message") {
      this.lastReceivedServerId = parsed.message.id;
    } else if (parsed.kind === "ack") {
      this.lastReceivedServerId = parsed.messageId;
    }

    this.emit({ kind: "server", msg: parsed });
  }

  private handleClose(event: CloseEvent): void {
    this.cancelPingTimers();
    this.socket = null;
    this.emit({ kind: "close", reason: event.reason || `code=${event.code}` });
    if (!this.closedByUser) this.scheduleReconnect();
  }

  // Heartbeat: ping every interval; force-close if no pong inside deadline.
  private startPing(): void {
    this.cancelPingTimers();
    this.pingTimer = this.opts.setTimer(() => this.sendPing(), this.opts.pingIntervalMs);
  }

  private sendPing(): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    try {
      this.socket.send(JSON.stringify({ kind: "ping" } satisfies ClientMsg));
    } catch (err) {
      this.emitError(err);
      return;
    }
    this.pongDeadlineTimer = this.opts.setTimer(
      () => this.handlePongTimeout(),
      this.opts.pongTimeoutMs,
    );
  }

  private handlePongTimeout(): void {
    if (this.socket) {
      try {
        this.socket.close(4000, "pong timeout");
      } catch {
        // ignore
      }
    }
    // close handler runs scheduleReconnect for us.
  }

  private cancelPingTimers(): void {
    if (this.pingTimer) {
      this.opts.clearTimer(this.pingTimer);
      this.pingTimer = null;
    }
    this.cancelPongDeadline();
  }

  private cancelPongDeadline(): void {
    if (this.pongDeadlineTimer) {
      this.opts.clearTimer(this.pongDeadlineTimer);
      this.pongDeadlineTimer = null;
    }
  }

  /**
   * Pong received: clear the deadline timer and schedule the next ping.
   * Split from `cancelPongDeadline` so socket-close paths can clean up the
   * pong timer without spuriously scheduling another ping on a dead socket
   * (every reconnect would otherwise leak a timer ref).
   */
  private handlePong(): void {
    this.cancelPongDeadline();
    if (this.pingTimer) {
      this.opts.clearTimer(this.pingTimer);
    }
    this.pingTimer = this.opts.setTimer(() => this.sendPing(), this.opts.pingIntervalMs);
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    this.cancelReconnect();
    const delay = this.computeBackoff(this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = this.opts.setTimer(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      this.opts.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private computeBackoff(attempt: number): number {
    const base = Math.min(this.opts.initialBackoffMs * 2 ** attempt, this.opts.maxBackoffMs);
    const jitterAmp = base * this.opts.jitterFraction;
    const jitter = (Math.random() * 2 - 1) * jitterAmp;
    return Math.max(0, base + jitter);
  }

  private emit(event: ChatClientEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[ChatClient] listener threw", err);
      }
    }
  }

  private emitError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.emit({ kind: "error", error });
  }
}
