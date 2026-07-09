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

async function authedFetch(jwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("CF-Access-Jwt-Assertion", jwt);
  return SELF.fetch(`https://api.local${path}`, { ...init, headers });
}

describe("GET /api/workspaces/:wid/members", () => {
  it("returns 401 without JWT", async () => {
    const res = await SELF.fetch("https://api.local/api/workspaces/x/members");
    expect(res.status).toBe(401);
  });

  it("lists every workspace user", async () => {
    const ownerJwt = await fixture.mint({ email: "owner@example.com" });
    const me = await authedFetch(ownerJwt, "/api/me");
    const meBody = (await me.json()) as { data: { workspace: { id: string } } };
    const wid = meBody.data.workspace.id;

    const secondJwt = await fixture.mint({ email: "bob@example.com" });
    await authedFetch(secondJwt, "/api/me"); // JIT-provision bob

    const res = await authedFetch(ownerJwt, `/api/workspaces/${wid}/members`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { members: Array<{ id: string; email: string; display_name: string }> };
    };
    const emails = body.data.members.map((m) => m.email).sort();
    expect(emails).toEqual(["bob@example.com", "owner@example.com"]);
  });

  it("404s for a foreign workspace id", async () => {
    const ownerJwt = await fixture.mint({ email: "owner@example.com" });
    await authedFetch(ownerJwt, "/api/me");
    const res = await authedFetch(
      ownerJwt,
      "/api/workspaces/0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa/members",
    );
    expect(res.status).toBe(404);
  });
});
