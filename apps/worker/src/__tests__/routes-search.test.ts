// SPDX-License-Identifier: Apache-2.0

// Integration tests for POST /api/search. Auth, validation, and
// rate-limiting concerns live here; the orchestrator's hybrid policy
// is tested separately in the search-lib suite.
//
// We mock the searchWiki orchestrator via vi.mock so this file
// exercises only the route layer (auth → validation → cost guard →
// JSON envelope). That keeps the test independent of AI Search /
// FTS5 binding shape and makes failure attribution unambiguous.

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";
import { type JwtFixture, makeJwtFixture } from "./__fixtures__/jwt.js";

// Mock the search lib so the route-layer tests don't depend on the
// real AI Search binding (absent in test env) or on whether subagent
// A's hybrid policy has shipped yet. Each test can override the
// resolved value via mockImplementationOnce.
vi.mock("../lib/search.js", () => ({
  searchWiki: vi.fn(async () => ({ results: [], mode: "hybrid" })),
}));

let fixture: JwtFixture;

beforeAll(async () => {
  await applyMigrations();
  fixture = await makeJwtFixture();
});

beforeEach(async () => {
  await resetDb();
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

interface Ok<T> {
  ok: true;
  data: T;
}
interface Err {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

async function authedFetch(jwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("CF-Access-Jwt-Assertion", jwt);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return SELF.fetch(`https://api.local${path}`, { ...init, headers });
}

describe("POST /api/search — auth gating", () => {
  it("returns 401 without a JWT", async () => {
    const res = await SELF.fetch("https://api.local/api/search", {
      method: "POST",
      body: JSON.stringify({ query: "hello" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/search — validation", () => {
  it("returns 400 for a missing body", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await authedFetch(jwt, "/api/search", { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Err;
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 for a query that exceeds 2000 characters", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const tooLong = "a".repeat(2001);
    const res = await authedFetch(jwt, "/api/search", {
      method: "POST",
      body: JSON.stringify({ query: tooLong }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Err;
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 for an out-of-range topK", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await authedFetch(jwt, "/api/search", {
      method: "POST",
      body: JSON.stringify({ query: "ok", topK: 999 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/search — happy path", () => {
  it("returns the orchestrator response envelope", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await authedFetch(jwt, "/api/search", {
      method: "POST",
      body: JSON.stringify({ query: "dmarc" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Ok<{
      results: unknown[];
      mode: string;
    }>;
    expect(body.ok).toBe(true);
    expect(body.data.mode).toBe("hybrid");
    expect(Array.isArray(body.data.results)).toBe(true);
  });

  it("accepts an empty query (returns empty results, no error)", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await authedFetch(jwt, "/api/search", {
      method: "POST",
      body: JSON.stringify({ query: "" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/search — cost guard", () => {
  it("returns 429 with rate-limit details once the per-user search cap is exhausted", async () => {
    // Drop the search cap to 1 by mutating the env vars seen by the
    // route. workerd freezes env on boot, so we set them via env mutation
    // before the request — the route reads via readLimits each call.
    const original = env.LLM_DAILY_LIMIT_PER_USER_SEARCH;
    (
      env as unknown as { LLM_DAILY_LIMIT_PER_USER_SEARCH: string }
    ).LLM_DAILY_LIMIT_PER_USER_SEARCH = "1";
    try {
      const jwt = await fixture.mint({ email: "alice@example.com" });

      const first = await authedFetch(jwt, "/api/search", {
        method: "POST",
        body: JSON.stringify({ query: "first" }),
      });
      expect(first.status).toBe(200);

      const second = await authedFetch(jwt, "/api/search", {
        method: "POST",
        body: JSON.stringify({ query: "second" }),
      });
      expect(second.status).toBe(429);
      const body = (await second.json()) as Err;
      expect(body.error.code).toBe("RATE_LIMITED");
      const details = body.error.details as {
        limit: number;
        used: number;
        scope: "user" | "workspace";
        reset_at: string;
      };
      expect(details.limit).toBe(1);
      expect(details.used).toBe(1);
      expect(details.scope).toBe("user");
      expect(typeof details.reset_at).toBe("string");
    } finally {
      (
        env as unknown as { LLM_DAILY_LIMIT_PER_USER_SEARCH: string }
      ).LLM_DAILY_LIMIT_PER_USER_SEARCH = original;
    }
  });
});
