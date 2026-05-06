// SPDX-License-Identifier: Apache-2.0

// Per-room ingest run lock.
//
// One ingest run per room may be `running` at a time. Concurrent triggers
// (manual route racing the cron, two operators clicking the button at
// once) must converge on a single run, not stack up. The lock is a row in
// `ingest_runs` with `status='running'`; the "is the lock held?" check is
// "does a running row younger than 1h exist for this room?".
//
// Why D1, not a Durable Object: ingest runs are slow (10–60s) and
// infrequent (manual + 1/day cron), so D1's serialization is comfortably
// fast enough. Reaching for a DO would introduce another moving part on
// the room-room hot path that DOes don't currently mediate, just to
// guard a low-frequency operation.
//
// Stale-lock recovery: a `running` row older than 1h is treated as
// abandoned and a new run can take over (the M5 archive cron runs at
// 02:00 UTC; the M7 ingest cron at 03:00 UTC — both have ~1h before the
// next scheduled overlap matters). When a run is taken over, the previous
// row's status is updated to 'failed' with error='lock_expired' so the
// audit trail is preserved.

import { id } from "@loomwiki/shared";
import type { Env } from "../env.js";

export interface AcquireRunLockOptions {
  env: Env;
  roomId: string;
  /** UUIDv7 of the triggering user, or "cron" for scheduled runs. */
  triggeredBy: string;
  /**
   * Test seam — defaults to wall clock. Used to deterministically
   * advance time across the 1h stale-lock boundary.
   */
  clock?: () => number;
}

export interface AcquireRunLockResult {
  /** UUIDv7 of the run row this caller now holds (or contends for). */
  runId: string;
  /** True if THIS call inserted a new run; false if a prior run held the lock. */
  acquired: boolean;
}

const STALE_LOCK_AGE_SECONDS = 60 * 60; // 1 hour

/**
 * Try to acquire the run lock for `roomId`. Inserts a `running` row and
 * returns `acquired=true` on success. If a younger-than-1h `running`
 * row already exists, returns `acquired=false` with the existing
 * `runId`. If a stale `running` row exists (>1h old), it is failed
 * out and this call inserts a fresh run.
 *
 * Concurrency: D1 serializes writes, so two simultaneous calls produce
 * one inserted row and one observed-existing row — the loser still
 * gets back a usable runId pointing at the winner.
 */
export async function acquireRunLock(opts: AcquireRunLockOptions): Promise<AcquireRunLockResult> {
  const clock = opts.clock ?? (() => Date.now());
  const nowSec = Math.floor(clock() / 1000);
  const staleCutoff = nowSec - STALE_LOCK_AGE_SECONDS;

  // First check for a non-stale running row.
  const existing = await opts.env.DB.prepare(
    `SELECT id, started_at FROM ingest_runs
       WHERE room_id = ? AND status = 'running' AND started_at > ?
       ORDER BY started_at DESC
       LIMIT 1`,
  )
    .bind(opts.roomId, staleCutoff)
    .first<{ id: string; started_at: number }>();

  if (existing !== null) {
    return { runId: existing.id, acquired: false };
  }

  // Mark any stale running rows for this room as failed BEFORE inserting
  // the new one — the audit trail records that a run was abandoned, not
  // silently overwritten.
  await opts.env.DB.prepare(
    `UPDATE ingest_runs
        SET status = 'failed',
            finished_at = ?,
            error = 'lock_expired'
      WHERE room_id = ? AND status = 'running' AND started_at <= ?`,
  )
    .bind(nowSec, opts.roomId, staleCutoff)
    .run();

  const runId = id();
  await opts.env.DB.prepare(
    `INSERT INTO ingest_runs (id, room_id, triggered_by, started_at, status)
     VALUES (?, ?, ?, ?, 'running')`,
  )
    .bind(runId, opts.roomId, opts.triggeredBy, nowSec)
    .run();

  return { runId, acquired: true };
}

/**
 * Mark a run row as `succeeded`, recording the bookmark and summary.
 * Idempotent in the sense that a second call with the same arguments
 * leaves the same row content — but a row that has already finished
 * should not be re-finished.
 */
export async function markRunSucceeded(
  env: Env,
  runId: string,
  args: { lastMessageId: string | null; summary: string; clock?: () => number },
): Promise<void> {
  const clock = args.clock ?? (() => Date.now());
  const nowSec = Math.floor(clock() / 1000);
  await env.DB.prepare(
    `UPDATE ingest_runs
        SET status = 'succeeded',
            finished_at = ?,
            last_message_id = ?,
            summary = ?
      WHERE id = ? AND status = 'running'`,
  )
    .bind(nowSec, args.lastMessageId, args.summary, runId)
    .run();
}

/**
 * Mark a run row as `failed` with a one-line error tag. The tag is the
 * structured failure reason (e.g. `parse_retry_exceeded`,
 * `secret_scrub_aborted`, `cost_guard_exhausted`); free-form prose
 * goes in the worker logs, not in this column.
 */
export async function markRunFailed(
  env: Env,
  runId: string,
  args: { error: string; clock?: () => number },
): Promise<void> {
  const clock = args.clock ?? (() => Date.now());
  const nowSec = Math.floor(clock() / 1000);
  await env.DB.prepare(
    `UPDATE ingest_runs
        SET status = 'failed',
            finished_at = ?,
            error = ?
      WHERE id = ? AND status = 'running'`,
  )
    .bind(nowSec, args.error, runId)
    .run();
}

export const __testing = { STALE_LOCK_AGE_SECONDS };
