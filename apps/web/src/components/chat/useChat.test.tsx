// SPDX-License-Identifier: Apache-2.0

// useChat behavior tests. Exercises the hook against a fake ChatClient
// that lets the test drive open/close/server events directly. We do
// NOT exercise the real ChatClient here — that's covered in
// apps/web/src/lib/ws.test.ts. This file pins the React-state behavior
// useChat layers on top.

import type { ChatClient, ChatClientEvent, ChatClientListener } from "@/lib/ws";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "./useChat";

class FakeChatClient {
  private listeners: Set<ChatClientListener> = new Set();
  sentMessages: { tempId: string; body: string; parentId?: string }[] = [];
  edits: { messageId: string; body: string }[] = [];
  deletes: string[] = [];
  closed = false;

  on(l: ChatClientListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  connect(): void {
    /* no-op; tests drive open via simulateOpen() */
  }
  close(): void {
    this.closed = true;
  }
  sendMessage(tempId: string, body: string, parentId?: string): void {
    this.sentMessages.push(parentId ? { tempId, body, parentId } : { tempId, body });
  }
  edit(messageId: string, body: string): void {
    this.edits.push({ messageId, body });
  }
  delete(messageId: string): void {
    this.deletes.push(messageId);
  }
  pendingSendCount(): number {
    return 0;
  }

  simulate(event: ChatClientEvent): void {
    for (const l of this.listeners) l(event);
  }
}

const ROOM_ID = "01900000-0000-7000-8000-000000000001";
const USER_ID = "01900000-0000-7000-8000-0000000000aa";

function makeWire(
  overrides: Partial<{ id: string; user_id: string; body: string; created_at: number }> = {},
) {
  return {
    id: overrides.id ?? "01900000-0000-7000-8000-000000000010",
    room_id: ROOM_ID,
    user_id: overrides.user_id ?? "01900000-0000-7000-8000-0000000000bb",
    body: overrides.body ?? "hello",
    parent_id: null,
    created_at: overrides.created_at ?? 1_700_000_000,
    edited_at: null,
    deleted_at: null,
  };
}

function setupHook(opts?: {
  loadOlderFromApi?: (
    rid: string,
    before: string,
  ) => Promise<{ messages: ReturnType<typeof makeWire>[]; hasMore: boolean }>;
}) {
  const fake = new FakeChatClient();
  const result = renderHook(() =>
    useChat({
      roomId: ROOM_ID,
      currentUserId: USER_ID,
      createClient: () => fake as unknown as ChatClient,
      ...(opts?.loadOlderFromApi !== undefined ? { loadOlderFromApi: opts.loadOlderFromApi } : {}),
    }),
  );
  return { fake, result };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("useChat — connection lifecycle", () => {
  it("transitions connecting → connected on open and back to reconnecting on close", () => {
    const { fake, result } = setupHook();
    expect(result.result.current.status).toBe("connecting");

    act(() => fake.simulate({ kind: "open" }));
    expect(result.result.current.status).toBe("connected");

    act(() => fake.simulate({ kind: "close", reason: "test" }));
    expect(result.result.current.status).toBe("reconnecting");
  });

  it("populates messages and hasOlderHistory from welcome", () => {
    const { fake, result } = setupHook();
    act(() =>
      fake.simulate({
        kind: "server",
        msg: {
          kind: "welcome",
          protocolVersion: 1,
          roomId: ROOM_ID,
          recentMessages: [makeWire({ id: "01900000-0000-7000-8000-000000000a01", body: "hi" })],
          hasMore: true,
        },
      }),
    );
    expect(result.result.current.messages).toHaveLength(1);
    expect(result.result.current.messages[0]?.body).toBe("hi");
    expect(result.result.current.hasOlderHistory).toBe(true);
  });

  it("appends new server messages", () => {
    const { fake, result } = setupHook();
    act(() =>
      fake.simulate({
        kind: "server",
        msg: {
          kind: "message",
          message: makeWire({ id: "01900000-0000-7000-8000-000000000a02", body: "yo" }),
        },
      }),
    );
    expect(result.result.current.messages).toHaveLength(1);
    expect(result.result.current.messages[0]?.body).toBe("yo");
  });
});

describe("useChat — optimistic send + ack", () => {
  it("appends an optimistic message on send and calls fake.sendMessage", () => {
    const { fake, result } = setupHook();
    let tempId = "";
    act(() => {
      tempId = result.result.current.send("hello");
    });
    expect(result.result.current.messages).toHaveLength(1);
    expect(result.result.current.messages[0]?.body).toBe("hello");
    expect(result.result.current.messages[0]?.deliveryStatus).toBe("sending");
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]?.tempId).toBe(tempId);
  });

  it("reconciles optimistic entry by tempId on ack", () => {
    const { fake, result } = setupHook();
    let tempId = "";
    act(() => {
      tempId = result.result.current.send("hello");
    });
    const realId = "01900000-0000-7000-8000-000000000a99";
    act(() =>
      fake.simulate({
        kind: "server",
        msg: { kind: "ack", tempId, messageId: realId },
      }),
    );
    expect(result.result.current.messages).toHaveLength(1);
    expect(result.result.current.messages[0]?.id).toBe(realId);
    expect(result.result.current.messages[0]?.deliveryStatus).toBe("delivered");
  });

  it("marks entry as failed when no ack arrives within the timeout", () => {
    const { result } = setupHook();
    act(() => {
      result.result.current.send("hello");
    });
    expect(result.result.current.messages[0]?.deliveryStatus).toBe("sending");
    act(() => {
      vi.advanceTimersByTime(5_001);
    });
    expect(result.result.current.messages[0]?.deliveryStatus).toBe("failed");
  });

  it("marks entry as failed and surfaces error on a server error envelope echoing tempId", () => {
    const { fake, result } = setupHook();
    let tempId = "";
    act(() => {
      tempId = result.result.current.send("hello");
    });
    act(() =>
      fake.simulate({
        kind: "server",
        msg: { kind: "error", code: "RATE_LIMITED", message: "slow down", tempId },
      }),
    );
    expect(result.result.current.messages[0]?.deliveryStatus).toBe("failed");
    expect(result.result.current.lastError?.message).toContain("RATE_LIMITED");
  });
});

