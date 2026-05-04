// SPDX-License-Identifier: Apache-2.0

// Integration tests for the wiki HTTP routes. Hits SELF.fetch() so the
// full Hono pipeline (auth middleware → route → error handler →
// ApiResult JSON) is exercised. The KV backend reads/writes against
// the miniflare-hosted WIKI_KV namespace; cleanup runs in beforeEach.

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";
import { type JwtFixture, makeJwtFixture } from "./__fixtures__/jwt.js";

let fixture: JwtFixture;

async function clearWikiKv(): Promise<void> {
  const list = await env.WIKI_KV.list();
  for (const k of list.keys) {
    await env.WIKI_KV.delete(k.name);
  }
}

beforeAll(async () => {
  await applyMigrations();
  fixture = await makeJwtFixture();
});

beforeEach(async () => {
  await resetDb();
  await clearWikiKv();
  // vitest-pool-workers' default isolatedStorage rolls back KV state
  // between tests, so JWKS goes with it. Re-seed in beforeEach so the
  // auth middleware always finds the public key.
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

interface Ok<T> {
  ok: true;
  data: T;
}

interface Err {
  ok: false;
  error: { code: string; message: string };
}

interface PagePayload {
  path: string;
  frontmatter: { title: string; kind: string; status: string };
  body: string;
  sha: string;
}

const VALID_FRONTMATTER = {
  title: "DMARC",
  kind: "concept",
  created: "2026-05-04",
  last_updated: "2026-05-04",
  status: "draft",
};

async function authedFetch(jwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("CF-Access-Jwt-Assertion", jwt);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return SELF.fetch(`https://api.local${path}`, { ...init, headers });
}

async function asJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  return JSON.parse(text) as T;
}

describe("GET /api/wiki-tree", () => {
  it("returns an empty list for a fresh workspace", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await authedFetch(jwt, "/api/wiki-tree");
    expect(res.status).toBe(200);
    const body = await asJson<Ok<{ paths: string[] }>>(res);
    expect(body.data.paths).toEqual([]);
  });

  it("returns the alphabetically-sorted set of wiki paths", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    // Seed three pages directly via the PUT route so this also acts as
    // a quick PUT happy-path smoke test.
    await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({ frontmatter: VALID_FRONTMATTER, body: "**DMARC**" }),
    });
    await authedFetch(jwt, "/api/wiki/_index.md", {
      method: "PUT",
      body: JSON.stringify({
        frontmatter: { ...VALID_FRONTMATTER, title: "Index", kind: "concept" },
        body: "Welcome",
      }),
    });
    const res = await authedFetch(jwt, "/api/wiki-tree");
    const body = await asJson<Ok<{ paths: string[] }>>(res);
    expect(body.data.paths).toEqual(["/wiki/_index.md", "/wiki/concepts/dmarc.md"]);
  });
});

