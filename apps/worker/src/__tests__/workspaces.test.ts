// SPDX-License-Identifier: Apache-2.0

import { SELF, env } from "cloudflare:test";
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

async function bootstrapAlice(): Promise<{ jwt: string; workspaceId: string; userId: string }> {
  const jwt = await fixture.mint({ email: "alice@example.com" });
  const res = await SELF.fetch("https://api.local/api/me", {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
  const body = (await res.json()) as {
    data: { user: { id: string }; workspace: { id: string } };
  };
  return { jwt, workspaceId: body.data.workspace.id, userId: body.data.user.id };
}

describe("workspaces routes", () => {
  it("GET /api/workspaces/:wid returns the workspace for a member", async () => {
    const { jwt, workspaceId } = await bootstrapAlice();
    const res = await SELF.fetch(`https://api.local/api/workspaces/${workspaceId}`, {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { workspace: { id: string } } };
    expect(body.data.workspace.id).toBe(workspaceId);
  });

  it("GET /api/workspaces/:wid returns 404 for an unknown workspace id", async () => {
    const { jwt } = await bootstrapAlice();
    const res = await SELF.fetch(
      "https://api.local/api/workspaces/00000000-0000-7000-8000-deadbeefdead",
      { headers: { "CF-Access-Jwt-Assertion": jwt } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("GET /api/workspaces/:wid/rooms returns the rooms the user belongs to", async () => {
    const { jwt, workspaceId } = await bootstrapAlice();

    // Create a room.
    const create = await SELF.fetch(`https://api.local/api/workspaces/${workspaceId}/rooms`, {
      method: "POST",
      headers: {
        "CF-Access-Jwt-Assertion": jwt,
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug: "ops-cyber", name: "Ops Cyber", topic: "security incidents" }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { data: { room: { id: string; slug: string } } };
    expect(created.data.room.slug).toBe("ops-cyber");

    const list = await SELF.fetch(`https://api.local/api/workspaces/${workspaceId}/rooms`, {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });
    const listBody = (await list.json()) as { data: { rooms: { id: string; slug: string }[] } };
    expect(listBody.data.rooms.map((r) => r.slug)).toEqual(["ops-cyber"]);
  });

  it("POST /api/workspaces/:wid/rooms with a duplicate slug returns 409 CONFLICT", async () => {
    const { jwt, workspaceId } = await bootstrapAlice();
    const body = JSON.stringify({ slug: "general", name: "General" });
    const headers = {
      "CF-Access-Jwt-Assertion": jwt,
      "content-type": "application/json",
    };

    const first = await SELF.fetch(`https://api.local/api/workspaces/${workspaceId}/rooms`, {
      method: "POST",
      headers,
      body,
    });
    expect(first.status).toBe(201);

    const second = await SELF.fetch(`https://api.local/api/workspaces/${workspaceId}/rooms`, {
      method: "POST",
      headers,
      body,
    });
    expect(second.status).toBe(409);
    const errBody = (await second.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe("CONFLICT");
  });

  it("POST /api/workspaces/:wid/rooms validates the slug format (400 VALIDATION_FAILED)", async () => {
    const { jwt, workspaceId } = await bootstrapAlice();
    const res = await SELF.fetch(`https://api.local/api/workspaces/${workspaceId}/rooms`, {
      method: "POST",
      headers: {
        "CF-Access-Jwt-Assertion": jwt,
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug: "Has Spaces!", name: "Bad Slug" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("POST /api/workspaces/:wid/rooms auto-adds creator as room admin", async () => {
    const { jwt, workspaceId, userId } = await bootstrapAlice();
    const create = await SELF.fetch(`https://api.local/api/workspaces/${workspaceId}/rooms`, {
      method: "POST",
      headers: {
        "CF-Access-Jwt-Assertion": jwt,
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug: "general", name: "General" }),
    });
    const created = (await create.json()) as { data: { room: { id: string } } };

    const member = await env.DB.prepare(
      "SELECT role FROM room_members WHERE room_id = ? AND user_id = ?",
    )
      .bind(created.data.room.id, userId)
      .first<{ role: string }>();
    expect(member?.role).toBe("admin");
  });
});
