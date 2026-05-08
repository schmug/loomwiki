// SPDX-License-Identifier: Apache-2.0

// Settings — AGENTS.md route tests. The PUT path requires `confirmed: true`
// — server-enforced — so the web UI's confirm dialog cannot be bypassed
// by a hand-crafted request that omits the flag.

import { SELF, env } from "cloudflare:test";
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
  // Clear WIKI_KV between tests so AGENTS.md state doesn't leak.
  // The miniflare config gives WIKI_KV and CACHE the same backing id,
  // so this list/delete also wipes JWKS — re-seed JWKS after.
  const list = await env.WIKI_KV.list();
  for (const k of list.keys) await env.WIKI_KV.delete(k.name);
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

async function authed(jwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("CF-Access-Jwt-Assertion", jwt);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`https://api.local${path}`, { ...init, headers });
}

async function bootstrapOwner(): Promise<{ jwt: string; userId: string; workspaceId: string }> {
  const jwt = await fixture.mint({ email: "owner@example.com" });
  const res = await SELF.fetch("https://api.local/api/me", {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
  const body = (await res.json()) as {
    data: { user: { id: string }; workspace: { id: string } };
  };
  return { jwt, userId: body.data.user.id, workspaceId: body.data.workspace.id };
}

async function plantNonOwner(): Promise<{ jwt: string }> {
  const jwt = await fixture.mint({ email: "guest@example.com" });
  await SELF.fetch("https://api.local/api/me", {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
  return { jwt };
}

describe("GET /api/settings/agentsmd", () => {
  it("returns the bundled template content with a null sha when no row exists", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/agentsmd");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: string; sha: string | null } };
    expect(body.data.sha).toBeNull();
    // Verify the seed content actually came through (loose match — the
    // template starts with "# AGENTS.md").
    expect(body.data.content).toContain("# AGENTS.md");
  });

  it("returns the persisted content + sha after a PUT", async () => {
    const { jwt } = await bootstrapOwner();
    await authed(jwt, "/api/settings/agentsmd", {
      method: "PUT",
      body: JSON.stringify({ content: "# Custom AGENTS.md\n", confirmed: true }),
    });
    const res = await authed(jwt, "/api/settings/agentsmd");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: string; sha: string } };
    expect(body.data.content).toBe("# Custom AGENTS.md\n");
    expect(body.data.sha).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("PUT /api/settings/agentsmd", () => {
  it("happy path: persists, returns sha, writes audit row", async () => {
    const { jwt, userId, workspaceId } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/agentsmd", {
      method: "PUT",
      body: JSON.stringify({ content: "# New content\n", confirmed: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { saved: boolean; sha: string } };
    expect(body.data.saved).toBe(true);
    expect(body.data.sha).toMatch(/^[0-9a-f]{64}$/);

    const audit = await env.DB.prepare(
      "SELECT action, actor_user_id, after_json FROM audit_log WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .all<{ action: string; actor_user_id: string; after_json: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results?.[0]?.action).toBe("agentsmd.update");
    expect(audit.results?.[0]?.actor_user_id).toBe(userId);
    expect(audit.results?.[0]?.after_json).toContain("New content");
  });

  it("rejects body without confirmed: true with 400", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/agentsmd", {
      method: "PUT",
      body: JSON.stringify({ content: "# Sneaky\n" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects body with confirmed: false with 400", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/agentsmd", {
      method: "PUT",
      body: JSON.stringify({ content: "# Sneaky\n", confirmed: false }),
    });
    expect(res.status).toBe(400);
  });

  it("non-owner gets 403", async () => {
    await bootstrapOwner();
    const { jwt: guestJwt } = await plantNonOwner();
    const res = await authed(guestJwt, "/api/settings/agentsmd", {
      method: "PUT",
      body: JSON.stringify({ content: "# Hacked\n", confirmed: true }),
    });
    expect(res.status).toBe(403);
  });
});
