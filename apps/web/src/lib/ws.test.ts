// SPDX-License-Identifier: Apache-2.0

import { PROTOCOL_VERSION, type ServerMsg } from "@loomwiki/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatClient, type ChatClientEvent, type ChatClientOptions } from "./ws.js";

// ----- Fake WebSocket -----
// Implements just enough of the DOM WebSocket interface to drive
// ChatClient. Each instance lives until the test calls `.simulateClose()`.

const READY = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

interface FakeListener {
  type: string;
  fn: (event: unknown) => void;
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = READY.CONNECTING;
  static OPEN = READY.OPEN;
  static CLOSING = READY.CLOSING;
  static CLOSED = READY.CLOSED;

  url: string;
  readyState: number = READY.CONNECTING;
  sent: string[] = [];
  private listeners: FakeListener[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.push({ type, fn });
  }

  send(data: string): void {
    if (this.readyState !== READY.OPEN) throw new Error("not open");
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === READY.CLOSED) return;
    this.readyState = READY.CLOSED;
    this.dispatch("close", { code, reason });
  }

  // ----- test driver -----
  simulateOpen(): void {
    this.readyState = READY.OPEN;
    this.dispatch("open", {});
  }

  simulateMessage(envelope: ServerMsg): void {
    this.dispatch("message", { data: JSON.stringify(envelope) });
  }

  simulateRawMessage(data: string): void {
    this.dispatch("message", { data });
  }

  simulateClose(reason = "remote close", code = 1006): void {
    if (this.readyState === READY.CLOSED) return;
    this.readyState = READY.CLOSED;
    this.dispatch("close", { code, reason });
  }

  private dispatch(type: string, event: unknown): void {
    for (const l of this.listeners) {
      if (l.type === type) l.fn(event);
    }
  }
}

// Cast the fake to satisfy `typeof WebSocket` — runtime shape is what
// matters; ChatClient only touches `new`, `send`, `close`, `readyState`,
// `addEventListener` and the static `OPEN`.
function ctor(): typeof WebSocket {
  return FakeWebSocket as unknown as typeof WebSocket;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  // Math.random is used for jitter; pin it so backoff is deterministic.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function lastInstance(): FakeWebSocket {
  const last = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!last) throw new Error("no fake WebSocket instances yet");
  return last;
}

function newClient(extras: Partial<ChatClientOptions> = {}) {
  return new ChatClient({
    url: "wss://api.local/api/rooms/r1/ws",
    WebSocketCtor: ctor(),
    setTimer: globalThis.setTimeout,
    clearTimer: globalThis.clearTimeout,
    ...extras,
  });
}

