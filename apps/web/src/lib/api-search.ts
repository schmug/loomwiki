// SPDX-License-Identifier: Apache-2.0

// Wraps POST /api/search through the generic api.ts client. Thin on
// purpose — the search route returns a fully-typed `WikiSearchResponse`
// that the components can render directly. ApiError flows through
// untouched so the caller can branch on `.code === "RATE_LIMITED"` and
// hand `.details` to the RateLimitBanner.

import { apiPost } from "@/lib/api";
import type { WikiSearchResponse } from "@/lib/types";

/**
 * Default page size mirrors the worker's max-50 hard cap; 10 is the
 * sweet spot for the dropdown and the full search page both — large
 * enough to feel useful, small enough that the FTS5 fallback path
 * doesn't drown the user in low-precision matches.
 */
export const DEFAULT_SEARCH_TOP_K = 10;

export async function searchWiki(
  query: string,
  topK = DEFAULT_SEARCH_TOP_K,
): Promise<WikiSearchResponse> {
  return apiPost<WikiSearchResponse>("/api/search", { query, topK });
}