describe("GET /api/wiki/*", () => {
  it("returns 404 for a missing page", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await authedFetch(jwt, "/api/wiki/nothing.md");
    expect(res.status).toBe(404);
    const body = await asJson<Err>(res);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for an invalid path (uppercase)", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await authedFetch(jwt, "/api/wiki/DMARC.md");
    expect(res.status).toBe(400);
    const body = await asJson<Err>(res);
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("round-trips a created page", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({ frontmatter: VALID_FRONTMATTER, body: "**DMARC**" }),
    });
    const res = await authedFetch(jwt, "/api/wiki/concepts/dmarc.md");
    expect(res.status).toBe(200);
    const body = await asJson<Ok<{ page: PagePayload }>>(res);
    expect(body.data.page.path).toBe("/wiki/concepts/dmarc.md");
    // gray-matter normalizes the body to end with a single newline on
    // stringify; round-tripping preserves that.
    expect(body.data.page.body.trim()).toBe("**DMARC**");
    expect(body.data.page.frontmatter.title).toBe("DMARC");
    expect(body.data.page.sha).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("PUT /api/wiki/*", () => {
  it("creates a new page when no before_sha is supplied", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await authedFetch(jwt, "/api/wiki/concepts/spf.md", {
      method: "PUT",
      body: JSON.stringify({
        frontmatter: { ...VALID_FRONTMATTER, title: "SPF" },
        body: "SPF page",
      }),
    });
    expect(res.status).toBe(200);
    const body = await asJson<Ok<{ page: PagePayload }>>(res);
    expect(body.data.page.body).toBe("SPF page");
  });

  it("updates an existing page when before_sha matches", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const create = await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({ frontmatter: VALID_FRONTMATTER, body: "first" }),
    });
    const created = await asJson<Ok<{ page: PagePayload }>>(create);

    const update = await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({
        frontmatter: VALID_FRONTMATTER,
        body: "second",
        before_sha: created.data.page.sha,
      }),
    });
    expect(update.status).toBe(200);
    const updated = await asJson<Ok<{ page: PagePayload }>>(update);
    expect(updated.data.page.body).toBe("second");
    expect(updated.data.page.sha).not.toBe(created.data.page.sha);
  });

  it("returns 409 with a merge payload when before_sha is stale", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const create = await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({ frontmatter: VALID_FRONTMATTER, body: "first" }),
    });
    const created = await asJson<Ok<{ page: PagePayload }>>(create);

    // Save a second time so the SHA advances.
    await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({
        frontmatter: VALID_FRONTMATTER,
        body: "incoming",
        before_sha: created.data.page.sha,
      }),
    });

    // Stale write using the original SHA.
    const conflict = await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({
        frontmatter: VALID_FRONTMATTER,
        body: "local",
        before_sha: created.data.page.sha,
      }),
    });
    expect(conflict.status).toBe(409);
    const body = await asJson<{
      ok: false;
      error: { code: string; message: string };
    }>(conflict);
    expect(body.error.code).toBe("CONFLICT");
  });

  it("rejects a body that exceeds the 64 KB cap", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const big = "a".repeat(64 * 1024 + 1);
    const res = await authedFetch(jwt, "/api/wiki/concepts/big.md", {
      method: "PUT",
      body: JSON.stringify({ frontmatter: VALID_FRONTMATTER, body: big }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed frontmatter", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await authedFetch(jwt, "/api/wiki/concepts/bad.md", {
      method: "PUT",
      body: JSON.stringify({
        frontmatter: { ...VALID_FRONTMATTER, kind: "garbage" },
        body: "ok",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/wiki/*", () => {
  it("deletes a page (workspace owner)", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({ frontmatter: VALID_FRONTMATTER, body: "x" }),
    });
    const del = await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", { method: "DELETE" });
    expect(del.status).toBe(200);
    const followup = await authedFetch(jwt, "/api/wiki/concepts/dmarc.md");
    expect(followup.status).toBe(404);
  });

  it("forbids non-owner deletion", async () => {
    const ownerJwt = await fixture.mint({ email: "alice@example.com" });
    // First call provisions Alice as workspace owner.
    await authedFetch(ownerJwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({ frontmatter: VALID_FRONTMATTER, body: "x" }),
    });
    const otherJwt = await fixture.mint({ email: "bob@example.com" });
    const del = await authedFetch(otherJwt, "/api/wiki/concepts/dmarc.md", {
      method: "DELETE",
    });
    expect(del.status).toBe(403);
  });

  it("delete is idempotent on missing pages", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await authedFetch(jwt, "/api/wiki/missing.md", { method: "DELETE" });
    expect(res.status).toBe(200);
  });
});

describe("PUT /api/wiki/* — raw shape (merge dialog resolve)", () => {
  it("accepts a YAML-fenced raw payload and persists it", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    // First create the page so we have a SHA to use as before_sha.
    const created = await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({ frontmatter: VALID_FRONTMATTER, body: "first" }),
    });
    const { data } = await asJson<Ok<{ page: PagePayload }>>(created);

    const yaml = [
      "---",
      'title: "Resolved DMARC"',
      "kind: concept",
      "created: 2026-05-04",
      "last_updated: 2026-05-04",
      "status: published",
      "---",
      "",
      "merged body",
    ].join("\n");

    const res = await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({ raw: yaml, before_sha: data.page.sha }),
    });
    expect(res.status).toBe(200);
    const updated = await asJson<Ok<{ page: PagePayload }>>(res);
    expect(updated.data.page.frontmatter.title).toBe("Resolved DMARC");
    expect(updated.data.page.frontmatter.status).toBe("published");
    expect(updated.data.page.body.trim()).toBe("merged body");
  });

  it("rejects malformed YAML in raw with VALIDATION_FAILED", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const create = await authedFetch(jwt, "/api/wiki/concepts/x.md", {
      method: "PUT",
      body: JSON.stringify({ frontmatter: VALID_FRONTMATTER, body: "x" }),
    });
    const { data } = await asJson<Ok<{ page: PagePayload }>>(create);

    const bad =
      "---\ntitle: ok\nkind: not-a-real-kind\ncreated: 2026-05-04\nlast_updated: 2026-05-04\nstatus: draft\n---\nbody";
    const res = await authedFetch(jwt, "/api/wiki/concepts/x.md", {
      method: "PUT",
      body: JSON.stringify({ raw: bad, before_sha: data.page.sha }),
    });
    expect(res.status).toBe(400);
    const body = await asJson<Err>(res);
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("admin route gating", () => {
  it("forbids non-owner from minting a vault token", async () => {
    // First call by Alice provisions her as workspace owner.
    const ownerJwt = await fixture.mint({ email: "alice@example.com" });
    await authedFetch(ownerJwt, "/api/me");

    const otherJwt = await fixture.mint({ email: "bob@example.com" });
    const res = await authedFetch(otherJwt, "/api/_admin/wiki/vault-token", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    const body = await asJson<Err>(res);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("forbids non-owner from running bootstrap", async () => {
    const ownerJwt = await fixture.mint({ email: "alice@example.com" });
    await authedFetch(ownerJwt, "/api/me");

    const otherJwt = await fixture.mint({ email: "bob@example.com" });
    const res = await authedFetch(otherJwt, "/api/_admin/wiki/bootstrap-vault", {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });
});

describe("auth gating", () => {
  it("rejects unauthenticated wiki-tree", async () => {
    const res = await SELF.fetch("https://api.local/api/wiki-tree");
    expect(res.status).toBe(401);
  });
});
