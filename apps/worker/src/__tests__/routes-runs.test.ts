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
});

beforeEach(async () => {
  await resetDb();
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

async function authed(jwt: string, path: string): Promise<Response> {
  return SELF.fetch(`https://api.local${path}`, {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
}

async function bootstrap(): Promise<{ jwt: string; roomId: string; userId: string }> {
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
      headers: { "CF-Access-Jwt-Assertion": jwt, "content-type": "application/json" },
      body: JSON.stringify({ slug: "ops", name: "Ops" }),
    },
  );
  const room = (await create.json()) as { data: { room: { id: string } } };
  return { jwt, roomId: room.data.room.id, userId: meBody.data.user.id };
}

async function seedRun(roomId: string, triggeredBy: string, status: string): Promise<string> {
  const runId = id();
  await env.DB.prepare(
    "INSERT INTO ingest_runs (id, room_id, triggered_by, status) VALUES (?, ?, ?, ?)",
  )
    .bind(runId, roomId, triggeredBy, status)
    .run();
  return runId;
}

describe("GET /api/runs/:id", () => {
  it("returns 404 for unknown run", async () => {
    const { jwt } = await bootstrap();
    const res = await authed(jwt, `/api/runs/${id()}`);
    expect(res.status).toBe(404);
  });

  it("returns the run when caller is in the same workspace", async () => {
    const { jwt, roomId, userId } = await bootstrap();
    const runId = await seedRun(roomId, userId, "succeeded");
    const res = await authed(jwt, `/api/runs/${runId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { run: { id: string; status: string } } };
    expect(body.data.run.id).toBe(runId);
    expect(body.data.run.status).toBe("succeeded");
  });
});

describe("GET /api/rooms/:rid/runs", () => {
  it("lists recent runs newest-first", async () => {
    const { jwt, roomId, userId } = await bootstrap();
    await seedRun(roomId, userId, "succeeded");
    await new Promise((r) => setTimeout(r, 5));
    await seedRun(roomId, userId, "failed");
    const res = await authed(jwt, `/api/rooms/${roomId}/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { runs: { status: string; started_at: string }[] };
    };
    expect(body.data.runs).toHaveLength(2);
    // Newest-first: failed (later) comes before succeeded.
    expect(body.data.runs[0]?.status).toBe("failed");
  });

  it("rejects non-members with 403", async () => {
    const { roomId } = await bootstrap();
    const otherJwt = await fixture.mint({ email: "stranger@example.com" });
    const res = await authed(otherJwt, `/api/rooms/${roomId}/runs`);
    expect(res.status).toBe(403);
  });
});
