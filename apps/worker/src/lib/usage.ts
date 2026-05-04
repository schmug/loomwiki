// SPDX-License-Identifier: Apache-2.0

// LLM usage counters. Per-day, per-(workspace, scope) counts of /ask
// and /search calls. Backed by the `llm_usage_daily` table from
// migration 0002.
//
// Race safety: the upsert uses `INSERT ... ON CONFLICT DO UPDATE` on
// the composite primary key (workspace_id, day, scope_type, scope_id).
// SQLite serializes writes within a D1 instance, and the ON CONFLICT
// clause handles the row-exists case atomically. A read-modify-write
// pattern in JS would be racy under concurrent requests; this avoids
// that entirely.
//
// UTC day key is computed in-function from the supplied clock. Tests
// inject a fake clock to exercise rollover; production passes
// `Date.now()` (the default).

import type { LlmUsageKind, LlmUsageScopeType } from "@loomwiki/schema";
import type { Env } from "../env.js";

export type Clock = () => number;
const wallClock: Clock = () => Date.now();

export interface UsageCounts {
  ask_count: number;
  search_count: number;
}

const ZERO_COUNTS: UsageCounts = { ask_count: 0, search_count: 0 };

/**
 * Compute the UTC day key (YYYY-MM-DD) for a given epoch-ms clock
 * reading. Exported so cost-guard can format the same string when
 * building rate-limit error details.
 */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Compute the next UTC midnight as an ISO-8601 string. Used in the
 * rate-limit error payload so clients can render "resets at X".
 */
export function nextUtcMidnightIso(now: number): string {
  const day = utcDayKey(now);
  // Add one day to the day-key, then return its midnight.
  const tomorrow = new Date(`${day}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return tomorrow.toISOString();
}

interface ScopeKey {
  workspaceId: string;
  scopeType: LlmUsageScopeType;
  scopeId: string;
}

/**
 * Read today's counters for `(workspace, scope)`. Returns `{0,0}` when
 * no row exists for today — same semantics as "the user has not been
 * counted today".
 */
export async function getUsage(
  env: Env,
  scope: ScopeKey,
  clock: Clock = wallClock,
): Promise<UsageCounts> {
  const day = utcDayKey(clock());
  const row = await env.DB.prepare(
    "SELECT ask_count, search_count FROM llm_usage_daily WHERE workspace_id = ? AND day = ? AND scope_type = ? AND scope_id = ?",
  )
    .bind(scope.workspaceId, day, scope.scopeType, scope.scopeId)
    .first<{ ask_count: number; search_count: number }>();
  if (row === null) return { ...ZERO_COUNTS };
  return { ask_count: row.ask_count ?? 0, search_count: row.search_count ?? 0 };
}

/**
 * Increment today's `kind` counter for `(workspace, scope)` by 1.
 * Returns the post-increment counts so the cost-guard can include them
 * in subsequent error payloads without a follow-up read.
 */
export async function incrementUsage(
  env: Env,
  scope: ScopeKey,
  kind: LlmUsageKind,
  clock: Clock = wallClock,
): Promise<UsageCounts> {
  const now = Math.floor(clock() / 1000);
  const day = utcDayKey(clock());
  const askDelta = kind === "ask" ? 1 : 0;
  const searchDelta = kind === "search" ? 1 : 0;

  // INSERT-or-UPDATE in a single statement. The PK is composite, so
  // the conflict target enumerates all four columns.
  await env.DB.prepare(
    `INSERT INTO llm_usage_daily
       (workspace_id, day, scope_type, scope_id, ask_count, search_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, day, scope_type, scope_id) DO UPDATE SET
       ask_count    = ask_count + excluded.ask_count,
       search_count = search_count + excluded.search_count,
       updated_at   = excluded.updated_at`,
  )
    .bind(scope.workspaceId, day, scope.scopeType, scope.scopeId, askDelta, searchDelta, now)
    .run();

  return getUsage(env, scope, clock);
}

/**
 * Test/reset helper. Wipes today's row for `(workspace, scope)`. Not
 * exposed via any HTTP route — production cleanup is the operator's
 * problem (manual SQL or future M9 reaper).
 */
export async function resetUsageToday(
  env: Env,
  scope: ScopeKey,
  clock: Clock = wallClock,
): Promise<void> {
  const day = utcDayKey(clock());
  await env.DB.prepare(
    "DELETE FROM llm_usage_daily WHERE workspace_id = ? AND day = ? AND scope_type = ? AND scope_id = ?",
  )
    .bind(scope.workspaceId, day, scope.scopeType, scope.scopeId)
    .run();
}
