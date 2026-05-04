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

interface OkBody<T> {
  ok: true;
  data: T;
}

interface MeBody {
  user: { id: string; email: string; display_name: string; created_at: string };
  workspace: { id: string; name: string; owner_id: string; created_at: string };
  rooms: { id: string; slug: string }[];
}

async function fetchMe(jwt: string): Promise<OkBody<MeBody>> {
  const res = await SELF.fetch("https://api.local/api/me", {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as OkBody<MeBody>;
}

describe("GET /api/me", () => {
  it("JIT-creates a user on first call and is idempotent on subsequent calls", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });

    const first = await fetchMe(jwt);
    expect(first.data.user.email).toBe("alice@example.com");
    expect(first.data.user.display_name).toBe("Alice"); // local-part, capitalized
    expect(first.data.rooms).toEqual([]);
    const userId = first.data.user.id;
    const workspaceId = first.data.workspace.id;

    const second = await fetchMe(jwt);
    expect(second.data.user.id).toBe(userId);
    expect(second.data.workspace.id).toBe(workspaceId);
  });

  it("returns ISO-8601 timestamps for created_at", async () => {
    const jwt = await fixture.mint({ email: "bob@example.com" });
    const body = await fetchMe(jwt);
    expect(body.data.user.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(body.data.workspace.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("makes the first authenticated user the workspace owner", async () => {
    const jwt = await fixture.mint({ email: "first@example.com" });
    const body = await fetchMe(jwt);
    expect(body.data.workspace.owner_id).toBe(body.data.user.id);

    // A second user should see the existing workspace, not become a new owner.
    const jwt2 = await fixture.mint({ email: "second@example.com" });
    const body2 = await fetchMe(jwt2);
    expect(body2.data.workspace.id).toBe(body.data.workspace.id);
    expect(body2.data.workspace.owner_id).toBe(body.data.user.id);
    expect(body2.data.user.id).not.toBe(body.data.user.id);
  });

  it("normalizes email casing — JIT for ALICE@example.com matches alice@example.com", async () => {
    const jwt1 = await fixture.mint({ email: "Mixed@Example.COM" });
    const body1 = await fetchMe(jwt1);
    const jwt2 = await fixture.mint({ email: "mixed@example.com" });
    const body2 = await fetchMe(jwt2);
    expect(body2.data.user.id).toBe(body1.data.user.id);
  });
});
