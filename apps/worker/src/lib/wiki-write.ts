// SPDX-License-Identifier: Apache-2.0

// Shared wiki-write helper. Extracted from routes/wiki.ts so the M7
// proposal-merge route can reuse the exact M4 conflict-detection +
// serialize + index-sync flow without re-implementing it. The wiki
// PUT route delegates to this; proposal merge calls it directly.

import type { WikiPageFrontmatter, WikiPageWriteRequest } from "@loomwiki/schema";
import { ErrorCodes, LoomwikiError } from "@loomwiki/shared";
import type { Env } from "../env.js";
import { removePageFromAiSearch, upsertPageInAiSearch } from "./ai-search.js";
import { removePageFts5, upsertPageFts5 } from "./fts5.js";
import type { WikiBackend } from "./wiki-backend.js";
import { deserializePage, serializePage, validatePagePayload } from "./wiki-content.js";

export interface WikiPagePayload {
  path: string;
  frontmatter: WikiPageFrontmatter;
  body: string;
  sha: string;
}

/**
 * Apply a write request to a wiki path. Throws:
 *   - LoomwikiError("CONFLICT", 409) when before_sha mismatches
 *   - LoomwikiError("NOT_FOUND", 404) when before_sha is set but the
 *     page doesn't exist
 *   - LoomwikiError("VALIDATION_FAILED", 400) on bad payload
 *
 * The route layer (or proposal merge) catches these and surfaces
 * appropriate HTTP responses.
 */
export async function writePage(
  backend: WikiBackend,
  path: string,
  request: WikiPageWriteRequest,
): Promise<WikiPagePayload> {
  const validated = await normalizeWriteRequest(request);
  const existing = await backend.read(path);

  if (existing !== null) {
    if (request.before_sha === undefined) {
      throw conflictError(path, existing, validated);
    }
    if (existing.sha !== request.before_sha) {
      throw conflictError(path, existing, validated);
    }
  } else if (request.before_sha !== undefined) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "page not found", { status: 404 });
  }

  const serialized = await serializePage(validated.frontmatter, validated.body);
  await backend.write({ path, raw: serialized.raw, sha: serialized.sha });

  return {
    path,
    frontmatter: validated.frontmatter,
    body: validated.body,
    sha: serialized.sha,
  };
}

export async function normalizeWriteRequest(
  request: WikiPageWriteRequest,
): Promise<{ frontmatter: WikiPageFrontmatter; body: string }> {
  if ("raw" in request) {
    const parsed = await deserializePage(request.raw);
    return validatePagePayload({ frontmatter: parsed.frontmatter, body: parsed.body });
  }
  return validatePagePayload({ frontmatter: request.frontmatter, body: request.body });
}

export async function syncIndexesOnUpsert(env: Env, payload: WikiPagePayload): Promise<void> {
  const settled = await Promise.allSettled([
    upsertPageInAiSearch(env, {
      path: payload.path,
      frontmatter: {
        title: payload.frontmatter.title,
        kind: payload.frontmatter.kind,
      },
      body: payload.body,
    }),
    upsertPageFts5(env, {
      path: payload.path,
      title: payload.frontmatter.title,
      body: payload.body,
    }),
  ]);
  for (const r of settled) {
    if (r.status === "rejected") {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.warn(`[wiki] index upsert failed for ${payload.path}: ${reason}`);
    }
  }
}

export async function syncIndexesOnDelete(env: Env, path: string): Promise<void> {
  const settled = await Promise.allSettled([
    removePageFromAiSearch(env, path),
    removePageFts5(env, path),
  ]);
  for (const r of settled) {
    if (r.status === "rejected") {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.warn(`[wiki] index delete failed for ${path}: ${reason}`);
    }
  }
}

function conflictError(
  path: string,
  existing: { raw: string; sha: string },
  attempted: { frontmatter: unknown; body: string },
): LoomwikiError {
  return new LoomwikiError(
    ErrorCodes.CONFLICT,
    "Wiki page changed since you loaded it; resolve via 3-way merge",
    {
      status: 409,
      details: {
        path,
        current_sha: existing.sha,
        current_raw: existing.raw,
        base_sha: existing.sha,
        base_raw: existing.raw,
        attempted_frontmatter: attempted.frontmatter,
        attempted_body: attempted.body,
      },
    },
  );
}
