// SPDX-License-Identifier: Apache-2.0

// blockConcurrencyWhile insert+ack atomicity tests (SPEC §9).
//
// Kept in a separate file from chat-room.test.ts because importing
// `runInDurableObject` causes the DO namespace to add per-call overhead
// that makes the timing-sensitive rate-limit test in chat-room.test.ts
// flaky. Isolation ensures both suites run correctly.
//
// The `localMessageCount` seam is only reachable via runInDurableObject —
// never over HTTP/WS.

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { PROTOCOL_VERSION } from "@loomwiki/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatRoom } from "../do/ChatRoom.js";
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

const openSessions: WsSession[] = [];
afterEach(() => {
  while (openSessions.length > 0) {
    const s = openSessions.pop();
    s?.close();
  }
});

async function bootstrap(
  email: string,
  slug: string,
): Promise<{ jwt: string; roomId: string; userId: string }> {
  const jwt = await fixture.mint({ email });
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

describe("blockConcurrencyWhile insert+ack atomicity (SPEC §9)", () => {
  // SPEC §9 acceptance criterion: "killing the DO mid-write does not lose
  // acknowledged messages". The Cloudflare docs state that SQL writes inside
  // blockConcurrencyWhile are rolled back when the callback throws. However,
  // vitest-pool-workers (workerd) does not emulate this rollback — the DO is
  // marked inputGateBroken but rows persist. Skip until workerd implements the
  // rollback contract; the positive invariant below covers production safety.
  it.skip("blockConcurrencyWhile rolls back SQLite INSERT when callback throws", () => {
    // If workerd ever ships rollback support, implement this test by calling a
    // seam method that inserts then throws inside blockConcurrencyWhile and
    // verifies the row count remains 0 after the throw.
  });

  it("successful insert+ack pair: ack reaches client and row is durable", async () => {
    // The inverse invariant: if an ack is delivered, the row must exist in
    // the DO's local SQLite. The pair must never decouple — no ack without a
    // row, and no row without an eventual ack.
    const { jwt, roomId } = await bootstrap("alice@example.com", "atomicity-b");
    const ws = openSessions[openSessions.push(await openWs(roomId, jwt)) - 1];
    if (!ws) throw new Error("session push failed");
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next(); // welcome

    ws.send({ kind: "send", tempId: "persist-test", body: "durable message" });
    const ack = await ws.next();
    expect(ack.kind).toBe("ack");
    if (ack.kind !== "ack") throw new Error("unreachable");
    expect(ack.tempId).toBe("persist-test");

    // Ack delivery guarantees the row is durable in the DO's local SQLite.
    const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId)) as DurableObjectStub<ChatRoom>;
    const count = await runInDurableObject(stub, (instance: ChatRoom) =>
      instance.localMessageCount(),
    );
    expect(count).toBe(1);
  });
});
