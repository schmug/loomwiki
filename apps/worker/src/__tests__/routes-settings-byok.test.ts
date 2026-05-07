// SPDX-License-Identifier: Apache-2.0

// Settings — BYOK route tests. Asserts the contract on the wire:
//   - GET never returns plaintext
//   - PUT requires owner + valid provider + valid body
//   - DELETE owner-only, audit row written
//   - 400 for unknown provider, 400 for malformed body

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateTestMasterKeyB64 } from "../lib/crypto.js";
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
  // biome-ignore lint/suspicious/noExplicitAny: setting optional secret on env
  (env as any).BYOK_ENCRYPTION_KEY = generateTestMasterKeyB64();
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

async function plantNonOwner(workspaceId: string): Promise<{ jwt: string; userId: string }> {
  // Bootstrap a second user, then forcibly retain ownership on the first.
  const jwt = await fixture.mint({ email: "guest@example.com" });
  const res = await SELF.fetch("https://api.local/api/me", {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
  const body = (await res.json()) as { data: { user: { id: string } } };
  // The auth middleware bootstraps the very first user as owner; the
  // second `/api/me` call doesn't change ownership. So workspaceId
  // already belongs to the original owner. Sanity check:
  const row = await env.DB.prepare("SELECT owner_id FROM workspaces WHERE id = ?")
    .bind(workspaceId)
    .first<{ owner_id: string }>();
  expect(row?.owner_id).not.toBe(body.data.user.id);
  return { jwt, userId: body.data.user.id };
}

describe("GET /api/settings/byok", () => {
  it("returns the empty key list initially", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/byok");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { keys: unknown[] } };
    expect(body.data.keys).toEqual([]);
  });

  it("never returns plaintext, only metadata", async () => {
    const { jwt } = await bootstrapOwner();
    const put = await authed(jwt, "/api/settings/byok/anthropic", {
      method: "PUT",
      body: JSON.stringify({ key: "sk-ant-test1234567890abcdef" }),
    });
    expect(put.status).toBe(200);

    const res = await authed(jwt, "/api/settings/byok");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-ant-test1234567890abcdef");
    const body = JSON.parse(text) as {
      data: { keys: { provider: string; has_key: boolean }[] };
    };
    expect(body.data.keys).toHaveLength(1);
    expect(body.data.keys[0]?.provider).toBe("anthropic");
    expect(body.data.keys[0]?.has_key).toBe(true);
    // The metadata shape must not contain the ciphertext or key.
    expect(Object.keys(body.data.keys[0] ?? {})).not.toContain("ciphertext");
    expect(Object.keys(body.data.keys[0] ?? {})).not.toContain("key");
  });
});

describe("PUT /api/settings/byok/:provider", () => {
  it("happy path: stores the key and writes a byok.create audit row", async () => {
    const { jwt, userId, workspaceId } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/byok/anthropic", {
      method: "PUT",
      body: JSON.stringify({ key: "sk-ant-aaaaaaaaaaaaaaaa" }),
    });
    expect(res.status).toBe(200);

    const audit = await env.DB.prepare(
      "SELECT action, actor_user_id, resource_id, after_json FROM audit_log WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .all<{ action: string; actor_user_id: string; resource_id: string; after_json: string }>();
    expect(audit.results).toHaveLength(1);
    const row = audit.results?.[0];
    expect(row?.action).toBe("byok.create");
    expect(row?.actor_user_id).toBe(userId);
    expect(row?.resource_id).toBe("anthropic");
    // Plaintext key NEVER appears in the audit row.
    expect(row?.after_json ?? "").not.toContain("sk-ant-");
  });

  it("rejects malformed body with 400", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/byok/anthropic", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown provider with 400", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/byok/cohere", {
      method: "PUT",
      body: JSON.stringify({ key: "sk-cohere-aaaaaaaa" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects google (not in v0.0.1 UI providers) with 400", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/byok/google", {
      method: "PUT",
      body: JSON.stringify({ key: "AIzaSyAaaaaaaaaaaaaaaa" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects bad-shape Anthropic key with 400", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/byok/anthropic", {
      method: "PUT",
      body: JSON.stringify({ key: "not-a-real-key-at-all" }),
    });
    expect(res.status).toBe(400);
  });

  it("non-owner gets 403", async () => {
    const { workspaceId } = await bootstrapOwner();
    const { jwt: guestJwt } = await plantNonOwner(workspaceId);
    const res = await authed(guestJwt, "/api/settings/byok/anthropic", {
      method: "PUT",
      body: JSON.stringify({ key: "sk-ant-aaaaaaaaaaaaaaaa" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/settings/byok/:provider", () => {
  it("happy path: soft-deletes and writes a byok.delete audit row", async () => {
    const { jwt, workspaceId } = await bootstrapOwner();
    await authed(jwt, "/api/settings/byok/anthropic", {
      method: "PUT",
      body: JSON.stringify({ key: "sk-ant-aaaaaaaaaaaaaaaa" }),
    });
    const res = await authed(jwt, "/api/settings/byok/anthropic", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: boolean; provider: string } };
    expect(body.data.deleted).toBe(true);
    expect(body.data.provider).toBe("anthropic");

    const audit = await env.DB.prepare(
      "SELECT action FROM audit_log WHERE workspace_id = ? ORDER BY created_at ASC, id ASC",
    )
      .bind(workspaceId)
      .all<{ action: string }>();
    expect(audit.results?.map((r) => r.action)).toEqual(["byok.create", "byok.delete"]);

    // listBYOK now hides the soft-deleted row
    const list = await authed(jwt, "/api/settings/byok");
    const listBody = (await list.json()) as { data: { keys: unknown[] } };
    expect(listBody.data.keys).toEqual([]);
  });

  it("non-owner gets 403", async () => {
    const { workspaceId } = await bootstrapOwner();
    const { jwt: guestJwt } = await plantNonOwner(workspaceId);
    const res = await authed(guestJwt, "/api/settings/byok/anthropic", { method: "DELETE" });
    expect(res.status).toBe(403);
  });
});
