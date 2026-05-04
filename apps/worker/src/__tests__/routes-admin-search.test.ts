// SPDX-License-Identifier: Apache-2.0

// Integration tests for POST /api/_admin/search/reindex. Owner-gated;
// indexer failures are isolated per page (mirrors archive-day's
// failure-isolation pattern from M5).
//
// We mock the two indexer libs (lib/ai-search.js, lib/fts5.js) so the
// route logic can be exercised without depending on the AI Search
// binding or the d1 FTS5 schema. The pages themselves are seeded via
// the same PUT /api/wiki/* path used by the editor.

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";
import { type JwtFixture, makeJwtFixture } from "./__fixtures__/jwt.js";

type IndexerArgs = [unknown, { path: string; title?: string; frontmatter?: unknown; body: string }];
type IndexerImpl = (...args: IndexerArgs) => Promise<void>;

vi.mock("../lib/ai-search.js", () => ({
  upsertPageInAiSearch: vi.fn<IndexerImpl>(async () => {}),
  removePageFromAiSearch: vi.fn<(env: unknown, path: string) => Promise<void>>(async () => {}),
}));

vi.mock("../lib/fts5.js", () => ({
  upsertPageFts5: vi.fn<IndexerImpl>(async () => {}),
  removePageFts5: vi.fn<(env: unknown, path: string) => Promise<void>>(async () => {}),
}));

import { upsertPageInAiSearch as upsertAi } from "../lib/ai-search.js";
import { upsertPageFts5 as upsertFts } from "../lib/fts5.js";

let fixture: JwtFixture;

async function clearWikiKv(): Promise<void> {
  const list = await env.WIKI_KV.list();
  for (const k of list.keys) await env.WIKI_KV.delete(k.name);
}

beforeAll(async () => {
  await applyMigrations();
  fixture = await makeJwtFixture();
});

beforeEach(async () => {
  await resetDb();
  await clearWikiKv();
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
  vi.mocked(upsertAi)
    .mockReset()
    .mockImplementation(async () => {});
  vi.mocked(upsertFts)
    .mockReset()
    .mockImplementation(async () => {});
});