describe("ChatClient — happy path", () => {
  it("sends `hello` (with PROTOCOL_VERSION) as the first frame on open", () => {
    const client = newClient();
    client.connect();
    const ws = lastInstance();
    ws.simulateOpen();

    expect(ws.sent).toHaveLength(1);
    const sent = JSON.parse(ws.sent[0] ?? "{}");
    expect(sent).toMatchObject({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(sent.sinceMessageId).toBeUndefined();
  });

  it("includes sinceMessageId on hello when initialSinceMessageId is set", () => {
    const client = newClient({ initialSinceMessageId: "0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa" });
    client.connect();
    const ws = lastInstance();
    ws.simulateOpen();
    const sent = JSON.parse(ws.sent[0] ?? "{}");
    expect(sent.sinceMessageId).toBe("0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa");
  });

  it("emits server events for typed envelopes and tracks lastReceivedServerId", () => {
    const client = newClient();
    const seen: ChatClientEvent[] = [];
    client.on((e) => seen.push(e));
    client.connect();
    const ws = lastInstance();
    ws.simulateOpen();

    const messageId = "0190b0a4-7b2e-7eee-8aaa-bbbbbbbbbbbb";
    ws.simulateMessage({
      kind: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      roomId: "0190b0a4-7b2e-7eee-8aaa-cccccccccccc",
      recentMessages: [],
    });
    ws.simulateMessage({
      kind: "message",
      message: {
        id: messageId,
        room_id: "0190b0a4-7b2e-7eee-8aaa-cccccccccccc",
        user_id: "0190b0a4-7b2e-7eee-8aaa-dddddddddddd",
        body: "hi",
        parent_id: null,
        created_at: 1,
        edited_at: null,
        deleted_at: null,
      },
    });

    const serverEvents = seen.filter((e) => e.kind === "server");
    expect(serverEvents.map((e) => (e.kind === "server" ? e.msg.kind : null))).toEqual([
      "welcome",
      "message",
    ]);

    // Reconnect: lastReceivedServerId should be carried into hello.
    ws.simulateClose();
    vi.advanceTimersByTime(2000);
    const ws2 = lastInstance();
    expect(ws2).not.toBe(ws);
    ws2.simulateOpen();
    const helloSent = JSON.parse(ws2.sent[0] ?? "{}");
    expect(helloSent.sinceMessageId).toBe(messageId);
  });
});

describe("ChatClient — send queue", () => {
  it("buffers sends issued before the socket opens, then flushes on open", () => {
    const client = newClient();
    client.sendMessage("t1", "hi");
    client.sendMessage("t2", "again");
    expect(client.pendingSendCount()).toBe(2);

    client.connect();
    const ws = lastInstance();
    expect(ws.sent).toHaveLength(0);
    ws.simulateOpen();

    // First sent frame is `hello`, then the two queued sends.
    expect(ws.sent.length).toBe(3);
    expect(JSON.parse(ws.sent[0] ?? "{}").kind).toBe("hello");
    expect(JSON.parse(ws.sent[1] ?? "{}")).toMatchObject({ kind: "send", tempId: "t1" });
    expect(JSON.parse(ws.sent[2] ?? "{}")).toMatchObject({ kind: "send", tempId: "t2" });
    expect(client.pendingSendCount()).toBe(0);
  });

  it("re-buffers + replays sends across a reconnect", () => {
    const client = newClient();
    client.connect();
    const ws = lastInstance();
    ws.simulateOpen();

    ws.simulateClose();
    expect(client.pendingSendCount()).toBe(0);

    // Queue a send while disconnected.
    client.sendMessage("t-mid", "while-disconnected");
    expect(client.pendingSendCount()).toBe(1);

    vi.advanceTimersByTime(2000);
    const ws2 = lastInstance();
    expect(ws2).not.toBe(ws);
    ws2.simulateOpen();

    expect(client.pendingSendCount()).toBe(0);
    const allSent = ws2.sent.map((s) => JSON.parse(s));
    expect(allSent[0]).toMatchObject({ kind: "hello" });
    expect(allSent[1]).toMatchObject({ kind: "send", tempId: "t-mid" });
  });
});

describe("ChatClient — heartbeat & reconnect", () => {
  it("sends a `ping` after pingIntervalMs and tolerates a `pong` reply", () => {
    const client = newClient({ pingIntervalMs: 1000, pongTimeoutMs: 500 });
    client.connect();
    const ws = lastInstance();
    ws.simulateOpen();

    vi.advanceTimersByTime(1000);
    const pingFrame = ws.sent[ws.sent.length - 1];
    expect(JSON.parse(pingFrame ?? "{}")).toEqual({ kind: "ping" });

    ws.simulateMessage({ kind: "pong" });
    // pong drained; next ping schedules in another 1000ms.
    vi.advanceTimersByTime(1000);
    const next = ws.sent[ws.sent.length - 1];
    expect(JSON.parse(next ?? "{}")).toEqual({ kind: "ping" });
  });

  it("force-closes when `pong` does not arrive within pongTimeoutMs", () => {
    const client = newClient({ pingIntervalMs: 1000, pongTimeoutMs: 500 });
    client.connect();
    const ws = lastInstance();
    ws.simulateOpen();

    vi.advanceTimersByTime(1000);
    expect(ws.readyState).toBe(READY.OPEN);
    vi.advanceTimersByTime(600);
    expect(ws.readyState).toBe(READY.CLOSED);
  });

  it("does NOT reconnect after `client.close()`", () => {
    const client = newClient();
    client.connect();
    const ws = lastInstance();
    ws.simulateOpen();

    client.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });
});

describe("ChatClient — malformed server frames", () => {
  it("emits error events for non-JSON and shape-invalid frames but stays connected", () => {
    const client = newClient();
    const seen: ChatClientEvent[] = [];
    client.on((e) => seen.push(e));
    client.connect();
    const ws = lastInstance();
    ws.simulateOpen();

    ws.simulateRawMessage("not-json{");
    ws.simulateRawMessage(JSON.stringify({ kind: "made-up-envelope" }));

    const errs = seen.filter((e) => e.kind === "error");
    expect(errs.length).toBe(2);
    expect(ws.readyState).toBe(READY.OPEN);
  });
});
