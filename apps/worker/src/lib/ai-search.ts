// SPDX-License-Identifier: Apache-2.0

// Typed wrapper around the optional Cloudflare AI Search Workers
// binding (`env.AI_SEARCH`). Three responsibilities:
//
//   1. queryAiSearch — run a hybrid (BM25 + vector) search and map the
//      raw `AiSearchMatch[]` into our `WikiSearchResult[]` shape.
//   2. upsertPageInAiSearch — chunk a wiki page by section and push one
//      doc per chunk, with stable ids so re-upserts replace cleanly.
//   3. removePageFromAiSearch — delete every chunk-id known to belong
//      to a page. The binding has no "delete by prefix" so we delete a
//      bounded fan-out (CHUNK_DELETE_MAX) per call. Documented below.
//
// Sentinel error: when the binding is missing, disabled, or throws,
// every entry point throws `LoomwikiError("AI_SEARCH_UNAVAILABLE", ...)`.
// The literal "AI_SEARCH_UNAVAILABLE" is intentionally NOT in
// packages/shared `ErrorCodes` — it's an internal sentinel the search
// orchestrator (lib/search.ts) catches to fall through to FTS5. Users
// never see it on the wire.

import type { WikiPageFrontmatter, WikiSearchResult } from "@loomwiki/schema";
import { LoomwikiError, chunkPageBySection } from "@loomwiki/shared";
import type { AiSearchBinding, AiSearchMatch, AiSearchUpsertDoc } from "../ai-search-binding.js";
import type { Env } from "../env.js";

/** Internal sentinel — not part of the public ErrorCodes union. */
const AI_SEARCH_UNAVAILABLE = "AI_SEARCH_UNAVAILABLE";

// Snippet cap for results. AI Search returns up to its own configured
// chunk size; we trim to keep payloads small in the API response.
const SNIPPET_MAX_CHARS = 280;

// Upper bound on chunks-per-page that `removePageFromAiSearch` will
// attempt to delete. The binding has no "delete by prefix" surface, so
// we fan out `id = path#0..path#N` deletes. 64 is well above the
// realistic chunk count for a 64 KB page (typical: 2–10 chunks). If a
// page ever exceeds this, the orphan chunks linger until the next
// upsert overwrites them or an admin reindex sweeps. Recorded as a
// known-limitation tradeoff for v0.0.1.
const CHUNK_DELETE_MAX = 64;

interface UnavailableOpts {
  cause?: unknown;
}

function unavailable(message: string, opts: UnavailableOpts = {}): LoomwikiError {
  return new LoomwikiError(AI_SEARCH_UNAVAILABLE, message, { status: 503, cause: opts.cause });
}

function bindingOrThrow(env: Env): AiSearchBinding {
  if (env.AI_SEARCH_ENABLED === "false") {
    throw unavailable("AI Search disabled via AI_SEARCH_ENABLED=false");
  }
  if (!env.AI_SEARCH) {
    throw unavailable("AI Search binding not configured");
  }
  return env.AI_SEARCH;
}

export interface QueryAiSearchOptions {
  query: string;
  topK?: number;
}

export async function queryAiSearch(
  env: Env,
  opts: QueryAiSearchOptions,
): Promise<WikiSearchResult[]> {
  const binding = bindingOrThrow(env);
  const trimmed = opts.query.trim();
  if (trimmed.length === 0) return [];

  let result: { matches: AiSearchMatch[] };
  try {
    result = await binding.search({ query: trimmed, topK: opts.topK });
  } catch (cause) {
    throw unavailable("AI Search query failed", { cause });
  }

  const out: WikiSearchResult[] = [];
  for (const match of result.matches) {
    const mapped = mapMatch(match);
    if (mapped) out.push(mapped);
  }
  return out;
}

function mapMatch(match: AiSearchMatch): WikiSearchResult | null {
  const md = match.metadata ?? {};
  const path = typeof md.path === "string" ? md.path : null;
  const title = typeof md.title === "string" ? md.title : null;
  const kind = typeof md.kind === "string" ? md.kind : null;
  if (!path || !title || !kind) return null;
  // Keep the kind union narrow at the boundary. If AI Search ever
  // returns a kind we don't recognize the orchestrator's response
  // parse (Zod) would fail; coerce to "concept" as a safe default
  // since "concept" is permissive on the editor side.
  const safeKind = isKnownKind(kind) ? kind : "concept";
  const snippet = (match.content ?? "").slice(0, SNIPPET_MAX_CHARS);
  // Surface the chunk's heading so /ask citations can build
  // /w/<path>#<slug>. Empty-string headings are treated as null (the
  // upserter writes `heading: chunk.heading ?? undefined`, so an empty
  // string would be a misconfigured indexer; coerce defensively).
  const heading = typeof md.heading === "string" && md.heading.length > 0 ? md.heading : null;
  return {
    path,
    title,
    kind: safeKind,
    snippet,
    score: match.score,
    source: "ai_search",
    heading,
  };
}

const KNOWN_KINDS = new Set(["entity", "decision", "concept", "open-question", "glossary"]);
function isKnownKind(value: string): value is WikiSearchResult["kind"] {
  return KNOWN_KINDS.has(value);
}

export interface UpsertPageInAiSearchInput {
  path: string;
  frontmatter: Pick<WikiPageFrontmatter, "title" | "kind">;
  body: string;
}

export async function upsertPageInAiSearch(
  env: Env,
  input: UpsertPageInAiSearchInput,
): Promise<void> {
  const binding = bindingOrThrow(env);
  const chunks = chunkPageBySection(input.body, {
    path: input.path,
    title: input.frontmatter.title,
    kind: input.frontmatter.kind,
  });
  // A page that chunks to nothing (empty body) still needs the path
  // removed from the index so a page that used to have content but
  // was emptied stops appearing in search results. Issue a bounded
  // delete sweep instead of an upsert.
  if (chunks.length === 0) {
    await removePageFromAiSearch(env, input.path);
    return;
  }

  const docs: AiSearchUpsertDoc[] = chunks.map((chunk, index) => ({
    id: `${input.path}#${index}`,
    content: chunk.body,
    metadata: {
      path: chunk.path,
      title: chunk.title,
      kind: chunk.kind,
      heading: chunk.heading ?? undefined,
      section_path: chunk.sectionPath,
    },
  }));

  try {
    await binding.upsert(docs);
  } catch (cause) {
    throw unavailable("AI Search upsert failed", { cause });
  }

  // After an upsert, sweep any *trailing* chunk ids from a previous,
  // longer version of the page so stale chunks don't linger. This is
  // bounded by CHUNK_DELETE_MAX; pages that shrink past that bound are
  // covered on the next admin reindex.
  if (chunks.length < CHUNK_DELETE_MAX) {
    const stale: string[] = [];
    for (let i = chunks.length; i < CHUNK_DELETE_MAX; i += 1) {
      stale.push(`${input.path}#${i}`);
    }
    try {
      await binding.delete(stale);
    } catch {
      // Sweep failure is non-fatal — the upsert succeeded; stale
      // chunks at most show up as low-score noise until the next edit.
    }
  }
}

export async function removePageFromAiSearch(env: Env, path: string): Promise<void> {
  const binding = bindingOrThrow(env);
  const ids: string[] = [];
  for (let i = 0; i < CHUNK_DELETE_MAX; i += 1) {
    ids.push(`${path}#${i}`);
  }
  try {
    await binding.delete(ids);
  } catch (cause) {
    throw unavailable("AI Search delete failed", { cause });
  }
}
