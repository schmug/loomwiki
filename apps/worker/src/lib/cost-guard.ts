// SPDX-License-Identifier: Apache-2.0

// Cost guard. Sits in front of every /api/ask and /api/search call,
// checking both the per-user and per-workspace daily caps before the
// LLM call goes out. Whichever cap fails first wins the rate-limit
// error.
//
// Three layers of defense (docs/SECURITY.md §7):
//   1. Per-user counter   (this module)
//   2. Per-workspace counter (this module)
//   3. AI Gateway daily cap  (CF dashboard, not code)
//
// Skipping any single layer creates a hole. User caps without
// workspace caps means a botnet inside one workspace can drain the
// quota; workspace caps without user caps mean one bad actor consumes
// a shared budget; missing the Gateway layer means a worker bug
// exposes the whole account to runaway spend.
//
// Counter increments happen BEFORE the LLM call (in `assertWithinLimit`
// → `recordUsage`). A client disconnect mid-stream does NOT roll back
// the counter — the cost has already been incurred at the LLM provider.

import type { LlmUsageKind } from "@loomwiki/schema";
import { ErrorCodes, LoomwikiError } from "@loomwiki/shared";
import type { Env } from "../env.js";
import { type Clock, getUsage, incrementUsage, nextUtcMidnightIso } from "./usage.js";

export interface AssertWithinLimitArgs {
  env: Env;
  workspaceId: string;
  /**
   * For kind ∈ {"ask","search"}, the user driving the request. The
   * cost-guard charges both their per-user and the per-workspace
   * counter. For kind="ingest" the userId is unused (workspace-scoped
   * only), but callers still pass the triggering user (or the literal
   * "cron") for symmetry; the value is recorded but not enforced.
   */
  userId: string;
  kind: LlmUsageKind;
  /** Test seam — defaults to wall clock. */
  clock?: Clock;
}

export interface DailyLimits {
  perUserAsk: number;
  perUserSearch: number;
  perWorkspaceAsk: number;
  perWorkspaceSearch: number;
  /** M7: workspace-scoped only — no per-user cap. */
  perWorkspaceIngest: number;
}

const DEFAULTS: DailyLimits = {
  perUserAsk: 100,
  perUserSearch: 1000,
  perWorkspaceAsk: 1000,
  perWorkspaceSearch: 10000,
  perWorkspaceIngest: 100,
};

function parseLimit(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function readLimits(env: Env): DailyLimits {
  return {
    perUserAsk: parseLimit(env.LLM_DAILY_LIMIT_PER_USER_ASK, DEFAULTS.perUserAsk),
    perUserSearch: parseLimit(env.LLM_DAILY_LIMIT_PER_USER_SEARCH, DEFAULTS.perUserSearch),
    perWorkspaceAsk: parseLimit(env.LLM_DAILY_LIMIT_PER_WORKSPACE_ASK, DEFAULTS.perWorkspaceAsk),
    perWorkspaceSearch: parseLimit(
      env.LLM_DAILY_LIMIT_PER_WORKSPACE_SEARCH,
      DEFAULTS.perWorkspaceSearch,
    ),
    perWorkspaceIngest: parseLimit(
      env.INGEST_DAILY_LIMIT_PER_WORKSPACE,
      DEFAULTS.perWorkspaceIngest,
    ),
  };
}

const WORKSPACE_SCOPE_ID = "_workspace" as const;

interface RateLimitDetails {
  limit: number;
  used: number;
  scope: "user" | "workspace";
  reset_at: string;
}

function rateLimitError(details: RateLimitDetails): LoomwikiError {
  return new LoomwikiError(
    ErrorCodes.RATE_LIMITED,
    `Daily ${details.scope} limit reached (${details.used}/${details.limit})`,
    { status: 429, details },
  );
}

/**
 * Throws `LoomwikiError("RATE_LIMITED", ...)` if either cap would be
 * exceeded by this call; otherwise increments the appropriate counters
 * and returns. Counters increment before the LLM call, never after —
 * see module-level note on disconnect handling.
 *
 * Scope rules per kind:
 *   - kind="ask" / "search": both per-user AND per-workspace counters
 *     are read and incremented. Per-user fails first in error reporting.
 *   - kind="ingest": ONLY the per-workspace counter. Manual triggers
 *     come from members but the operation is workspace-scoped (one
 *     ingest run per room, regardless of who triggered it). Cron runs
 *     have no user identity at all (`userId === "cron"`). Sharing the
 *     budget across users matches the resource shape: ingest spends
 *     LLM tokens against the workspace's vault, not against the
 *     user's personal allowance.
 */
export async function assertWithinLimit(args: AssertWithinLimitArgs): Promise<void> {
  const limits = readLimits(args.env);
  const clockMs = (args.clock ?? Date.now)();
  const resetAt = nextUtcMidnightIso(clockMs);

  if (args.kind === "ingest") {
    const wsUsage = await getUsage(
      args.env,
      { workspaceId: args.workspaceId, scopeType: "workspace", scopeId: WORKSPACE_SCOPE_ID },
      args.clock,
    );
    const wsUsed = wsUsage.ingest_count;
    if (wsUsed >= limits.perWorkspaceIngest) {
      throw rateLimitError({
        limit: limits.perWorkspaceIngest,
        used: wsUsed,
        scope: "workspace",
        reset_at: resetAt,
      });
    }
    await incrementUsage(
      args.env,
      { workspaceId: args.workspaceId, scopeType: "workspace", scopeId: WORKSPACE_SCOPE_ID },
      "ingest",
      args.clock,
    );
    return;
  }

  const userLimit = args.kind === "ask" ? limits.perUserAsk : limits.perUserSearch;
  const workspaceLimit = args.kind === "ask" ? limits.perWorkspaceAsk : limits.perWorkspaceSearch;

  // Read both counters before deciding. Reading first means a single
  // request that would push BOTH counters over the cap reports the
  // user cap (which fails first in our policy), not the workspace
  // cap, even though both would trip.
  const [userUsage, wsUsage] = await Promise.all([
    getUsage(
      args.env,
      { workspaceId: args.workspaceId, scopeType: "user", scopeId: args.userId },
      args.clock,
    ),
    getUsage(
      args.env,
      { workspaceId: args.workspaceId, scopeType: "workspace", scopeId: WORKSPACE_SCOPE_ID },
      args.clock,
    ),
  ]);

  const userUsed = args.kind === "ask" ? userUsage.ask_count : userUsage.search_count;
  const wsUsed = args.kind === "ask" ? wsUsage.ask_count : wsUsage.search_count;

  if (userUsed >= userLimit) {
    throw rateLimitError({ limit: userLimit, used: userUsed, scope: "user", reset_at: resetAt });
  }
  if (wsUsed >= workspaceLimit) {
    throw rateLimitError({
      limit: workspaceLimit,
      used: wsUsed,
      scope: "workspace",
      reset_at: resetAt,
    });
  }

  // Both counters increment for the same logical event. Concurrent
  // safe via the ON CONFLICT DO UPDATE in incrementUsage.
  await Promise.all([
    incrementUsage(
      args.env,
      { workspaceId: args.workspaceId, scopeType: "user", scopeId: args.userId },
      args.kind,
      args.clock,
    ),
    incrementUsage(
      args.env,
      { workspaceId: args.workspaceId, scopeType: "workspace", scopeId: WORKSPACE_SCOPE_ID },
      args.kind,
      args.clock,
    ),
  ]);
}

export const __testing = { WORKSPACE_SCOPE_ID };
