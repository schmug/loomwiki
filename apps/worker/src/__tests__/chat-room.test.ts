// SPDX-License-Identifier: Apache-2.0

// ChatRoom DO end-to-end tests, exercised through SELF.fetch so auth +
// route + DO upgrade all run as one unit. Reserves runInDurableObject for
// cases the route layer cannot reach (alarm fire, mirror failure paths).

import { SELF, env } from "cloudflare:test";
import { PROTOCOL_VERSION } from "@loomwiki/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

interface RoomBootstrap {
  jwt: string;
  userId: string;
  roomId: string;
}

async function bootstrapMember(email: string, slug: string): Promise<RoomBootstrap> {
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
  // Bootstrap user via /me so the row exists, then add to room_members
  // directly via D1 (the public room-join API lands later — for now this
  // is the test seam).
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

async function track<T extends WsSession>(s: T): Promise<T> {
  openSessions.push(s);
  return s;
}

describe("ChatRoom DO — WebSocket flow", () => {
  it("rejects upgrade for non-members with 403", async () => {
    const alice = await bootstrapMember("alice@example.com", "alice-room");
    const bobJwt = await fixture.mint({ email: "bob@example.com" });
    await SELF.fetch("https://api.local/api/me", {
      headers: { "CF-Access-Jwt-Assertion": bobJwt },
    });

    const res = await SELF.fetch(`https://api.local/api/rooms/${alice.roomId}/ws`, {
      headers: { Upgrade: "websocket", "CF-Access-Jwt-Assertion": bobJwt },
    });
    expect(res.status).toBe(403);
  });

  it("rejects upgrade for unknown room with 404", async () => {
    const alice = await bootstrapMember("alice@example.com", "alice-room");
    const bogus = "0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa";
    const res = await SELF.fetch(`https://api.local/api/rooms/${bogus}/ws`, {
      headers: { Upgrade: "websocket", "CF-Access-Jwt-Assertion": alice.jwt },
    });
    expect(res.status).toBe(404);
  });

  it("hello → welcome with empty backlog returns protocolVersion", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await track(await openWs(alice.roomId, alice.jwt));
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });

    const welcome = await ws.next();
    expect(welcome.kind).toBe("welcome");
    if (welcome.kind !== "welcome") throw new Error("unreachable");
    expect(welcome.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(welcome.roomId).toBe(alice.roomId);
    expect(welcome.recentMessages).toEqual([]);
  });

  it("two members exchange a message; sender gets ack, receiver gets message", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const bobJwt = await fixture.mint({ email: "bob@example.com" });
    await joinAsMember(bobJwt, alice.roomId);

    const aliceWs = await track(await openWs(alice.roomId, alice.jwt));
    const bobWs = await track(await openWs(alice.roomId, bobJwt));

    aliceWs.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    bobWs.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await aliceWs.next();
    await bobWs.next();

    aliceWs.send({ kind: "send", tempId: "t-1", body: "hello bob" });

    const ack = await aliceWs.next();
    expect(ack.kind).toBe("ack");
    if (ack.kind !== "ack") throw new Error("unreachable");
    expect(ack.tempId).toBe("t-1");

    const recv = await bobWs.next();
    expect(recv.kind).toBe("message");
    if (recv.kind !== "message") throw new Error("unreachable");
    expect(recv.message.body).toBe("hello bob");
    expect(recv.message.id).toBe(ack.messageId);
    expect(recv.message.user_id).toBe(alice.userId);
  });

  it("rejects body > 4096 chars with VALIDATION_FAILED, echoing tempId", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await track(await openWs(alice.roomId, alice.jwt));
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next();

    ws.send({ kind: "send", tempId: "too-long", body: "x".repeat(4097) });
    const err = await ws.next();
    expect(err.kind).toBe("error");
    if (err.kind !== "error") throw new Error("unreachable");
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.tempId).toBe("too-long");
  });

  it("rate-limits beyond 100 msg/sec/room with RATE_LIMITED", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await track(await openWs(alice.roomId, alice.jwt));
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next();

    // Drain the budget by firing 100 sends.
    for (let i = 0; i < 100; i++) {
      ws.send({ kind: "send", tempId: `t-${i}`, body: `m${i}` });
    }
    // Drain acks (and any echoed messages — there's only one socket so we
    // expect 100 acks total).
    let acks = 0;
    while (acks < 100) {
      const m = await ws.next(2000);
      if (m.kind === "ack") acks++;
    }

    // The 101st must be rejected.
    ws.send({ kind: "send", tempId: "rate", body: "rate-me" });
    const next = await ws.next();
    expect(next.kind).toBe("error");
    if (next.kind !== "error") throw new Error("unreachable");
    expect(next.code).toBe("RATE_LIMITED");
    expect(next.tempId).toBe("rate");
  });

  it("reconnect with sinceMessageId returns missed messages in welcome", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    // Round 1: send a few messages, capture IDs.
    const ws1 = await track(await openWs(alice.roomId, alice.jwt));
    ws1.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws1.next();

    const sentIds: string[] = [];
    for (const body of ["one", "two", "three"]) {
      ws1.send({ kind: "send", tempId: body, body });
      const ack = await ws1.next();
      if (ack.kind !== "ack") throw new Error("expected ack");
      sentIds.push(ack.messageId);
    }
    ws1.close();
    openSessions.pop();

    // Round 2: reconnect with sinceMessageId set to the first message;
    // welcome should include "two" and "three", not "one".
    const ws2 = await track(await openWs(alice.roomId, alice.jwt));
    ws2.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION, sinceMessageId: sentIds[0] });
    const welcome = await ws2.next();
    if (welcome.kind !== "welcome") throw new Error("expected welcome");
    expect(welcome.recentMessages.map((m) => m.body)).toEqual(["two", "three"]);
  });

  it("edit by author succeeds; non-author gets FORBIDDEN", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const bobJwt = await fixture.mint({ email: "bob@example.com" });
    await joinAsMember(bobJwt, alice.roomId);

    const aliceWs = await track(await openWs(alice.roomId, alice.jwt));
    const bobWs = await track(await openWs(alice.roomId, bobJwt));
    aliceWs.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    bobWs.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await aliceWs.next();
    await bobWs.next();

    aliceWs.send({ kind: "send", tempId: "e1", body: "original" });
    const ack = await aliceWs.next();
    if (ack.kind !== "ack") throw new Error("expected ack");
    await bobWs.next(); // bob receives the message broadcast

    // Author edits — should broadcast to both, including sender.
    aliceWs.send({ kind: "edit", messageId: ack.messageId, body: "edited!" });
    const aliceEdited = await aliceWs.next();
    expect(aliceEdited.kind).toBe("edited");
    const bobEdited = await bobWs.next();
    expect(bobEdited.kind).toBe("edited");

    // Bob attempts to edit Alice's message — FORBIDDEN.
    bobWs.send({ kind: "edit", messageId: ack.messageId, body: "naughty" });
    const denied = await bobWs.next();
    expect(denied.kind).toBe("error");
    if (denied.kind !== "error") throw new Error("unreachable");
    expect(denied.code).toBe("FORBIDDEN");
  });

  it("delete by author tombstones; scrollback returns blanked body", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await track(await openWs(alice.roomId, alice.jwt));
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next();

    ws.send({ kind: "send", tempId: "d1", body: "doomed" });
    const ack = await ws.next();
    if (ack.kind !== "ack") throw new Error("expected ack");

    ws.send({ kind: "delete", messageId: ack.messageId });
    const deleted = await ws.next();
    expect(deleted.kind).toBe("deleted");
    if (deleted.kind !== "deleted") throw new Error("unreachable");
    expect(deleted.messageId).toBe(ack.messageId);

    // Reconnect — backlog includes the tombstoned message with body=""
    ws.close();
    openSessions.pop();
    const ws2 = await track(await openWs(alice.roomId, alice.jwt));
    ws2.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    const welcome = await ws2.next();
    if (welcome.kind !== "welcome") throw new Error("expected welcome");
    const tombstone = welcome.recentMessages.find((m) => m.id === ack.messageId);
    expect(tombstone?.body).toBe("");
    expect(tombstone?.deleted_at).not.toBeNull();
  });

  it("malformed JSON yields VALIDATION_FAILED but keeps the socket open", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await track(await openWs(alice.roomId, alice.jwt));
    ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
    await ws.next();

    ws.ws.send("{not-json");
    const err = await ws.next();
    expect(err.kind).toBe("error");
    if (err.kind !== "error") throw new Error("unreachable");
    expect(err.code).toBe("VALIDATION_FAILED");

    // Socket still works.
    ws.send({ kind: "ping" });
    const pong = await ws.next();
    expect(pong.kind).toBe("pong");
  });
});
