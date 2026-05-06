// SPDX-License-Identifier: Apache-2.0

// Smoke tests for POST /api/_admin/digest/render. Owner-only; the
// underlying renderDailyDigest is exercised in digest-delivery.test.ts.

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
  const list = await env.WIKI_KV.list();
  for (const k of list.keys) await env.WIKI_KV.delete(k.name);
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

async function authed(jwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("CF-Access-Jwt-Assertion", jwt);
  return SELF.fetch(`https://api.local${path}`, { ...init, headers });
}

async function ownerJwt(): Promise<string> {
  const jwt = await fixture.mint({ email: "alice@example.com" });
  // Bootstrap by hitting /api/me — that JIT-creates the user and the
  // single-tenant workspace, which makes alice the owner.
  await SELF.fetch("https://api.local/api/me", {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
  return jwt;
}

describe("POST /api/_admin/digest/render", () => {
  it("renders an empty digest for a fresh workspace", async () => {
    const jwt = await ownerJwt();
    const res = await authed(jwt, "/api/_admin/digest/render?date=2026-05-04", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { delivered: boolean; path: string };
    };
    expect(body.data.delivered).toBe(true);
    expect(body.data.path).toBe("/wiki/_inbox/2026-05-04.md");
  });

  it("rejects non-owner with 403", async () => {
    await ownerJwt(); // bootstrap workspace
    const otherJwt = await fixture.mint({ email: "stranger@example.com" });
    const res = await authed(otherJwt, "/api/_admin/digest/render?date=2026-05-04", {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  it("rejects invalid date", async () => {
    const jwt = await ownerJwt();
    const res = await authed(jwt, "/api/_admin/digest/render?date=2026-13-99", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});
