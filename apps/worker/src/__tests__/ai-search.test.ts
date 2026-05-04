// SPDX-License-Identifier: Apache-2.0

// Unit tests for the AI Search wrapper. Uses the in-memory fake binding
// (see __fixtures__/fake-ai-search.ts) so the call surface — id
// stability for chunked upserts, metadata round-trip, and the "throw
// AI_SEARCH_UNAVAILABLE" sentinel paths — is exercised without the
// remote-only AI Search service.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { queryAiSearch, removePageFromAiSearch, upsertPageInAiSearch } from "../lib/ai-search.js";
import { FakeAiSearchBinding } from "./__fixtures__/fake-ai-search.js";

function envWith(overrides: Partial<Env>): Env {
  return { ...env, ...overrides } as Env;
}

const FRONTMATTER = { title: "DMARC", kind: "concept" as const };

describe("ai-search availability sentinel", () => {
  it("throws AI_SEARCH_UNAVAILABLE when the binding is missing", async () => {
    const e = envWith({ AI_SEARCH: undefined, AI_SEARCH_ENABLED: "true" });
    await expect(queryAiSearch(e, { query: "x" })).rejects.toMatchObject({
      code: "AI_SEARCH_UNAVAILABLE",
    });
  });

  it("throws AI_SEARCH_UNAVAILABLE when AI_SEARCH_ENABLED is 'false' (even if binding present)", async () => {
    const fake = new FakeAiSearchBinding();
    const e = envWith({ AI_SEARCH: fake, AI_SEARCH_ENABLED: "false" });
    await expect(queryAiSearch(e, { query: "x" })).rejects.toMatchObject({
      code: "AI_SEARCH_UNAVAILABLE",
    });
  });

  it("wraps a binding throw as AI_SEARCH_UNAVAILABLE", async () => {
    const fake = new FakeAiSearchBinding();
    fake.failNext = true;
    const e = envWith({ AI_SEARCH: fake, AI_SEARCH_ENABLED: "true" });
    await expect(queryAiSearch(e, { query: "anything" })).rejects.toMatchObject({
      code: "AI_SEARCH_UNAVAILABLE",
    });
  });
});

describe("upsertPageInAiSearch", () => {
  it("chunks a multi-section page into one doc per section with stable ids", async () => {
    const fake = new FakeAiSearchBinding();
    const e = envWith({ AI_SEARCH: fake, AI_SEARCH_ENABLED: "true" });

    const body = [
      "# Top",
      "",
      "Intro paragraph for the page.",
      "",
      "## Authentication",
      "",
      "DMARC builds on SPF and DKIM.",
      "",
      "## Reporting",
      "",
      "Aggregate (rua) and forensic (ruf) report types.",
    ].join("\n");

    await upsertPageInAiSearch(e, {
      path: "/wiki/concepts/dmarc.md",
      frontmatter: FRONTMATTER,
      body,
    });

    // Top + Authentication + Reporting = 3 chunks (no prelude — body
    // starts with an H1, prelude is empty).
    const docs = [...fake.docs.values()];
    expect(docs.length).toBe(3);
    const ids = docs.map((d) => d.id).sort();
    expect(ids).toEqual([
      "/wiki/concepts/dmarc.md#0",
      "/wiki/concepts/dmarc.md#1",
      "/wiki/concepts/dmarc.md#2",
    ]);

    // Re-upsert with one fewer section — id #0 stays put, the trailing
    // chunks should be swept on the next sync.
    const trimmed = ["# Top", "", "just the prelude"].join("\n");
    await upsertPageInAiSearch(e, {
      path: "/wiki/concepts/dmarc.md",
      frontmatter: FRONTMATTER,
      body: trimmed,
    });
    expect(fake.docs.has("/wiki/concepts/dmarc.md#0")).toBe(true);
    expect(fake.docs.has("/wiki/concepts/dmarc.md#1")).toBe(false);
    expect(fake.docs.has("/wiki/concepts/dmarc.md#2")).toBe(false);
  });

  it("removes the page when the body chunks to nothing", async () => {
    const fake = new FakeAiSearchBinding();
    const e = envWith({ AI_SEARCH: fake, AI_SEARCH_ENABLED: "true" });
    await upsertPageInAiSearch(e, {
      path: "/wiki/x.md",
      frontmatter: FRONTMATTER,
      body: "real body",
    });
    expect(fake.docs.size).toBeGreaterThan(0);

    await upsertPageInAiSearch(e, {
      path: "/wiki/x.md",
      frontmatter: FRONTMATTER,
      body: "   ", // chunks to nothing
    });
    expect([...fake.docs.keys()].some((k) => k.startsWith("/wiki/x.md"))).toBe(false);
  });
});

