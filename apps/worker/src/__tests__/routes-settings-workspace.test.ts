// SPDX-License-Identifier: Apache-2.0

// Settings — workspace settings route tests. Allowlist-validates timezone
// + default_model and persists. Owner-only writes.

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

describe("GET /api/settings/workspace", () => {
  it("returns env-derived defaults before any PUT", async () => {
    const { jwt, workspaceId } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/workspace");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        settings: {
          workspace_id: string;
          timezone: string;
          default_model: string;
          updated_by: string | null;
        };
      };
    };
    expect(body.data.settings.workspace_id).toBe(workspaceId);
    expect(body.data.settings.timezone.length).toBeGreaterThan(0);
    expect(body.data.settings.default_model.length).toBeGreaterThan(0);
    expect(body.data.settings.updated_by).toBeNull();
  });
});

describe("PUT /api/settings/workspace", () => {
  it("happy path: persists, audit row written", async () => {
    const { jwt, workspaceId } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/workspace", {
      method: "PUT",
      body: JSON.stringify({
        timezone: "America/New_York",
        default_model: "byok:anthropic",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { settings: { timezone: string; default_model: string } };
    };
    expect(body.data.settings.timezone).toBe("America/New_York");
    expect(body.data.settings.default_model).toBe("byok:anthropic");

    // Subsequent GET reflects persisted values
    const get = await authed(jwt, "/api/settings/workspace");
    const getBody = (await get.json()) as {
      data: { settings: { timezone: string; default_model: string } };
    };
    expect(getBody.data.settings.timezone).toBe("America/New_York");

    // Audit row written
    const audit = await env.DB.prepare("SELECT action FROM audit_log WHERE workspace_id = ?")
      .bind(workspaceId)
      .all<{ action: string }>();
    expect(audit.results?.map((r) => r.action)).toEqual(["workspace_settings.update"]);
  });

  it("rejects bad timezone with 400", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/workspace", {
      method: "PUT",
      body: JSON.stringify({
        timezone: "Mars/Olympus_Mons",
        default_model: "byok:anthropic",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects bad model with 400", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/workspace", {
      method: "PUT",
      body: JSON.stringify({
        timezone: "UTC",
        default_model: "gpt-mystery-9000",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects extra keys (strict body)", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/settings/workspace", {
      method: "PUT",
      body: JSON.stringify({
        timezone: "UTC",
        default_model: "byok:anthropic",
        extra: "not allowed",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("non-owner gets 403", async () => {
    await bootstrapOwner();
    const { jwt: guestJwt } = await plantNonOwner();
    const res = await authed(guestJwt, "/api/settings/workspace", {
      method: "PUT",
      body: JSON.stringify({
        timezone: "UTC",
        default_model: "byok:anthropic",
      }),
    });
    expect(res.status).toBe(403);
  });
});
