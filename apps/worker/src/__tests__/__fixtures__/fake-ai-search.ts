// SPDX-License-Identifier: Apache-2.0

// In-memory fake of the Cloudflare AI Search Workers binding. Matches
// the surface declared in apps/worker/src/ai-search-binding.d.ts so the
// search orchestrator + indexer can be exercised without the real
// (remote-only) AI Search service.
//
// Behavior model:
//   - upsert(docs): replaces docs by id (last write wins).
//   - delete(ids): drops matching ids; returns the number actually removed.
//   - search({ query, topK }): returns docs whose `content` contains
//     any whitespace-tokenized term from `query` (case-insensitive).
//     Score is the count of matched terms, normalized to [0..1] by
//     dividing by the max term count across hits. topK trims the result.
//
// The fake is intentionally simple — it exists to verify call shape
// (id stability for chunked upserts, metadata round-trip, topK), not to
// model BM25 or vector relevance. Tests that care about ranking should
// hit the FTS5 backend, which uses real SQLite.

import type {
  AiSearchBinding,
  AiSearchMatch,
  AiSearchMatchMetadata,
  AiSearchQueryResult,
  AiSearchUpsertDoc,
} from "../../ai-search-binding.js";
import type { Env } from "../../env.js";

interface StoredDoc {
  id: string;
  content: string;
  metadata: AiSearchMatchMetadata;
}

export class FakeAiSearchBinding implements AiSearchBinding {
  /** Public for test introspection; do not mutate from outside. */
  public readonly docs = new Map<string, StoredDoc>();
  /** Set true to force every method to throw — exercises fallback paths. */
  public failNext = false;

  async upsert(docs: AiSearchUpsertDoc[]): Promise<{ upserted: number }> {
    if (this.failNext) throw new Error("fake-ai-search: forced upsert failure");
    for (const d of docs) {
      this.docs.set(d.id, { id: d.id, content: d.content, metadata: d.metadata ?? {} });
    }
    return { upserted: docs.length };
  }

  async delete(ids: string[]): Promise<{ deleted: number }> {
    if (this.failNext) throw new Error("fake-ai-search: forced delete failure");
    let n = 0;
    for (const id of ids) {
      if (this.docs.delete(id)) n += 1;
    }
    return { deleted: n };
  }

  async search(opts: { query: string; topK?: number }): Promise<AiSearchQueryResult> {
    if (this.failNext) throw new Error("fake-ai-search: forced search failure");
    const terms = opts.query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const limit = opts.topK ?? 10;
    if (terms.length === 0) return { matches: [] };

    const scored: { doc: StoredDoc; hits: number }[] = [];
    for (const doc of this.docs.values()) {
      const haystack = `${doc.content} ${JSON.stringify(doc.metadata)}`.toLowerCase();
      let hits = 0;
      for (const t of terms) {
        if (haystack.includes(t)) hits += 1;
      }
      if (hits > 0) scored.push({ doc, hits });
    }

    scored.sort((a, b) => b.hits - a.hits);
    const trimmed = scored.slice(0, limit);
    const maxHits = trimmed.reduce((m, s) => Math.max(m, s.hits), 1);
    const matches: AiSearchMatch[] = trimmed.map(({ doc, hits }) => ({
      id: doc.id,
      score: hits / maxHits,
      content: doc.content,
      metadata: doc.metadata,
    }));
    return { matches };
  }
}

/**
 * Compose an Env override that injects a fake AI Search binding.
 * Use with the existing `envOverride` pattern in test files (see
 * llm.test.ts) — pass the result through `{ ...env, ...envWithFakeAiSearch(...) }`.
 */
export function envWithFakeAiSearch(
  base: Env,
  binding: FakeAiSearchBinding | undefined,
  extras: Partial<Env> = {},
): Env {
  return { ...base, AI_SEARCH: binding, ...extras } as Env;
}
