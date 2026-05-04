// SPDX-License-Identifier: Apache-2.0

// Integration tests for the D1 FTS5 search fallback. Hits the real
// wiki_pages_fts virtual table created by migration 0002 against the
// miniflare-backed D1; reads back through searchFts5 to verify
// ranking, snippet markup, and deletion semantics.
//
// `kind` is resolved by reading the page from the wiki backend (KV),
// so each test seeds both surfaces.

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { removePageFts5, searchFts5, upsertPageFts5 } from "../lib/fts5.js";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";

beforeAll(async () => {
  await applyMigrations();
});

async function clearWikiKv(): Promise<void> {
  const list = await env.WIKI_KV.list();
  for (const k of list.keys) {
    await env.WIKI_KV.delete(k.name);
  }
}

async function seedKvPage(path: string, kind: string, body = "body"): Promise<void> {
  // The kind resolver round-trips through deserializePage, which
  // requires a YAML frontmatter block. Build a minimal valid page.
  const raw = [
    "---",
    'title: "Test"',
    `kind: ${kind}`,
    "created: 2026-05-04",
    "last_updated: 2026-05-04",
    "status: draft",
    "---",
    "",
    body,
  ].join("\n");
  await env.WIKI_KV.put(`wiki:${path}`, raw, { metadata: { sha: "deadbeef" } });
}

beforeEach(async () => {
  await resetDb();
  await clearWikiKv();
});

describe("upsertPageFts5 + searchFts5", () => {
  it("returns [] for an empty query without touching the index", async () => {
    await upsertPageFts5(env, {
      path: "/wiki/a.md",
      title: "A",
      body: "DMARC content here",
    });
    const empty = await searchFts5(env, "   ", { topK: 5 });
    expect(empty).toEqual([]);
  });

  it("ranks a direct title/body match above an unrelated page", async () => {
    await seedKvPage("/wiki/a.md", "concept");
    await seedKvPage("/wiki/b.md", "concept");
    await upsertPageFts5(env, {
      path: "/wiki/a.md",
      title: "DMARC",
      body: "DMARC builds on SPF and DKIM to authenticate email.",
    });
    await upsertPageFts5(env, {
      path: "/wiki/b.md",
      title: "Coffee Notes",
      body: "Yesterday I had a cortado.",
    });
    const results = await searchFts5(env, "dmarc", { topK: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toBeDefined();
    expect(results[0]?.path).toBe("/wiki/a.md");
    expect(results[0]?.source).toBe("fts5");
    expect(results[0]?.kind).toBe("concept");
  });

  it("emits snippets containing the configured <mark> markup", async () => {
    await seedKvPage("/wiki/a.md", "concept");
    await upsertPageFts5(env, {
      path: "/wiki/a.md",
      title: "DMARC",
      body: "DMARC stands for Domain-based Message Authentication.",
    });
    const results = await searchFts5(env, "domain", { topK: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.snippet).toMatch(/<mark>/);
    expect(results[0]?.snippet).toMatch(/<\/mark>/);
  });

  it("re-upserting a page replaces the previous row (no duplicates)", async () => {
    await seedKvPage("/wiki/a.md", "concept");
    await upsertPageFts5(env, {
      path: "/wiki/a.md",
      title: "Old",
      body: "old content uniquething",
    });
    await upsertPageFts5(env, {
      path: "/wiki/a.md",
      title: "New",
      body: "new content uniquething",
    });
    const results = await searchFts5(env, "uniquething", { topK: 5 });
    expect(results.length).toBe(1);
    expect(results[0]?.title).toBe("New");
  });

  it("falls back to kind='concept' when the backing page is missing", async () => {
    await upsertPageFts5(env, {
      path: "/wiki/orphan.md",
      title: "Orphan",
      body: "just an orphan page in the index",
    });
    const results = await searchFts5(env, "orphan", { topK: 5 });
    expect(results.length).toBe(1);
    expect(results[0]?.kind).toBe("concept");
  });

  it("respects topK by limiting result count", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedKvPage(`/wiki/page${i}.md`, "concept");
      await upsertPageFts5(env, {
        path: `/wiki/page${i}.md`,
        title: `P${i}`,
        body: "common term cake",
      });
    }
    const results = await searchFts5(env, "cake", { topK: 2 });
    expect(results.length).toBe(2);
  });

  it("returns kind from the backing page frontmatter when set to a non-concept value", async () => {
    await seedKvPage("/wiki/dec.md", "decision");
    await upsertPageFts5(env, {
      path: "/wiki/dec.md",
      title: "Adopt DMARC",
      body: "We will adopt DMARC sandbox.",
    });
    const results = await searchFts5(env, "sandbox", { topK: 5 });
    expect(results[0]?.kind).toBe("decision");
  });
});

describe("removePageFts5", () => {
  it("removes a page from the index so it stops appearing in searches", async () => {
    await seedKvPage("/wiki/a.md", "concept");
    await upsertPageFts5(env, {
      path: "/wiki/a.md",
      title: "A",
      body: "uniquephrase here",
    });
    expect((await searchFts5(env, "uniquephrase")).length).toBe(1);
    await removePageFts5(env, "/wiki/a.md");
    expect(await searchFts5(env, "uniquephrase")).toEqual([]);
  });

  it("is a no-op for a path that's not indexed", async () => {
    await removePageFts5(env, "/wiki/missing.md");
    expect(await searchFts5(env, "missing")).toEqual([]);
  });
});

describe("FTS5 query sanitization", () => {
  it("does not throw on quotes, parens, or operator-like inputs", async () => {
    await seedKvPage("/wiki/a.md", "concept");
    await upsertPageFts5(env, {
      path: "/wiki/a.md",
      title: "Notes",
      body: "we discussed AND/OR semantics in detail.",
    });
    // None of these should error — sanitizer wraps in a phrase.
    const cases = ['foo "unbalanced', "foo (bar", "title:dmarc", "AND OR NOT", "*prefix"];
    for (const q of cases) {
      await expect(searchFts5(env, q, { topK: 5 })).resolves.toBeDefined();
    }
  });
});
