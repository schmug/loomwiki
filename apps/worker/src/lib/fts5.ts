// SPDX-License-Identifier: Apache-2.0

// D1 FTS5 fallback search over `/wiki/**` pages. Used when AI Search is
// unavailable (binding missing, AI_SEARCH_ENABLED=false, or the binding
// throws). Backed by the `wiki_pages_fts` virtual table created in
// migration 0002 (`tokenize='porter unicode61'`, columns
// `path UNINDEXED, title, body`).
//
// Three operations:
//   - upsertPageFts5: DELETE-then-INSERT (FTS5 has no native UPSERT).
//   - removePageFts5: DELETE by path.
//   - searchFts5: MATCH ? with bm25 ranking and snippet() highlights.
//
// The index intentionally does NOT carry kind. Per-result `kind` is
// resolved by reading the page from the wiki backend (cheap KV read at
// POC scale; pages are small). On miss we fall back to "concept", which
// is the most permissive editor target.
//
// Query sanitization is minimal but defensive: we strip double-quotes
// from the input, then wrap the trimmed query in `"..."` so FTS5 treats
// the whole thing as a single phrase. This avoids surprising operator
// behavior when a user types `foo (bar` or `cat:` — both are valid
// search intents that raw MATCH would error on.

import type { WikiPageKind, WikiSearchResult } from "@loomwiki/schema";
import type { Env } from "../env.js";
import { defaultWikiBackend } from "./vault-bootstrap.js";
import { deserializePage } from "./wiki-content.js";

export interface UpsertPageFts5Input {
  path: string;
  title: string;
  body: string;
}

export async function upsertPageFts5(env: Env, input: UpsertPageFts5Input): Promise<void> {
  // FTS5 doesn't support `INSERT OR REPLACE` because the rowid is
  // implicit, so the cheapest atomic upsert is DELETE + INSERT.
  await env.DB.prepare("DELETE FROM wiki_pages_fts WHERE path = ?").bind(input.path).run();
  await env.DB.prepare("INSERT INTO wiki_pages_fts (path, title, body) VALUES (?, ?, ?)")
    .bind(input.path, input.title, input.body)
    .run();
}

export async function removePageFts5(env: Env, path: string): Promise<void> {
  await env.DB.prepare("DELETE FROM wiki_pages_fts WHERE path = ?").bind(path).run();
}

export interface SearchFts5Options {
  topK?: number;
}

interface Fts5Row {
  path: string;
  title: string;
  snippet: string;
  rank: number;
}

export async function searchFts5(
  env: Env,
  query: string,
  opts: SearchFts5Options = {},
): Promise<WikiSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const sanitized = sanitizeFts5Query(trimmed);
  if (sanitized.length === 0) return [];

  const topK = opts.topK ?? 5;

  // bm25() returns a negative score (more-negative = better). We
  // negate so the result-side `score` field is descending-friendly.
  // snippet() args: column index 2 = body, mark prefix/suffix, ellipsis,
  // 32 tokens of context.
  const stmt = env.DB.prepare(
    `SELECT path, title,
            snippet(wiki_pages_fts, 2, '<mark>', '</mark>', '…', 32) AS snippet,
            bm25(wiki_pages_fts) AS rank
     FROM wiki_pages_fts
     WHERE wiki_pages_fts MATCH ?
     ORDER BY rank ASC
     LIMIT ?`,
  ).bind(sanitized, topK);

  const result = await stmt.all<Fts5Row>();
  const rows = result.results ?? [];

  // Resolve `kind` per result via the wiki backend. POC-scale: at
  // most `topK` reads (default 5). Cache could land in M8 if this
  // becomes a bottleneck, but the backend is KV → microseconds per hit.
  const backend = defaultWikiBackend(env);
  const out: WikiSearchResult[] = [];
  for (const row of rows) {
    const kind = await resolveKind(backend, row.path);
    out.push({
      path: row.path,
      title: row.title,
      kind,
      snippet: row.snippet,
      score: -row.rank,
      source: "fts5",
    });
  }
  return out;
}

async function resolveKind(
  backend: ReturnType<typeof defaultWikiBackend>,
  path: string,
): Promise<WikiPageKind> {
  try {
    const record = await backend.read(path);
    if (!record) return "concept";
    const parsed = await deserializePage(record.raw);
    return parsed.frontmatter.kind;
  } catch {
    // Backend hiccup or malformed frontmatter — keep search working.
    return "concept";
  }
}

/**
 * Defensive sanitizer for an FTS5 MATCH query.
 *
 * Strategy: strip embedded double-quotes (which would close our wrapping
 * phrase) and collapse whitespace, then wrap the result in `"..."` so
 * FTS5 treats the whole thing as a single phrase — neutralizing
 * operators (`AND`/`OR`/`NOT`/`NEAR`), prefix `*`, column qualifiers
 * (`title:`), and unbalanced parens.
 *
 * Returns the empty string if the sanitized payload is empty (FTS5
 * MATCH on `""` would error).
 */
function sanitizeFts5Query(query: string): string {
  const cleaned = query.replace(/"/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "";
  return `"${cleaned}"`;
}
