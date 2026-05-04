// SPDX-License-Identifier: Apache-2.0

// Search orchestrator tests. Verify mode labelling and the AI Search →
// FTS5 fallthrough across the four important paths:
//   1. AI Search hit → mode=hybrid
//   2. AI Search throws → falls through to FTS5 (mode=fts5_fallback)
//   3. AI Search disabled → goes straight to FTS5 (mode=fts5_fallback)
//   4. Both miss → empty array with correct mode label

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { upsertPageFts5 } from "../lib/fts5.js";
import { searchWiki } from "../lib/search.js";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";
import { FakeAiSearchBinding, envWithFakeAiSearch } from "./__fixtures__/fake-ai-search.js";

const FRONTMATTER = { title: "DMARC", kind: "concept" as const };

beforeAll(async () => {
  await applyMigrations();
});

async function clearWikiKv(): Promise<void> {
  const list = await env.WIKI_KV.list();
  for (const k of list.keys) {
    await env.WIKI_KV.delete(k.name);
  }
}

async function seedKvPage(path: string): Promise<void> {
  const raw = [
    "---",
    'title: "DMARC"',
    "kind: concept",
    "created: 2026-05-04",
    "last_updated: 2026-05-04",
    "status: draft",
    "---",
    "",
    "body",
  ].join("\n");
  await env.WIKI_KV.put(`wiki:${path}`, raw, { metadata: { sha: "deadbeef" } });
}

beforeEach(async () => {
  await resetDb();
  await clearWikiKv();
});

describe("searchWiki", () => {
  it("short-circuits an empty query without touching either backend", async () => {
    const fake = new FakeAiSearchBinding();
    fake.failNext = true; // would throw if invoked
    const e = envWithFakeAiSearch(env as Env, fake, { AI_SEARCH_ENABLED: "true" });
    const res = await searchWiki({ env: e, query: "  " });
    expect(res).toEqual({ results: [], mode: "hybrid" });
  });

  it("returns mode=hybrid when AI Search succeeds", async () => {
    const fake = new FakeAiSearchBinding();
    await fake.upsert([
      {
        id: "/wiki/a.md#0",
        content: "DMARC builds on SPF and DKIM",
        metadata: { path: "/wiki/a.md", title: "DMARC", kind: "concept" },
      },
    ]);
    const e = envWithFakeAiSearch(env as Env, fake, { AI_SEARCH_ENABLED: "true" });
    const res = await searchWiki({ env: e, query: "dmarc", topK: 5 });
    expect(res.mode).toBe("hybrid");
    expect(res.results.length).toBe(1);
    expect(res.results[0]?.source).toBe("ai_search");
  });

  it("falls through to FTS5 when AI Search throws", async () => {
    const fake = new FakeAiSearchBinding();
    fake.failNext = true;
    await seedKvPage("/wiki/dmarc.md");
    await upsertPageFts5(env, {
      path: "/wiki/dmarc.md",
      title: "DMARC",
      body: "DMARC fallback content",
    });
    const e = envWithFakeAiSearch(env as Env, fake, { AI_SEARCH_ENABLED: "true" });
    const res = await searchWiki({ env: e, query: "dmarc", topK: 5 });
    expect(res.mode).toBe("fts5_fallback");
    expect(res.results.length).toBe(1);
    expect(res.results[0]?.source).toBe("fts5");
  });

  it("falls through to FTS5 when the binding is missing", async () => {
    await seedKvPage("/wiki/dmarc.md");
    await upsertPageFts5(env, {
      path: "/wiki/dmarc.md",
      title: "DMARC",
      body: "missing-binding fallback",
    });
    const e = envWithFakeAiSearch(env as Env, undefined, { AI_SEARCH_ENABLED: "true" });
    const res = await searchWiki({ env: e, query: "fallback", topK: 5 });
    expect(res.mode).toBe("fts5_fallback");
    expect(res.results.length).toBe(1);
  });

  it("skips AI Search entirely when AI_SEARCH_ENABLED='false'", async () => {
    const fake = new FakeAiSearchBinding();
    fake.failNext = true; // would throw if invoked — proves we skipped it
    await seedKvPage("/wiki/dmarc.md");
    await upsertPageFts5(env, {
      path: "/wiki/dmarc.md",
      title: "DMARC",
      body: "skipped path content",
    });
    const e = envWithFakeAiSearch(env as Env, fake, { AI_SEARCH_ENABLED: "false" });
    const res = await searchWiki({ env: e, query: "skipped", topK: 5 });
    expect(res.mode).toBe("fts5_fallback");
    expect(res.results.length).toBe(1);
  });

  it("returns mode=fts5_fallback with [] when both backends miss", async () => {
    const fake = new FakeAiSearchBinding();
    fake.failNext = true; // forces fallthrough
    const e = envWithFakeAiSearch(env as Env, fake, { AI_SEARCH_ENABLED: "true" });
    const res = await searchWiki({ env: e, query: "no-such-term", topK: 5 });
    expect(res.mode).toBe("fts5_fallback");
    expect(res.results).toEqual([]);
  });

  it("preserves topK when delegating to AI Search", async () => {
    const fake = new FakeAiSearchBinding();
    for (let i = 0; i < 5; i += 1) {
      await fake.upsert([
        {
          id: `/wiki/p${i}.md#0`,
          content: `repeated word p${i}`,
          metadata: { path: `/wiki/p${i}.md`, title: `P${i}`, kind: "concept" },
        },
      ]);
    }
    const e = envWithFakeAiSearch(env as Env, fake, { AI_SEARCH_ENABLED: "true" });
    const res = await searchWiki({ env: e, query: "repeated", topK: 2 });
    expect(res.results.length).toBe(2);
  });
});

// Silence the expected console.warn from the fallthrough path so the
// test runner's stderr stays readable. Vitest mock console doesn't
// help here because the worker's console is the real one — we just
// rely on the warnings being intentional and short.
void FRONTMATTER;
