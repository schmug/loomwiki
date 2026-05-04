// SPDX-License-Identifier: Apache-2.0

// Tests for askWithRag — the retrieval-augmented generation entry
// point. Verifies:
//   - No-results → returns the canned "no context yet" stream and an
//     empty citation list (no LLM call).
//   - Happy path → builds prompt with truncated chunks, streams deltas
//     out as plain strings, citations dedupe by path.
//   - Per-chunk truncation enforced at PER_CHUNK_CHARS=2000.

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { upsertPageFts5 } from "../lib/fts5.js";
import { askWithRag } from "../lib/rag.js";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";
import { FakeAiSearchBinding, envWithFakeAiSearch } from "./__fixtures__/fake-ai-search.js";

interface FakeAiCall {
  model: string;
  body: { messages: { role: string; content: string }[] };
}

function fakeAiBinding(deltas: string[]): { calls: FakeAiCall[]; binding: Env["AI"] } {
  const calls: FakeAiCall[] = [];
  return {
    calls,
    binding: {
      async run(model: string, body: unknown) {
        calls.push({ model, body: body as FakeAiCall["body"] });
        const encoder = new TextEncoder();
        return new ReadableStream<Uint8Array>({
          start(controller) {
            for (const d of deltas) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: d })}\n\n`));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
      },
    },
  };
}

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

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await resetDb();
  await clearWikiKv();
});

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const c of stream) out += c;
  return out;
}

describe("askWithRag — no context", () => {
  it("returns the canned no-context message and empty citations without invoking the LLM", async () => {
    const ai = fakeAiBinding(["should not be called"]);
    const fakeSearch = new FakeAiSearchBinding();
    fakeSearch.failNext = true; // forces FTS5 fallthrough; D1 is empty too
    const e = envWithFakeAiSearch(env as Env, fakeSearch, {
      AI: ai.binding,
      AI_GATEWAY_ID: "",
      AI_SEARCH_ENABLED: "true",
    });

    const res = await askWithRag({ env: e, question: "what is dmarc?" });
    const text = await collect(res.stream);
    expect(text).toBe("I don't have enough context yet — try creating some wiki pages first.");
    expect(res.citations).toEqual([]);
    expect(ai.calls.length).toBe(0);
  });
});

describe("askWithRag — happy path", () => {
  it("streams LLM deltas and returns deduped citations", async () => {
    const ai = fakeAiBinding(["Hello ", "world"]);
    const fakeSearch = new FakeAiSearchBinding();
    await fakeSearch.upsert([
      {
        id: "/wiki/dmarc.md#0",
        content: "DMARC builds on SPF and DKIM.",
        metadata: { path: "/wiki/dmarc.md", title: "DMARC", kind: "concept" },
      },
      {
        id: "/wiki/dmarc.md#1",
        content: "DMARC reports in aggregate (rua) form.",
        metadata: { path: "/wiki/dmarc.md", title: "DMARC", kind: "concept" },
      },
      {
        id: "/wiki/spf.md#0",
        content: "SPF authenticates the envelope sender.",
        metadata: { path: "/wiki/spf.md", title: "SPF", kind: "concept" },
      },
    ]);
    const e = envWithFakeAiSearch(env as Env, fakeSearch, {
      AI: ai.binding,
      AI_GATEWAY_ID: "",
      AI_SEARCH_ENABLED: "true",
    });

    const res = await askWithRag({ env: e, question: "dmarc spf", topK: 5 });
    const text = await collect(res.stream);
    expect(text).toBe("Hello world");

    // Citations are deduped by path: dmarc appears once even though
    // two chunks of it surfaced.
    expect(res.citations.map((c) => c.path)).toEqual(["/wiki/dmarc.md", "/wiki/spf.md"]);
    expect(res.citations[0]?.heading_slug).toBeNull();

    // The LLM was invoked once with a system + user message.
    expect(ai.calls.length).toBe(1);
    const messages = ai.calls[0]?.body.messages;
    expect(messages?.length).toBe(2);
    expect(messages?.[0]?.role).toBe("system");
    expect(messages?.[0]?.content).toMatch(/Cite sources/);
    expect(messages?.[1]?.role).toBe("user");
    expect(messages?.[1]?.content).toMatch(/dmarc spf/);
    expect(messages?.[1]?.content).toMatch(/## Context/);
  });

  it("truncates per-chunk context to 2000 chars before sending to the LLM", async () => {
    const ai = fakeAiBinding(["ok"]);
    const big = "X".repeat(5000);
    const fakeSearch = new FakeAiSearchBinding();
    // Upsert directly with a long content blob; queryAiSearch caps
    // snippets at 280 chars, so to actually exercise the rag-side
    // truncation we go through FTS5 instead (its snippets can be
    // longer when the body is short and matches early).
    fakeSearch.failNext = true; // force FTS5 path
    await seedKvPage("/wiki/big.md");
    await upsertPageFts5(env, {
      path: "/wiki/big.md",
      title: "Big",
      body: `bigword ${big}`,
    });
    const e = envWithFakeAiSearch(env as Env, fakeSearch, {
      AI: ai.binding,
      AI_GATEWAY_ID: "",
      AI_SEARCH_ENABLED: "true",
    });

    await askWithRag({ env: e, question: "bigword", topK: 5 });
    const userContent = ai.calls[0]?.body.messages[1]?.content ?? "";
    // The per-chunk context block is bounded to 2000 chars + 1 ellipsis
    // marker. The full message also carries headings; check no chunk
    // is longer than 2001 chars between successive `### ` markers.
    const sections = userContent.split(/\n### /).slice(1);
    for (const s of sections) {
      // s starts with `<path>\n<body>...`. Only assert on body length.
      const newlineIdx = s.indexOf("\n");
      const bodyOnly = newlineIdx >= 0 ? s.slice(newlineIdx + 1) : "";
      expect(bodyOnly.length).toBeLessThanOrEqual(2001);
    }
  });

  it("propagates the search mode in meta", async () => {
    const ai = fakeAiBinding(["x"]);
    const fakeSearch = new FakeAiSearchBinding();
    await fakeSearch.upsert([
      {
        id: "/wiki/a.md#0",
        content: "alpha",
        metadata: { path: "/wiki/a.md", title: "A", kind: "concept" },
      },
    ]);
    const e = envWithFakeAiSearch(env as Env, fakeSearch, {
      AI: ai.binding,
      AI_GATEWAY_ID: "",
      AI_SEARCH_ENABLED: "true",
    });
    const res = await askWithRag({ env: e, question: "alpha" });
    await collect(res.stream);
    expect(res.meta.mode).toBe("hybrid");
  });
});
