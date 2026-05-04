// SPDX-License-Identifier: Apache-2.0

// Local declaration of the Cloudflare AI Search Workers binding.
// Mirrors the upstream `AiSearch` interface (compat date 2026-04-22).
//
// Mirrored here for the same reason `artifacts-binding.d.ts` is —
// `pnpm wrangler types` would also redeclare core globals (Request,
// Headers) that conflict with @cloudflare/workers-types. This narrow
// shadow keeps drift obvious: when wrangler is rerun, eyeball this file
// against the generated worker-configuration.d.ts and update if needed.

export interface AiSearchMatchMetadata {
  /** Source vault path (e.g. `/wiki/concepts/dmarc.md`). */
  path?: string;
  /** Page-level title (frontmatter `title`). */
  title?: string;
  /** Page-level kind (frontmatter `kind`). */
  kind?: string;
  /** H1/H2 ancestor chain for the chunk. */
  section_path?: string[];
  /** The H1/H2 heading for the chunk, if any. */
  heading?: string;
  /** Anything else the indexer attached. */
  [key: string]: unknown;
}

export interface AiSearchMatch {
  /** Document identifier — the chunk's stable id. */
  id: string;
  /** Hybrid (BM25 + vector) score, normalized 0..1. */
  score: number;
  /** The matched text (chunk body or excerpt). */
  content: string;
  /** Caller-attached metadata from the upsert. */
  metadata: AiSearchMatchMetadata;
}

export interface AiSearchQueryResult {
  matches: AiSearchMatch[];
}

export interface AiSearchUpsertDoc {
  id: string;
  content: string;
  metadata?: AiSearchMatchMetadata;
}

/**
 * Cloudflare AI Search Workers binding. Surface intentionally narrow —
 * we only model the methods M6 calls. Add methods here when a future
 * milestone needs them; do NOT widen by guessing — verify against the
 * runtime types first (`pnpm wrangler types`).
 */
export interface AiSearchBinding {
  search(opts: { query: string; topK?: number }): Promise<AiSearchQueryResult>;
  upsert(docs: AiSearchUpsertDoc[]): Promise<{ upserted: number }>;
  delete(ids: string[]): Promise<{ deleted: number }>;
}

/**
 * Workers AI binding (`env.AI`). The package's `Fetcher` type doesn't
 * expose `.run()`, so we model just enough to call into the catalog.
 * `run` returns either a JSON object (non-streaming) or a
 * ReadableStream<Uint8Array> (streaming, when `body.stream === true`).
 */
export interface WorkersAiBinding {
  run(model: string, body: unknown): Promise<unknown>;
}