describe("useChat — edit / delete", () => {
  it("applies an `edited` server event to the matching message", () => {
    const { fake, result } = setupHook();
    const msg = makeWire({ id: "01900000-0000-7000-8000-000000000a03", body: "old" });
    act(() => fake.simulate({ kind: "server", msg: { kind: "message", message: msg } }));

    act(() =>
      fake.simulate({
        kind: "server",
        msg: { kind: "edited", messageId: msg.id, body: "new", editedAt: 1_700_000_001 },
      }),
    );
    expect(result.result.current.messages[0]?.body).toBe("new");
    expect(result.result.current.messages[0]?.edited_at).toBe(1_700_000_001);
  });

  it("tombstones a message on `deleted` (body cleared, deleted_at set)", () => {
    const { fake, result } = setupHook();
    const msg = makeWire({ id: "01900000-0000-7000-8000-000000000a04", body: "secret" });
    act(() => fake.simulate({ kind: "server", msg: { kind: "message", message: msg } }));

    act(() =>
      fake.simulate({
        kind: "server",
        msg: { kind: "deleted", messageId: msg.id, deletedAt: 1_700_000_002 },
      }),
    );
    expect(result.result.current.messages[0]?.body).toBe("");
    expect(result.result.current.messages[0]?.deleted_at).toBe(1_700_000_002);
  });

  it("forwards edit() and remove() to the underlying client", () => {
    const { fake, result } = setupHook();
    act(() => result.result.current.edit("01900000-0000-7000-8000-000000000a05", "v2"));
    act(() => result.result.current.remove("01900000-0000-7000-8000-000000000a06"));
    expect(fake.edits).toEqual([{ messageId: "01900000-0000-7000-8000-000000000a05", body: "v2" }]);
    expect(fake.deletes).toEqual(["01900000-0000-7000-8000-000000000a06"]);
  });
});

describe("useChat — loadOlder", () => {
  it("prepends older messages and updates hasOlderHistory", async () => {
    const oldMsg = makeWire({
      id: "01900000-0000-7000-8000-0000000000ff",
      body: "ancient",
      created_at: 1_600_000_000,
    });
    const fakeFetch = vi.fn().mockResolvedValue({ messages: [oldMsg], hasMore: false });

    const { fake, result } = setupHook({ loadOlderFromApi: fakeFetch });

    // Seed with one delivered message + hasOlderHistory=true.
    act(() =>
      fake.simulate({
        kind: "server",
        msg: {
          kind: "welcome",
          protocolVersion: 1,
          roomId: ROOM_ID,
          recentMessages: [makeWire({ id: "01900000-0000-7000-8000-000000000abc", body: "now" })],
          hasMore: true,
        },
      }),
    );
    expect(result.result.current.hasOlderHistory).toBe(true);

    await act(async () => {
      await result.result.current.loadOlder();
    });

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(result.result.current.messages).toHaveLength(2);
    expect(result.result.current.messages[0]?.body).toBe("ancient");
    expect(result.result.current.hasOlderHistory).toBe(false);
  });
});

describe("useChat — malformed events do not crash", () => {
  it("surfaces a parse error and stays alive for subsequent sends", () => {
    const { fake, result } = setupHook();
    act(() => fake.simulate({ kind: "error", error: new Error("malformed") }));
    expect(result.result.current.lastError?.message).toBe("malformed");
    // Hook is still alive: a subsequent send goes through.
    act(() => {
      result.result.current.send("alive");
    });
    expect(result.result.current.messages).toHaveLength(1);
  });
});
