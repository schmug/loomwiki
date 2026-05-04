// SPDX-License-Identifier: Apache-2.0

// Historical scrollback (`GET /api/rooms/:rid/messages`) tests. Reads from
// D1, so we drive it by inserting rows directly rather than going through
// the WS path (which would also work but is slower and exercises code that
// has its own test file).

import { SELF, env } from "cloudflare:test";
import { id } from "@loomwiki/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";
import { type JwtFixture, makeJwtFixture } from "./__fixtures__/jwt.js";

let fixture: JwtFixture;

beforeAll(async () => {
  await applyMigrations();
  fixture = await makeJwtFixture();
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

beforeEach(async () => {
  await resetDb();
});

interface Bootstrap {
  jwt: string;
  userId: string;
  roomId: string;
}

async function bootstrapAliceRoom(): Promise<Bootstrap> {
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
      body: JSON.stringify({ slug: "general", name: "General" }),
    },
  );
  const room = (await create.json()) as { data: { room: { id: string } } };
  return { jwt, userId: meBody.data.user.id, roomId: room.data.room.id };
}

async function seedMessage(roomId: string, userId: string, body: string): Promise<string> {
  const mid = id();
  // UUIDv7 is monotonic enough for our ordering checks; tiny await to ensure
  // separate millisecond ticks across calls.
  await new Promise((r) => setTimeout(r, 2));
  await env.DB.prepare("INSERT INTO messages (id, room_id, user_id, body) VALUES (?, ?, ?, ?)")
    .bind(mid, roomId, userId, body)
    .run();
  return mid;
}

describe("GET /api/rooms/:rid/messages", () => {
  it("returns 200 with messages oldest-first for a member", async () => {
    const { jwt, userId, roomId } = await bootstrapAliceRoom();
    await seedMessage(roomId, userId, "first");
    await seedMessage(roomId, userId, "second");
    await seedMessage(roomId, userId, "third");

    const res = await SELF.fetch(`https://api.local/api/rooms/${roomId}/messages?limit=10`, {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { messages: { body: string }[]; hasMore: boolean };
    };
    expect(body.data.messages.map((m) => m.body)).toEqual(["first", "second", "third"]);
    expect(body.data.hasMore).toBe(false);
  });

  it("403 for non-member; 404 for unknown room", async () => {
    const alice = await bootstrapAliceRoom();
    const bobJwt = await fixture.mint({ email: "bob@example.com" });
    await SELF.fetch("https://api.local/api/me", {
      headers: { "CF-Access-Jwt-Assertion": bobJwt },
    });
    const nonMember = await SELF.fetch(`https://api.local/api/rooms/${alice.roomId}/messages`, {
      headers: { "CF-Access-Jwt-Assertion": bobJwt },
    });
    expect(nonMember.status).toBe(403);

    const bogus = "0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa";
    const unknown = await SELF.fetch(`https://api.local/api/rooms/${bogus}/messages`, {
      headers: { "CF-Access-Jwt-Assertion": alice.jwt },
    });
    expect(unknown.status).toBe(404);
  });

  it("paginates via `before` cursor and reports hasMore", async () => {
    const { jwt, userId, roomId } = await bootstrapAliceRoom();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await seedMessage(roomId, userId, `m${i}`));
    }

    // First page: limit=2 → newest 2 messages, hasMore=true.
    const page1 = await SELF.fetch(`https://api.local/api/rooms/${roomId}/messages?limit=2`, {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });
    const body1 = (await page1.json()) as {
      data: { messages: { id: string; body: string }[]; hasMore: boolean };
    };
    expect(body1.data.messages.map((m) => m.body)).toEqual(["m3", "m4"]);
    expect(body1.data.hasMore).toBe(true);

    // Second page: before=oldest-from-page1, limit=2 → next 2 older.
    const oldestFromPage1 = body1.data.messages[0]?.id;
    const page2 = await SELF.fetch(
      `https://api.local/api/rooms/${roomId}/messages?limit=2&before=${oldestFromPage1}`,
      { headers: { "CF-Access-Jwt-Assertion": jwt } },
    );
    const body2 = (await page2.json()) as {
      data: { messages: { body: string }[]; hasMore: boolean };
    };
    expect(body2.data.messages.map((m) => m.body)).toEqual(["m1", "m2"]);
    expect(body2.data.hasMore).toBe(true);
  });

  it("clamps limit to MAX_LIMIT (200) and rejects bad limit", async () => {
    const { jwt, roomId } = await bootstrapAliceRoom();

    const huge = await SELF.fetch(`https://api.local/api/rooms/${roomId}/messages?limit=99999`, {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });
    expect(huge.status).toBe(200);

    const bad = await SELF.fetch(`https://api.local/api/rooms/${roomId}/messages?limit=oops`, {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: { code: string } };
    expect(badBody.error.code).toBe("VALIDATION_FAILED");
  });

  it("blanks body for tombstoned (soft-deleted) messages", async () => {
    const { jwt, userId, roomId } = await bootstrapAliceRoom();
    const mid = await seedMessage(roomId, userId, "secrets");
    await env.DB.prepare("UPDATE messages SET deleted_at = unixepoch() WHERE id = ?")
      .bind(mid)
      .run();

    const res = await SELF.fetch(`https://api.local/api/rooms/${roomId}/messages`, {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });
    const body = (await res.json()) as {
      data: { messages: { body: string; deleted_at: number | null }[] };
    };
    expect(body.data.messages[0]?.body).toBe("");
    expect(body.data.messages[0]?.deleted_at).not.toBeNull();
  });
});
