// SPDX-License-Identifier: Apache-2.0

// Wiki search HTTP route. Thin layer over `lib/search.ts` — the route
// owns auth, validation, and rate-limiting; the orchestrator owns the
// hybrid AI Search + FTS5 fallback policy.
//
// POST /api/search
//   body: { query: string, topK?: number }   (WikiSearchRequestSchema)
//   200:  ApiResult<WikiSearchResponse>
//   400:  VALIDATION_FAILED
//   429:  RATE_LIMITED { details: { limit, used, scope, reset_at } }

import { WikiSearchRequestSchema } from "@loomwiki/schema";
import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import { assertWithinLimit } from "../lib/cost-guard.js";
import { searchWiki } from "../lib/search.js";
import type { AuthEnv } from "../middleware/auth.js";

export const searchRoute = new Hono<AuthEnv>().post("/search", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = WikiSearchRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid search request", {
      status: 400,
      details: parsed.error.issues,
    });
  }

  // Cost guard FIRST — rate-limited callers must not get a free
  // signal about whether the search would have hit the AI Search
  // binding versus FTS5 fallback. Counter increments here; the
  // search itself is "search" kind (not "ask").
  await assertWithinLimit({
    env: c.env,
    workspaceId: c.var.workspace.id,
    userId: c.var.user.id,
    kind: "search",
  });

  const result = await searchWiki({
    env: c.env,
    query: parsed.data.query,
    topK: parsed.data.topK,
  });

  return c.json(apiOk(result));
});