interface Ok<T> {
  ok: true;
  data: T;
}
interface Err {
  ok: false;
  error: { code: string; message: string };
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

async function bootstrapOwner(): Promise<string> {
  const ownerJwt = await fixture.mint({ email: "owner@example.com" });
  await authedFetch(ownerJwt, "/api/me"); // JIT-provisions as owner
  return ownerJwt;
}

async function seedPage(jwt: string, path: string, title: string): Promise<void> {
  const res = await authedFetch(jwt, `/api/wiki${path}`, {
    method: "PUT",
    body: JSON.stringify({
      frontmatter: { ...VALID_FRONTMATTER, title },
      body: `# ${title}\n\nbody for ${title}`,
    }),
  });
  if (res.status !== 200) {
    throw new Error(`seed failed: ${res.status} ${await res.text()}`);
  }
}

describe("POST /api/_admin/search/reindex — auth & ownership", () => {
  it("returns 401 without a JWT", async () => {
    const res = await SELF.fetch("https://api.local/api/_admin/search/reindex", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-owner caller", async () => {
    await bootstrapOwner();
    const intruderJwt = await fixture.mint({ email: "intruder@example.com" });
    await authedFetch(intruderJwt, "/api/me");
    const res = await authedFetch(intruderJwt, "/api/_admin/search/reindex", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Err;
    expect(body.error.code).toBe("FORBIDDEN");
  });
});

describe("POST /api/_admin/search/reindex — happy path", () => {
  it("indexes every seeded page and returns the summary shape", async () => {
    const ownerJwt = await bootstrapOwner();
    await seedPage(ownerJwt, "/concepts/dmarc.md", "DMARC");
    await seedPage(ownerJwt, "/concepts/spf.md", "SPF");

    // Confirm the wiki tree contains exactly the seeded pages — guards
    // against stale state from prior tests in the same file or KV
    // bleed-through. If this is wrong, the indexer counts below would
    // be misleading.
    const tree = await authedFetch(ownerJwt, "/api/wiki-tree");
    const treeBody = (await tree.json()) as Ok<{ paths: string[] }>;
    const expected = ["/wiki/concepts/dmarc.md", "/wiki/concepts/spf.md"];
    expect(treeBody.data.paths).toEqual(expected);

    // PUT /api/wiki/* itself fires the indexer hooks for each seeded
    // page (M6: write-through index sync in the wiki route). Reset
    // between seeding and reindex so the call counts below measure
    // the reindex pass alone.
    vi.mocked(upsertAi).mockClear();
    vi.mocked(upsertFts).mockClear();

    const res = await authedFetch(ownerJwt, "/api/_admin/search/reindex", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Ok<{
      pages_indexed: number;
      errors: { path: string; message: string }[];
    }>;
    expect(body.data.pages_indexed).toBe(expected.length);
    expect(body.data.errors).toEqual([]);
    // Both indexers are called for every seeded page.
    expect(upsertAi).toHaveBeenCalledTimes(expected.length);
    expect(upsertFts).toHaveBeenCalledTimes(expected.length);
  });

  it("is idempotent — running twice produces the same shape with no errors", async () => {
    const ownerJwt = await bootstrapOwner();
    await seedPage(ownerJwt, "/concepts/dmarc.md", "DMARC");

    const first = await authedFetch(ownerJwt, "/api/_admin/search/reindex", { method: "POST" });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Ok<{ pages_indexed: number; errors: unknown[] }>;
    expect(firstBody.data.pages_indexed).toBe(1);
    expect(firstBody.data.errors).toEqual([]);

    const second = await authedFetch(ownerJwt, "/api/_admin/search/reindex", { method: "POST" });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Ok<{ pages_indexed: number; errors: unknown[] }>;
    expect(secondBody.data.pages_indexed).toBe(1);
    expect(secondBody.data.errors).toEqual([]);
  });
});

describe("POST /api/_admin/search/reindex — partial failure tolerance", () => {
  it("continues indexing after a single page's AI Search upsert fails", async () => {
    const ownerJwt = await bootstrapOwner();
    await seedPage(ownerJwt, "/concepts/dmarc.md", "DMARC");
    await seedPage(ownerJwt, "/concepts/spf.md", "SPF");

    vi.mocked(upsertAi).mockImplementation(async (_env, opts) => {
      if (opts.path === "/wiki/concepts/dmarc.md") throw new Error("ai search down");
    });

    const res = await authedFetch(ownerJwt, "/api/_admin/search/reindex", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Ok<{
      pages_indexed: number;
      errors: { path: string; message: string }[];
    }>;
    // Two pages attempted; both still count as indexed since FTS5
    // succeeded for each. The dmarc AI Search failure is reported.
    expect(body.data.pages_indexed).toBe(2);
    expect(body.data.errors).toHaveLength(1);
    const err = body.data.errors[0];
    expect(err?.path).toBe("/wiki/concepts/dmarc.md");
    expect(err?.message).toContain("ai search down");
  });

  it("counts a page as failed when both indexers reject", async () => {
    const ownerJwt = await bootstrapOwner();
    await seedPage(ownerJwt, "/concepts/dmarc.md", "DMARC");

    vi.mocked(upsertAi).mockImplementation(async () => {
      throw new Error("ai down");
    });
    vi.mocked(upsertFts).mockImplementation(async () => {
      throw new Error("fts5 down");
    });

    const res = await authedFetch(ownerJwt, "/api/_admin/search/reindex", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Ok<{
      pages_indexed: number;
      errors: { path: string; message: string }[];
    }>;
    expect(body.data.pages_indexed).toBe(0);
    expect(body.data.errors.length).toBe(2);
  });
});