describe("queryAiSearch result mapping", () => {
  it("maps AiSearchMatch records into WikiSearchResult with required fields populated", async () => {
    const fake = new FakeAiSearchBinding();
    const e = envWith({ AI_SEARCH: fake, AI_SEARCH_ENABLED: "true" });
    await upsertPageInAiSearch(e, {
      path: "/wiki/concepts/dmarc.md",
      frontmatter: FRONTMATTER,
      body: "# DMARC\n\nDomain Message Authentication Reporting & Conformance.",
    });

    const results = await queryAiSearch(e, { query: "dmarc", topK: 5 });
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    expect(top).toBeDefined();
    if (!top) return;
    expect(top.path).toBe("/wiki/concepts/dmarc.md");
    expect(top.title).toBe("DMARC");
    expect(top.kind).toBe("concept");
    expect(top.source).toBe("ai_search");
    expect(typeof top.score).toBe("number");
    expect(top.snippet.length).toBeGreaterThan(0);
    expect(top.snippet.length).toBeLessThanOrEqual(280);
  });

  it("returns [] for an empty query without calling the binding", async () => {
    const fake = new FakeAiSearchBinding();
    fake.failNext = true; // would throw if invoked
    const e = envWith({ AI_SEARCH: fake, AI_SEARCH_ENABLED: "true" });
    const results = await queryAiSearch(e, { query: "  " });
    expect(results).toEqual([]);
  });

  it("drops matches missing required metadata fields", async () => {
    const fake = new FakeAiSearchBinding();
    // Push a doc directly with no metadata; should be filtered out.
    await fake.upsert([{ id: "raw-1", content: "loose payload" }]);
    const e = envWith({ AI_SEARCH: fake, AI_SEARCH_ENABLED: "true" });
    const results = await queryAiSearch(e, { query: "loose" });
    expect(results).toEqual([]);
  });
});

describe("removePageFromAiSearch", () => {
  it("issues a bounded fan-out delete that removes every chunk for a path", async () => {
    const fake = new FakeAiSearchBinding();
    const e = envWith({ AI_SEARCH: fake, AI_SEARCH_ENABLED: "true" });
    await upsertPageInAiSearch(e, {
      path: "/wiki/a.md",
      frontmatter: FRONTMATTER,
      body: "# A\n\none\n\n## B\n\ntwo",
    });
    await upsertPageInAiSearch(e, {
      path: "/wiki/b.md",
      frontmatter: FRONTMATTER,
      body: "# B\n\nbody",
    });
    expect(fake.docs.size).toBeGreaterThan(0);

    await removePageFromAiSearch(e, "/wiki/a.md");
    for (const id of fake.docs.keys()) {
      expect(id.startsWith("/wiki/a.md")).toBe(false);
    }
    // /wiki/b.md untouched.
    expect([...fake.docs.keys()].some((k) => k.startsWith("/wiki/b.md"))).toBe(true);
  });

  it("throws AI_SEARCH_UNAVAILABLE when the underlying delete throws", async () => {
    const fake = new FakeAiSearchBinding();
    fake.failNext = true;
    const e = envWith({ AI_SEARCH: fake, AI_SEARCH_ENABLED: "true" });
    await expect(removePageFromAiSearch(e, "/wiki/x.md")).rejects.toMatchObject({
      code: "AI_SEARCH_UNAVAILABLE",
    });
  });
});
