// SPDX-License-Identifier: Apache-2.0

// Unified search orchestrator. Front door for `/api/search` and the
// retrieval step of `/api/ask`. Tries AI Search first (hybrid BM25 +
// vector via the Workers binding); on any failure or when explicitly
// disabled, falls through to the D1 FTS5 fallback.
//
// The fallback is the single most important piece of resilience here —
// AI Search is a remote-only binding, so local dev, CI, and any account
// that hasn't provisioned it must still be able to search. Treating
// "binding throws" the same as "binding missing" keeps the worker
// useful through transient outages too.
//
// Mode in the response tells the caller which path served them:
//   - "hybrid"        → AI Search succeeded.
//   - "fts5_fallback" → either AI Search was disabled, the binding was
//                       missing, or the call threw — and FTS5 served.
// An empty result with `mode: "hybrid"` means AI Search ran fine and
// genuinely had nothing; an empty result with `mode: "fts5_fallback"`
// means we tried AI Search, fell back, and FTS5 also had nothing.

import type { WikiSearchResponse } from "@loomwiki/schema";
import { isLoomwikiError } from "@loomwiki/shared";
import type { Env } from "../env.js";
import { queryAiSearch } from "./ai-search.js";
import { searchFts5 } from "./fts5.js";

export interface SearchWikiOptions {
  env: Env;
  query: string;
  topK?: number;
}

export async function searchWiki(opts: SearchWikiOptions): Promise<WikiSearchResponse> {
  const trimmed = opts.query.trim();
  if (trimmed.length === 0) {
    return { results: [], mode: "hybrid" };
  }
  const topK = opts.topK ?? 5;

  // Skip the AI Search attempt entirely when the operator has flipped
  // it off. Going straight to FTS5 saves a guaranteed-throw round-trip
  // through ai-search.ts and makes the mode label honest.
  const aiSearchEnabled = opts.env.AI_SEARCH_ENABLED !== "false";
  if (aiSearchEnabled) {
    try {
      const results = await queryAiSearch(opts.env, { query: trimmed, topK });
      return { results, mode: "hybrid" };
    } catch (err) {
      if (isLoomwikiError(err) && err.code === "AI_SEARCH_UNAVAILABLE") {
        // Expected fallthrough — binding missing, disabled, or upstream
        // 5xx. Quiet log, then FTS5.
        console.warn(`[search] AI Search unavailable, falling back to FTS5: ${err.message}`);
      } else {
        // Unexpected — log louder so it shows up in tail.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[search] AI Search threw unexpectedly, falling back: ${message}`);
      }
    }
  }

  const fallback = await searchFts5(opts.env, trimmed, { topK });
  return { results: fallback, mode: "fts5_fallback" };
}
