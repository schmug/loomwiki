// SPDX-License-Identifier: Apache-2.0

// HTTP integration tests for POST /api/rooms/:rid/ingest. Drives the
// full Hono pipeline (auth → membership → lock → dispatch). The agent
// body work runs in-process via ctx.waitUntil; we don't assert on
// post-hoc proposal counts because the LLM call would attempt to reach
// the real binding. Routes-test scope is the synchronous response.

import { SELF, env } from "cloudflare:test";
import { id } from "@loomwiki/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";
import { type JwtFixture, makeJwtFixture } from "./__fixtures__/jwt.js";

let fixture: JwtFixture;

beforeAll(async () => {
  await applyMigrations();
  fixture = await makeJwtFixture();
});

beforeEach(async () => {
  await resetDb();
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

interface Bootstrap {
  jwt: string;
  userId: string;
  roomId: string;
  workspaceId: string;
}

async function bootstrap(): Promise<Bootstrap> {
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
      body: JSON.stringify({ slug: "ops-cyber", name: "Ops Cyber" }),
    },
  );
  const room = (await create.json()) as { data: { room: { id: string } } };
  return {
    jwt,
    userId: meBody.data.user.id,
    roomId: room.data.room.id,
    workspaceId: meBody.data.workspace.id,
  };
}

async function authedFetch(jwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("CF-Access-Jwt-Assertion", jwt);
  return SELF.fetch(`https://api.local${path}`, { ...init, headers });
}

describe("POST /api/rooms/:rid/ingest", () => {
  it("returns 401 without an Access JWT", async () => {
    const res = await SELF.fetch("https://api.local/api/rooms/abc/ingest", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown room", async () => {
    const { jwt } = await bootstrap();
    const fakeRoomId = id();
    const res = await authedFetch(jwt, `/api/rooms/${fakeRoomId}/ingest`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 403 for a non-member", async () => {
    const { roomId } = await bootstrap();
    const otherJwt = await fixture.mint({ email: "stranger@example.com" });
    const res = await authedFetch(otherJwt, `/api/rooms/${roomId}/ingest`, { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("returns 200 with run_id when the lock is acquired", async () => {
    const { jwt, roomId } = await bootstrap();
    const res = await authedFetch(jwt, `/api/rooms/${roomId}/ingest`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { run_id: string; status: string } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("running");
    expect(body.data.run_id).toMatch(/^[0-9a-f]{8}-/);

    // The run row exists and started in 'running' state.
    const row = await env.DB.prepare("SELECT status FROM ingest_runs WHERE id = ?")
      .bind(body.data.run_id)
      .first<{ status: string }>();
    expect(row).not.toBeNull();
  });

  it("returns 202 LOCK_HELD when a running run already exists", async () => {
    const { jwt, roomId, userId } = await bootstrap();

    // Manually insert a running ingest_runs row to simulate concurrent
    // trigger.
    await env.DB.prepare(
      "INSERT INTO ingest_runs (id, room_id, triggered_by, status) VALUES (?, ?, ?, 'running')",
    )
      .bind(id(), roomId, userId)
      .run();

    const res = await authedFetch(jwt, `/api/rooms/${roomId}/ingest`, { method: "POST" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: true; data: { run_id: string; status: string } };
    expect(body.data.status).toBe("lock_held");
  });
});
