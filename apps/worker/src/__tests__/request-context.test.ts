// SPDX-License-Identifier: Apache-2.0

// Per-request correlation id middleware. Stamps an id, echoes via the
// X-Request-Id response header, honors a valid inbound id, regenerates
// when the inbound is malformed.

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

describe("requestContextMiddleware", () => {
  it("stamps a fresh id when no X-Request-Id header is supplied", async () => {
    const res = await SELF.fetch("https://api.local/api/health");
    const id = res.headers.get("X-Request-Id");
    expect(id).not.toBeNull();
    // UUIDv7 by default: hex chars, dashes, length 36.
    expect(id?.length).toBe(36);
  });

  it("echoes a valid inbound X-Request-Id back to the client", async () => {
    const res = await SELF.fetch("https://api.local/api/health", {
      headers: { "X-Request-Id": "smoke-test-123" },
    });
    expect(res.headers.get("X-Request-Id")).toBe("smoke-test-123");
  });

  it("regenerates when the inbound id is malformed (newlines / oversize)", async () => {
    // A header value with a newline would normally be rejected by fetch,
    // but the middleware's regex also rejects non-allowlisted chars and
    // any string longer than 64 chars. Use an oversize value as the
    // observable proxy.
    const oversize = "x".repeat(128);
    const res = await SELF.fetch("https://api.local/api/health", {
      headers: { "X-Request-Id": oversize },
    });
    const echoed = res.headers.get("X-Request-Id");
    expect(echoed).not.toBeNull();
    expect(echoed).not.toBe(oversize);
    expect(echoed?.length).toBe(36);
  });

  it("works on authenticated routes (stamps id, audit log can use it)", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await SELF.fetch("https://api.local/api/me", {
      headers: { "CF-Access-Jwt-Assertion": jwt, "X-Request-Id": "audit-correlation-abc" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("audit-correlation-abc");
  });
});
