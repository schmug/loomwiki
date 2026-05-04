// SPDX-License-Identifier: Apache-2.0

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
  workspaceId: string;
  userId: string;
  roomId: string;
  roomSlug: string;
}

async function bootstrapAliceWithRoom(): Promise<Bootstrap> {
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
  const room = (await create.json()) as { data: { room: { id: string; slug: string } } };

  return {
    jwt,
    workspaceId: meBody.data.workspace.id,
    userId: meBody.data.user.id,
    roomId: room.data.room.id,
    roomSlug: room.data.room.slug,
  };
}

describe("rooms routes", () => {
  it("GET /api/rooms/:rid returns the room for a member", async () => {
    const { jwt, roomId, roomSlug } = await bootstrapAliceWithRoom();
    const res = await SELF.fetch(`https://api.local/api/rooms/${roomId}`, {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { room: { id: string; slug: string } } };
    expect(body.data.room.id).toBe(roomId);
    expect(body.data.room.slug).toBe(roomSlug);
  });

  it("GET /api/rooms/:rid returns 404 for an unknown room id", async () => {
    const { jwt } = await bootstrapAliceWithRoom();
    const res = await SELF.fetch(`https://api.local/api/rooms/${id()}`, {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("GET /api/rooms/:rid returns 403 for a non-member", async () => {
    const { roomId } = await bootstrapAliceWithRoom();
    // A different authenticated user who hasn't joined Alice's room.
    const bobJwt = await fixture.mint({ email: "bob@example.com" });
    // Bob hits /api/me first to JIT-create his row.
    await SELF.fetch("https://api.local/api/me", {
      headers: { "CF-Access-Jwt-Assertion": bobJwt },
    });

    const res = await SELF.fetch(`https://api.local/api/rooms/${roomId}`, {
      headers: { "CF-Access-Jwt-Assertion": bobJwt },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });
});
