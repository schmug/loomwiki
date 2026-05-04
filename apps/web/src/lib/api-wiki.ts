// SPDX-License-Identifier: Apache-2.0

// Typed wiki-API helpers. Wraps the generic api.ts client with the
// wiki-specific shapes from `@/lib/types`. The 409 CONFLICT path
// surfaces a typed `WikiConflictError` whose `details` field carries
// the full merge-dialog payload — the editor reads this directly.

import { ApiError, apiDelete, apiGet, request } from "@/lib/api";
import type {
  WikiConflictDetails,
  WikiPagePayload,
  WikiPageWriteRequest,
  WikiTreeResponse,
} from "@/lib/types";

export class WikiConflictError extends Error {
  details: WikiConflictDetails;
  constructor(details: WikiConflictDetails) {
    super(`Wiki page changed since you loaded it (path: ${details.path})`);
    this.name = "WikiConflictError";
    this.details = details;
  }
}

export async function fetchWikiTree(): Promise<WikiTreeResponse> {
  return apiGet<WikiTreeResponse>("/api/wiki-tree");
}

export async function fetchWikiPage(path: string): Promise<WikiPagePayload> {
  // path is a vault path beginning with `/wiki/`. The HTTP path drops
  // the leading `/` so we end up at /api/wiki/...
  const apiPath = `/api${path}`;
  const data = await apiGet<{ page: WikiPagePayload }>(apiPath);
  return data.page;
}

/**
 * Save a page. Throws `WikiConflictError` on a 409 so callers can
 * open the merge dialog without parsing the generic error.
 */
export async function saveWikiPage(
  path: string,
  body: WikiPageWriteRequest,
): Promise<WikiPagePayload> {
  try {
    const data = await request<{ page: WikiPagePayload }>(`/api${path}`, {
      method: "PUT",
      body,
    });
    return data.page;
  } catch (err) {
    if (err instanceof ApiError && err.code === "CONFLICT") {
      const detailsCarrier = err as ApiError & { details?: unknown };
      const details = detailsCarrier.details;
      if (isWikiConflictDetails(details)) {
        throw new WikiConflictError(details);
      }
    }
    throw err;
  }
}

export async function deleteWikiPage(path: string): Promise<{ path: string }> {
  return apiDelete<{ path: string }>(`/api${path}`);
}

function isWikiConflictDetails(value: unknown): value is WikiConflictDetails {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === "string" &&
    typeof v.current_sha === "string" &&
    typeof v.current_raw === "string" &&
    typeof v.base_sha === "string" &&
    typeof v.base_raw === "string"
  );
}
