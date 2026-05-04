// SPDX-License-Identifier: Apache-2.0

// Verifies that the M6 search-index sync hooks fire from the wiki
// PUT/DELETE handlers. We can't reach the real AI Search binding from
// tests (remote-only) and the route uses Promise.allSettled to swallow
// its failure — so we assert end-to-end against the FTS5 index, which
// IS reachable. AI Search coverage lives in ai-search.test.ts.

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { searchFts5 } from "../lib/fts5.js";
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
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

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

describe("wiki PUT → FTS5 index sync", () => {
  it("indexes a newly-created page so searchFts5 finds it", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({
        frontmatter: VALID_FRONTMATTER,
        body: "DMARC builds on SPF and DKIM to authenticate email.",
      }),
    });
    expect(res.status).toBe(200);

    const found = await searchFts5(env, "dmarc", { topK: 5 });
    expect(found.length).toBe(1);
    expect(found[0]?.path).toBe("/wiki/concepts/dmarc.md");
    expect(found[0]?.title).toBe("DMARC");
  });

  it("re-indexes on update (old body terms drop out, new body terms appear)", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const create = await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({
        frontmatter: VALID_FRONTMATTER,
        body: "first version uniqueoldterm here",
      }),
    });
    const created = (await create.json()) as { data: { page: { sha: string } } };

    await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({
        frontmatter: VALID_FRONTMATTER,
        body: "second version uniquenewterm replacement",
        before_sha: created.data.page.sha,
      }),
    });

    expect((await searchFts5(env, "uniqueoldterm")).length).toBe(0);
    const after = await searchFts5(env, "uniquenewterm");
    expect(after.length).toBe(1);
    expect(after[0]?.path).toBe("/wiki/concepts/dmarc.md");
  });
});

describe("wiki DELETE → FTS5 index sync", () => {
  it("removes the page from the FTS5 index after a successful delete", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", {
      method: "PUT",
      body: JSON.stringify({
        frontmatter: VALID_FRONTMATTER,
        body: "deleteme term content",
      }),
    });
    expect((await searchFts5(env, "deleteme")).length).toBe(1);

    const del = await authedFetch(jwt, "/api/wiki/concepts/dmarc.md", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await searchFts5(env, "deleteme")).length).toBe(0);
  });
});
