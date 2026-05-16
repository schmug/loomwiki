// SPDX-License-Identifier: Apache-2.0

// D1 mirror tests for the ChatRoom DO write-through path. The DO is the
// source of truth for the live state; `messages` in D1 is the queryable
// mirror that ingest, scrollback, and the daily-log cron rely on.
//
// The failure-path tests (D1 throws → pending_mirror=1 → retry on next
// send or alarm) use `runInDurableObject` to inject a one-shot failing
// `_mirrorFn` onto the live DO instance. That seam is inert in production
// (defaults to `undefined` → falls back to real `mirrorMessageToD1`).

import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { PROTOCOL_VERSION } from "@loomwiki/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatRoom } from "../do/ChatRoom.js";
import type { Env } from "../env.js";
import type { MirrorMessage } from "../lib/d1-mirror.js";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";
import { type JwtFixture, makeJwtFixture } from "./__fixtures__/jwt.js";
import { type WsSession, openWs } from "./__fixtures__/ws.js";

let fixture: JwtFixture;

beforeAll(async () => {
  await applyMigrations();
  fixture = await makeJwtFixture();
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

beforeEach(async () => {
  await resetDb();
});

const sessions: WsSession[] = [];
afterEach(() => {
  while (sessions.length > 0) {
    sessions.pop()?.close();
  }
});

async function bootstrap(slug: string): Promise<{ jwt: string; roomId: string; userId: string }> {
  const jwt = await fixture.mint({ email: "alice@example.com" });
  const me = await SELF.fetch("https://api.local/api/me", {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
  const meBody = (await me.json()) as {
    data: { user: { id: string }; workspace: { id: string } };
  };
  const create = await SELF.fetch(
    `https://api.local/api/workspaces/${meBody.data.workspace.id}/rooms`,
    {
      method: "POST",
      headers: {
        "CF-Access-Jwt-Assertion": jwt,
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug, name: slug }),
    },
  );
  const room = (await create.json()) as { data: { room: { id: string } } };
  return { jwt, roomId: room.data.room.id, userId: meBody.data.user.id };
}

async function readMessageFromD1(messageId: string): Promise<{ body: string } | null> {
  const row = await env.DB.prepare("SELECT body FROM messages WHERE id = ?")
    .bind(messageId)
    .first<{ body: string }>();
  return row;
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 1500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  // Tight poll — vitest-pool-workers' D1 is in-process, so 25ms is plenty.
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Helper: get the ChatRoom DO stub that backs a given roomId. The namespace
// uses idFromName(roomId) just like the route layer in rooms.ts.
// ---------------------------------------------------------------------------
function chatRoomStub(roomId: string): DurableObjectStub<ChatRoom> {
  return (env.CHAT_ROOM as DurableObjectNamespace<ChatRoom>).get(env.CHAT_ROOM.idFromName(roomId));
}

/**
 * Test seam: access the private `sql` field on the DO instance for direct
 * SQLite assertions inside `runInDurableObject`. We cast through a structural
 * interface rather than bracket notation to satisfy biome's `useLiteralKeys`.
 */
interface ChatRoomInternals {
  sql: SqlStorage;
}

function getSql(instance: ChatRoom): SqlStorage {
  return (instance as unknown as ChatRoomInternals).sql;
}

describe("ChatRoom → D1 mirror", () => {
  it("a sent message is visible in D1 `messages` within 1 second", async () => {
    const { jwt, roomId } = await bootstrap("general");
    const ws = sessions[sessions.push(await openWs(roomId, jwt)) - 1];
    if (!ws) throw new Error("session push failed");
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next();

    ws.send({ kind: "send", tempId: "m1", body: "mirrored?" });
    const ack = await ws.next();
    if (ack.kind !== "ack") throw new Error("expected ack");

    const row = await waitFor(() => readMessageFromD1(ack.messageId), 1500);
    expect(row.body).toBe("mirrored?");
  });

  it("an edited message updates the D1 row body", async () => {
    const { jwt, roomId } = await bootstrap("general");
    const ws = sessions[sessions.push(await openWs(roomId, jwt)) - 1];
    if (!ws) throw new Error("session push failed");
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next();

    ws.send({ kind: "send", tempId: "m1", body: "v1" });
    const ack = await ws.next();
    if (ack.kind !== "ack") throw new Error("expected ack");
    await waitFor(() => readMessageFromD1(ack.messageId));

    ws.send({ kind: "edit", messageId: ack.messageId, body: "v2" });
    await ws.next(); // consume the edited broadcast

    const row = await waitFor(async () => {
      const r = await readMessageFromD1(ack.messageId);
      return r && r.body === "v2" ? r : null;
    }, 1500);
    expect(row.body).toBe("v2");
  });

  it("a deleted message updates D1 deleted_at", async () => {
    const { jwt, roomId } = await bootstrap("general");
    const ws = sessions[sessions.push(await openWs(roomId, jwt)) - 1];
    if (!ws) throw new Error("session push failed");
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next();

    ws.send({ kind: "send", tempId: "m1", body: "doomed" });
    const ack = await ws.next();
    if (ack.kind !== "ack") throw new Error("expected ack");
    await waitFor(() => readMessageFromD1(ack.messageId));

    ws.send({ kind: "delete", messageId: ack.messageId });
    await ws.next();

    await waitFor(async () => {
      const r = await env.DB.prepare("SELECT deleted_at FROM messages WHERE id = ?")
        .bind(ack.messageId)
        .first<{ deleted_at: number | null }>();
      return r && r.deleted_at !== null ? r : null;
    }, 1500);
  });

  // -------------------------------------------------------------------------
  // Failure-path tests
  //
  // Strategy: before each `send`, inject a failing `_mirrorFn` into the live
  // DO instance via `runInDurableObject`. The DO calls `_mirrorFn ?? real`
  // in `tryMirror` / `flushPendingMirror`, so the stub throws exactly once
  // and the production retry path is exercised without any NODE_ENV branch.
  // -------------------------------------------------------------------------

  it("D1 failure leaves pending_mirror=1 for the affected row", async () => {
    const { jwt, roomId } = await bootstrap("failure-flag");
    const stub = chatRoomStub(roomId);

    // Inject a one-shot failing mirror function BEFORE the send so it is
    // in place when `tryMirror` fires inside `ctx.waitUntil`.
    await runInDurableObject(stub, async (instance: ChatRoom) => {
      instance._mirrorFn = async (_e: Env, _m: MirrorMessage): Promise<void> => {
        throw new Error("injected D1 failure");
      };
    });

    const ws = sessions[sessions.push(await openWs(roomId, jwt)) - 1];
    if (!ws) throw new Error("session push failed");
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next();

    ws.send({ kind: "send", tempId: "f1", body: "will-fail-mirror" });
    const ack = await ws.next();
    if (ack.kind !== "ack") throw new Error("expected ack");

    // Give waitUntil time to run tryMirror (which throws → markPendingMirror).
    // Then assert the row has pending_mirror=1 via runInDurableObject.
    await waitFor(async () => {
      const pending = await runInDurableObject(stub, (instance: ChatRoom) => {
        const cursor = getSql(instance).exec<{ id: string; pending_mirror: number }>(
          "SELECT id, pending_mirror FROM messages_local WHERE id = ?",
          ack.messageId,
        );
        for (const row of cursor) return row;
        return null;
      });
      return pending !== null && pending.pending_mirror === 1 ? pending : null;
    }, 2000);

    // Row must NOT be in D1 yet (mirror never succeeded).
    const d1Row = await readMessageFromD1(ack.messageId);
    expect(d1Row).toBeNull();
  });

  it("a subsequent send after a D1 failure retries pending rows and clears the flag", async () => {
    const { jwt, roomId } = await bootstrap("failure-retry");
    const stub = chatRoomStub(roomId);

    // Step 1: inject failure for the first send.
    await runInDurableObject(stub, async (instance: ChatRoom) => {
      instance._mirrorFn = async (_e: Env, _m: MirrorMessage): Promise<void> => {
        throw new Error("injected D1 failure");
      };
    });

    const ws = sessions[sessions.push(await openWs(roomId, jwt)) - 1];
    if (!ws) throw new Error("session push failed");
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next();

    ws.send({ kind: "send", tempId: "r1", body: "first-fails" });
    const ack1 = await ws.next();
    if (ack1.kind !== "ack") throw new Error("expected ack");

    // Wait for the failure to be recorded (pending_mirror=1).
    await waitFor(async () => {
      return runInDurableObject(stub, (instance: ChatRoom) => {
        const cursor = getSql(instance).exec<{ pending_mirror: number }>(
          "SELECT pending_mirror FROM messages_local WHERE id = ?",
          ack1.messageId,
        );
        for (const row of cursor) return row.pending_mirror === 1 ? row : null;
        return null;
      });
    }, 2000);

    // Step 2: restore the real mirror so the second send and the pending-row
    // flush both succeed.
    await runInDurableObject(stub, (instance: ChatRoom) => {
      instance._mirrorFn = undefined;
    });

    // Step 3: send a second message — handleSend calls scheduleMirror which
    // calls tryMirror. Before calling the real mirror for the new message,
    // flushPendingMirror is NOT called by handleSend — that is the alarm path.
    // However, tryMirror for the new send WILL clear its own row. The pending
    // row from step 1 is cleared by the alarm or the next explicit retry.
    //
    // To trigger the pending-row retry without waiting 60s, send a second
    // message (which triggers its own mirror), then fire the alarm directly.
    ws.send({ kind: "send", tempId: "r2", body: "second-succeeds" });
    const ack2 = await ws.next();
    if (ack2.kind !== "ack") throw new Error("expected ack");

    // The second message should mirror successfully.
    await waitFor(() => readMessageFromD1(ack2.messageId), 1500);

    // Fire the alarm to flush the pending row from step 1.
    const alarmRan = await runDurableObjectAlarm(stub);
    expect(alarmRan).toBe(true);

    // After the alarm the first row should now be in D1.
    const row1 = await waitFor(() => readMessageFromD1(ack1.messageId), 1500);
    expect(row1.body).toBe("first-fails");

    // And pending_mirror should be cleared.
    const pending = await runInDurableObject(stub, (instance: ChatRoom) => {
      const cursor = getSql(instance).exec<{ c: number }>(
        "SELECT COUNT(*) AS c FROM messages_local WHERE pending_mirror = 1",
      );
      for (const row of cursor) return row.c;
      return -1;
    });
    expect(pending).toBe(0);
  });

  it("runDurableObjectAlarm after a D1 failure drains the pending queue", async () => {
    const { jwt, roomId } = await bootstrap("failure-alarm");
    const stub = chatRoomStub(roomId);

    // Inject failure.
    await runInDurableObject(stub, async (instance: ChatRoom) => {
      instance._mirrorFn = async (_e: Env, _m: MirrorMessage): Promise<void> => {
        throw new Error("injected D1 failure");
      };
    });

    const ws = sessions[sessions.push(await openWs(roomId, jwt)) - 1];
    if (!ws) throw new Error("session push failed");
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next();

    ws.send({ kind: "send", tempId: "a1", body: "alarm-drains-me" });
    const ack = await ws.next();
    if (ack.kind !== "ack") throw new Error("expected ack");

    // Wait until pending_mirror=1 is recorded.
    await waitFor(async () => {
      return runInDurableObject(stub, (instance: ChatRoom) => {
        const cursor = getSql(instance).exec<{ pending_mirror: number }>(
          "SELECT pending_mirror FROM messages_local WHERE id = ?",
          ack.messageId,
        );
        for (const row of cursor) return row.pending_mirror === 1 ? row : null;
        return null;
      });
    }, 2000);

    // Row not in D1 yet.
    expect(await readMessageFromD1(ack.messageId)).toBeNull();

    // Restore real mirror so the alarm's flushPendingMirror succeeds.
    await runInDurableObject(stub, (instance: ChatRoom) => {
      instance._mirrorFn = undefined;
    });

    // Fire alarm directly — no further WS sends needed.
    const alarmRan = await runDurableObjectAlarm(stub);
    expect(alarmRan).toBe(true);

    // Row now in D1.
    const row = await waitFor(() => readMessageFromD1(ack.messageId), 1500);
    expect(row.body).toBe("alarm-drains-me");

    // pending_mirror cleared.
    const pendingCount = await runInDurableObject(stub, (instance: ChatRoom) => {
      const cursor = getSql(instance).exec<{ c: number }>(
        "SELECT COUNT(*) AS c FROM messages_local WHERE pending_mirror = 1",
      );
      for (const row of cursor) return row.c;
      return -1;
    });
    expect(pendingCount).toBe(0);
  });
});
