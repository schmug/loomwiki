// SPDX-License-Identifier: Apache-2.0

// Operator-facing admin route to (re)build the search indices from
// the canonical wiki backend. Used after a vault reset, after a
// schema change, or as a smoke test that both indexers are healthy.
//
// POST /api/_admin/search/reindex
//   Owner-only. No body. Returns ApiResult<SearchReindexResponse>.
//
// Per-page failures are isolated (mirrors M5's archive-day pattern):
// one broken file should not halt the whole reindex. The response
// surfaces every failure so the operator can decide whether to retry
// or fix the underlying page.

import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import { upsertPageInAiSearch } from "../lib/ai-search.js";
import { upsertPageFts5 } from "../lib/fts5.js";
import { defaultWikiBackend } from "../lib/vault-bootstrap.js";
import { deserializePage } from "../lib/wiki-content.js";
import type { AuthEnv } from "../middleware/auth.js";

function requireOwner(c: { var: { user: { id: string }; workspace: { owner_id: string } } }): void {
  if (c.var.workspace.owner_id !== c.var.user.id) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Workspace owner only", { status: 403 });
  }
}

interface ReindexError {
  path: string;
  message: string;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

export const adminSearchRoute = new Hono<AuthEnv>().post("/_admin/search/reindex", async (c) => {
  requireOwner(c);

  const backend = defaultWikiBackend(c.env);
  const paths = await backend.listPaths();

  const errors: ReindexError[] = [];
  let pagesIndexed = 0;

  for (const path of paths) {
    try {
      const record = await backend.read(path);
      if (record === null) {
        // Race with a delete since listPaths(). Not an error worth
        // failing the whole batch; just skip.
        continue;
      }
      const { frontmatter, body } = await deserializePage(record.raw);

      // allSettled so one indexer failing (e.g., AI Search binding
      // missing in dev) does not block the other. Both indexers'
      // failures are reported individually.
      const settled = await Promise.allSettled([
        upsertPageInAiSearch(c.env, { path, frontmatter, body }),
        upsertPageFts5(c.env, { path, title: frontmatter.title, body }),
      ]);

      const pageErrors = settled
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => errorMessage(r.reason));

      if (pageErrors.length > 0) {
        for (const message of pageErrors) {
          console.warn("[loomwiki] reindex page error", { path, message });
          errors.push({ path, message });
        }
      }
      // We count a page as indexed if at least one indexer succeeded —
      // the FTS5 fallback path is still functional even when AI Search
      // is unavailable. Total failures (both rejected) are NOT counted.
      if (pageErrors.length < settled.length) {
        pagesIndexed += 1;
      }
    } catch (err) {
      const message = errorMessage(err);
      console.warn("[loomwiki] reindex page fatal", { path, message });
      errors.push({ path, message });
    }
  }

  return c.json(apiOk({ pages_indexed: pagesIndexed, errors }));
});
