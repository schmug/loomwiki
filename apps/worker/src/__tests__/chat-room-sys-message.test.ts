// SPDX-License-Identifier: Apache-2.0

// Miniflare-backed WS-protocol test for the ChatRoom DO /_sys/message
// broadcast path. Closes the coverage gap identified in issue #51: PR #39
// shipped REST/tick coverage but no test asserting that live WebSocket
// clients receive the broadcast frame emitted by broadcastAll().
//
// Tests here are kept separate from chat-room.test.ts to avoid entangling
// with the timing-sensitive rate-limit test in that file.

import { SELF, env } from "cloudflare:test";
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

const sessions: WsSession[] = [];
afterEach(() => {
  while (sessions.length > 0) {
    sessions.pop()?.close();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RoomSetup {
  jwt: string;
  userId: string;
  roomId: string;
}

async function bootstrapMember(email: string, slug: string): Promise<RoomSetup> {
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
  return { jwt, userId: meBody.data.user.id, roomId: room.data.room.id };
}

async function joinAsMember(jwt: string, roomId: string): Promise<string> {
  const me = await SELF.fetch("https://api.local/api/me", {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
  const meBody = (await me.json()) as { data: { user: { id: string } } };
  await env.DB.prepare(
    "INSERT OR IGNORE INTO room_members (room_id, user_id, role) VALUES (?, ?, 'member')",
  )
    .bind(roomId, meBody.data.user.id)
    .run();
  return meBody.data.user.id;
}

/** Get the ChatRoom DO stub for a given roomId (mirrors the route layer). */
function chatRoomStub(roomId: string): DurableObjectStub<ChatRoom> {
  return (env.CHAT_ROOM as DurableObjectNamespace<ChatRoom>).get(env.CHAT_ROOM.idFromName(roomId));
}

/** Post a sys message directly to the DO stub. */
async function postSysMessage(
  roomId: string,
  payload: { userId: string; roomId: string; body: string; parentId?: string | null },
  headers: Record<string, string> = {},
): Promise<Response> {
  const stub = chatRoomStub(roomId);
  return stub.fetch(
    new Request(`https://do-internal/${roomId}/_sys/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-loomwiki-sys": "1",
        ...headers,
      },
      body: JSON.stringify(payload),
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatRoom DO — /_sys/message WS broadcast", () => {
  it("connected client receives a { kind: 'message' } frame when /_sys/message is posted", async () => {
    const alice = await bootstrapMember("alice@example.com", "sys-test-single");

    // Warm up the DO by completing the WS handshake first.
    const ws = openWs(alice.roomId, alice.jwt);
    const wsSession = sessions[sessions.push(await ws) - 1];
    if (!wsSession) throw new Error("session push failed");
    wsSession.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await wsSession.next(); // welcome

    // Now inject via /_sys/message.
    const res = await postSysMessage(alice.roomId, {
      userId: alice.userId,
      roomId: alice.roomId,
      body: "Scheduled reminder: daily standup in 10 minutes",
    });
    expect(res.ok).toBe(true);

    // The WS client must receive a broadcast frame.
    const frame = await wsSession.next();
    expect(frame.kind).toBe("message");
    if (frame.kind !== "message") throw new Error("unreachable");

    // Structural invariants — not exact text.
    expect(typeof frame.message.id).toBe("string");
    expect(frame.message.id.length).toBeGreaterThan(0);
    expect(frame.message.room_id).toBe(alice.roomId);
    expect(frame.message.user_id).toBe(alice.userId);
    expect(typeof frame.message.body).toBe("string");
    expect(frame.message.body.length).toBeGreaterThan(0);
  });

  it("fan-out: two connected clients BOTH receive the broadcast frame", async () => {
    const alice = await bootstrapMember("alice@example.com", "sys-test-fanout");
    const bobJwt = await fixture.mint({ email: "bob@example.com" });
    await joinAsMember(bobJwt, alice.roomId);

    // Connect both clients.
    const aliceWs = sessions[sessions.push(await openWs(alice.roomId, alice.jwt)) - 1];
    if (!aliceWs) throw new Error("alice session push failed");
    const bobWs = sessions[sessions.push(await openWs(alice.roomId, bobJwt)) - 1];
    if (!bobWs) throw new Error("bob session push failed");

    aliceWs.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    bobWs.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await aliceWs.next(); // alice welcome
    await bobWs.next(); // bob welcome

    // Inject sys message.
    const res = await postSysMessage(alice.roomId, {
      userId: alice.userId,
      roomId: alice.roomId,
      body: "Team: please fill in the weekly retro doc",
    });
    expect(res.ok).toBe(true);

    // Both clients must receive the same frame.
    const [aliceFrame, bobFrame] = await Promise.all([aliceWs.next(), bobWs.next()]);

    expect(aliceFrame.kind).toBe("message");
    expect(bobFrame.kind).toBe("message");
    if (aliceFrame.kind !== "message" || bobFrame.kind !== "message") {
      throw new Error("unreachable");
    }

    // Both frames carry the same message id (single write, broadcast to all).
    expect(aliceFrame.message.id).toBe(bobFrame.message.id);
    expect(aliceFrame.message.room_id).toBe(alice.roomId);
    expect(bobFrame.message.room_id).toBe(alice.roomId);

    // Structural invariants present on both.
    for (const frame of [aliceFrame, bobFrame]) {
      expect(typeof frame.message.id).toBe("string");
      expect(frame.message.id.length).toBeGreaterThan(0);
      expect(typeof frame.message.body).toBe("string");
      expect(frame.message.body.length).toBeGreaterThan(0);
      expect(typeof frame.message.user_id).toBe("string");
    }
  });

  it("POST /_sys/message without x-loomwiki-sys header returns 403 and no broadcast", async () => {
    const alice = await bootstrapMember("alice@example.com", "sys-test-403");

    const ws = sessions[sessions.push(await openWs(alice.roomId, alice.jwt)) - 1];
    if (!ws) throw new Error("session push failed");
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next(); // welcome

    // Post WITHOUT the required sys header.
    const stub = chatRoomStub(alice.roomId);
    const res = await stub.fetch(
      new Request(`https://do-internal/${alice.roomId}/_sys/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // x-loomwiki-sys intentionally absent
        body: JSON.stringify({
          userId: alice.userId,
          roomId: alice.roomId,
          body: "This should be blocked",
        }),
      }),
    );

    expect(res.status).toBe(403);

    // The WS client must NOT receive any broadcast frame.
    // Use collect() with a short window to drain any buffered frames.
    const stray = await ws.collect(200);
    expect(stray).toHaveLength(0);
  });
});
