// SPDX-License-Identifier: Apache-2.0

// Retrieval-Augmented Generation entry point. Backs `/api/ask`.
//
// Flow:
//   1. Run searchWiki() over the question to retrieve top-K chunks.
//   2. If nothing came back, return a deterministic "no context" reply
//      as a single-chunk stream (no LLM call) and an empty citation
//      list. The cost-guard counter has already been incremented at
//      the route layer; we do NOT roll it back — incrementing per
//      attempt (vs per actual LLM call) is the simpler, more abuse-
//      resistant accounting model. Documented in cost-guard.ts.
//   3. Otherwise, build a tightly bounded prompt — system message
//      forbids fabrication and demands citations by `path`, user
//      message carries the question plus per-chunk truncated context
//      (2000 chars/chunk × topK chunks = ~10 KB ceiling at topK=5).
//   4. Call chatStream() and yield delta strings only; the route layer
//      adds the SSE framing (`event: delta\ndata: ...`).
//
// Citations:
//   - Deduped by path, preserving original (rank) order.
//   - heading_slug is best-effort: AI Search results carry a `heading`
//     field in metadata when the chunk was a section, FTS5 results
//     don't (the index is row-per-page). When we can't infer a slug
//     we leave it null — the route layer / web client renders the
//     citation without an in-page anchor.

import type { AskCitation, WikiSearchResponse, WikiSearchResult } from "@loomwiki/schema";
import { slugifyHeading } from "@loomwiki/shared";
import type { Env } from "../env.js";
import { chatStream } from "./llm.js";
import { searchWiki } from "./search.js";

const NO_CONTEXT_MESSAGE = "I don't have enough context yet — try creating some wiki pages first.";

const SYSTEM_PROMPT =
  "Answer using only the provided context. If the context is insufficient, say so. " +
  "Never fabricate facts. Cite sources by their path field.";

// Per-chunk character cap for the prompt context block. Keeps the
// total user message under ~10 KB at the default topK=5 so we stay
// well inside Workers AI default token windows even on the smaller
// catalog models.
const PER_CHUNK_CHARS = 2000;

export interface AskWithRagOptions {
  env: Env;
  question: string;
  topK?: number;
  workspaceId?: string;
}

export interface AskWithRagResult {
  searchResults: WikiSearchResult[];
  citations: AskCitation[];
  stream: AsyncIterable<string>;
  meta: { mode: WikiSearchResponse["mode"]; model?: string };
}

export async function askWithRag(opts: AskWithRagOptions): Promise<AskWithRagResult> {
  const topK = opts.topK ?? 5;
  const search = await searchWiki({ env: opts.env, query: opts.question, topK });

  if (search.results.length === 0) {
    return {
      searchResults: [],
      citations: [],
      stream: singleMessageStream(NO_CONTEXT_MESSAGE),
      meta: { mode: search.mode },
    };
  }

  const userPrompt = buildUserPrompt(opts.question, search.results);
  const citations = buildCitations(search.results);

  const stream = deltaStream(
    chatStream({
      env: opts.env,
      prompt: userPrompt,
      system: SYSTEM_PROMPT,
      workspaceId: opts.workspaceId,
    }),
  );

  return {
    searchResults: search.results,
    citations,
    stream,
    meta: { mode: search.mode },
  };
}

function buildUserPrompt(question: string, chunks: WikiSearchResult[]): string {
  const ctx = chunks
    .map((c) => `### ${c.path}\n${truncate(c.snippet, PER_CHUNK_CHARS)}`)
    .join("\n\n");
  return `${question}\n\n## Context\n\n${ctx}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function buildCitations(results: WikiSearchResult[]): AskCitation[] {
  const seen = new Set<string>();
  const out: AskCitation[] = [];
  for (const r of results) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    out.push({
      path: r.path,
      title: r.title,
      kind: r.kind,
      heading_slug: deriveHeadingSlug(r),
    });
  }
  return out;
}

// Heading slug derivation. AI Search results carry the matched
// chunk's H1/H2 heading on `result.heading` (populated from chunk
// metadata by lib/ai-search.ts); FTS5 results don't (the index is
// row-per-page). The web citation pill builds /w/<path>#<slug> only
// when this returns non-null.
function deriveHeadingSlug(result: WikiSearchResult): string | null {
  if (typeof result.heading !== "string" || result.heading.length === 0) return null;
  const slug = slugifyHeading(result.heading);
  return slug.length > 0 ? slug : null;
}

async function* singleMessageStream(message: string): AsyncIterable<string> {
  yield message;
}

async function* deltaStream(
  upstream: AsyncIterable<{ delta: string; done: boolean }>,
): AsyncIterable<string> {
  for await (const chunk of upstream) {
    if (chunk.done) continue;
    if (chunk.delta.length === 0) continue;
    yield chunk.delta;
  }
}
