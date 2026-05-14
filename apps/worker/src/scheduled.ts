// SPDX-License-Identifier: Apache-2.0

// Cron handler entry point. Wired into the default export of
// apps/worker/src/index.ts as `scheduled` alongside `fetch`.
//
// Schedules:
//   - "0 2 * * *" — chat-log archive (M5). Computes yesterday's UTC
//     date and runs archiveDay() to materialize per-room logs.
//   - "0 3 * * *" — ingest scan (M7). Lists every room that has had
//     new messages since its last successful run, fans out
//     runIngestForRoom (sequential), then renders the daily digest.
//
// Dispatch shape: switch on controller.cron so the hot path picks the
// right job and adding future schedules is a one-case change. Both
// jobs run via ctx.waitUntil so the isolate stays alive past the
// synchronous return.

import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { parseScheduledActionRow } from "@loomwiki/schema/parsers";
import { nextFireAt } from "@loomwiki/shared";
import { runIngestForRoom } from "./agents/ingest-agent.js";
import type { Env } from "./env.js";
import { archiveDay, previousUtcDayFromScheduledTime } from "./lib/chat-log.js";
import { renderDailyDigest } from "./lib/digest-delivery.js";
import { DEFAULT_WORKSPACE_ID } from "./lib/workspace.js";

const ARCHIVE_CRON = "0 2 * * *";
const INGEST_CRON = "0 3 * * *";
const SCHEDULED_ACTIONS_CRON = "* * * * *";

export async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  switch (controller.cron) {
    case ARCHIVE_CRON: {
      const dateUtc = previousUtcDayFromScheduledTime(controller.scheduledTime);
      ctx.waitUntil(runArchive(env, dateUtc, controller.cron));
      return;
    }
    case INGEST_CRON: {
      const dateUtc = utcDay(controller.scheduledTime);
      ctx.waitUntil(runIngestScan(env, dateUtc, controller.cron));
      return;
    }
    case SCHEDULED_ACTIONS_CRON: {
      const nowS = Math.floor(controller.scheduledTime / 1000);
      ctx.waitUntil(runScheduledActionsTick(env, nowS));
      return;
    }
    default: {
      // Unrecognized cron — log so configuration drift is visible
      // without failing the run silently.
      console.warn({
        event: "cron_unrecognized",
        cron: controller.cron,
        scheduled_time: controller.scheduledTime,
      });
    }
  }
}

function utcDay(scheduledTimeMs: number): string {
  return new Date(scheduledTimeMs).toISOString().slice(0, 10);
}

// --------------------------------------------------------------------
// Archive cron (M5)
// --------------------------------------------------------------------

async function runArchive(env: Env, dateUtc: string, cron: string): Promise<void> {
  const startedAt = Date.now();
  try {
    const summary = await archiveDay({ env, dateUtc });
    const durationMs = Date.now() - startedAt;
    console.log({
      event: "archive_run_complete",
      cron,
      date: dateUtc,
      rooms_processed: summary.rooms_processed,
      files_written: summary.files_written,
      error_count: summary.errors.length,
      duration_ms: durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    console.error({
      event: "archive_run_failed",
      cron,
      date: dateUtc,
      duration_ms: durationMs,
      error: message,
    });
    throw err;
  }
}

// --------------------------------------------------------------------
// Ingest scan cron (M7)
// --------------------------------------------------------------------

interface IngestScanRoom {
  id: string;
  workspace_id: string;
  slug: string;
}

/**
 * List rooms that may have new content since their last successful
 * ingest. Cheaper than per-room "any new messages?" probes — we list
 * all rooms, and the agent's own loadRoomMessages step is the
 * authoritative empty-batch check.
 */
async function listRoomsForScan(env: Env): Promise<IngestScanRoom[]> {
  const rs = await env.DB.prepare(
    "SELECT id, workspace_id, slug FROM rooms ORDER BY id ASC",
  ).all<IngestScanRoom>();
  return (rs.results ?? []) as IngestScanRoom[];
}

async function runIngestScan(env: Env, dateUtc: string, cron: string): Promise<void> {
  const startedAt = Date.now();
  const rooms = await listRoomsForScan(env);
  let runRan = 0;
  let runFailed = 0;
  let runLockHeld = 0;

  // Sequential per-room. Parallel would be faster but the LLM cost is
  // the limiting factor and the cost guard is workspace-wide; serial
  // makes per-day budget arithmetic predictable.
  for (const room of rooms) {
    try {
      const result = await runIngestForRoom({
        env,
        roomId: room.id,
        workspaceId: room.workspace_id,
        triggeredBy: "cron",
      });
      if (result.ran) runRan++;
      else runLockHeld++;
    } catch (err) {
      runFailed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error({
        event: "ingest_scan_room_failed",
        cron,
        room_id: room.id,
        room_slug: room.slug,
        error: message,
      });
      // Per-room failure isolation — continue the scan.
    }
  }

  // Render the day's digest after all per-room runs settle. The
  // digest pulls from D1 (proposals + ingest_runs) so it sees
  // whatever the runs persisted, even if some rooms failed.
  try {
    await renderDailyDigest({
      env,
      date: dateUtc,
      // v0.0.1: single-tenant. The ingest agent runs are scoped to
      // each room's workspace, but the digest is workspace-global.
      // Using the default workspace id matches the v0.0.1 tenancy
      // model. M8+ will iterate over each workspace.
      workspaceId: DEFAULT_WORKSPACE_ID,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error({
      event: "digest_render_failed",
      cron,
      date: dateUtc,
      error: message,
    });
  }

  console.log({
    event: "ingest_scan_complete",
    cron,
    date: dateUtc,
    rooms_total: rooms.length,
    runs_completed: runRan,
    runs_lock_held: runLockHeld,
    runs_failed: runFailed,
    duration_ms: Date.now() - startedAt,
  });
}

// --------------------------------------------------------------------
// Scheduled-actions tick (every minute)
// --------------------------------------------------------------------

/** Row shape selected from scheduled_actions for the tick handler. */
interface ScheduledActionTickRow {
  id: string;
  room_id: string;
  created_by: string;
  kind: string;
  cron_expr: string | null;
  prompt: string;
  failure_count: number;
  next_fire_at: number;
}

/**
 * Every-minute tick: claim and fire all scheduled_actions whose
 * next_fire_at <= nowS and status = 'active'.
 *
 * Optimistic-claim pattern:
 *   1. Push next_fire_at 1 hour forward BEFORE calling the DO (prevents
 *      double-fire even if the Worker is retried).
 *   2. Call the ChatRoom DO's /_sys/message endpoint.
 *   3. On success: compute real next_fire_at (cron) or mark fired (once).
 *   4. On failure: increment failure_count, set status='failed' if >= 3,
 *      else set next_fire_at = nowS + 60 (retry in 1 min).
 */
export async function runScheduledActionsTick(env: Env, nowS: number): Promise<void> {
  // Claim: atomically push next_fire_at forward for all eligible rows.
  // The WHERE guard (next_fire_at <= nowS AND status = 'active') is the
  // claimant check — two concurrent ticks would both try to claim, but
  // only the first write wins due to the next_fire_at push; the second
  // worker's WHERE condition fails and it claims nothing.
  //
  // We use a two-step SELECT then UPDATE-per-row rather than a single
  // RETURNING because D1 has limited RETURNING support across versions.
  const claimed = await env.DB.prepare(
    `SELECT id, room_id, created_by, kind, cron_expr, prompt, failure_count, next_fire_at
     FROM scheduled_actions
     WHERE next_fire_at <= ? AND status = 'active'
     ORDER BY next_fire_at ASC
     LIMIT 50`,
  )
    .bind(nowS)
    .all<ScheduledActionTickRow>();

  if (!claimed.results || claimed.results.length === 0) return;

  const rows = claimed.results as ScheduledActionTickRow[];

  for (const row of rows) {
    await claimAndFire(env, row, nowS);
  }

  console.log({
    event: "scheduled_actions_tick_complete",
    fired: rows.length,
    now_s: nowS,
  });
}

async function claimAndFire(env: Env, row: ScheduledActionTickRow, nowS: number): Promise<void> {
  // Optimistic claim: push next_fire_at 1 hour forward to prevent double-fire.
  // Only succeeds if the row is still in the state we expect (status='active',
  // next_fire_at unchanged since we read it).
  const claim = await env.DB.prepare(
    `UPDATE scheduled_actions
     SET next_fire_at = ?, updated_at = ?
     WHERE id = ? AND status = 'active' AND next_fire_at = ?`,
  )
    .bind(nowS + 3600, nowS, row.id, row.next_fire_at)
    .run();

  // If no row was updated, another tick already claimed this row — skip.
  if (!claim.meta.changes || claim.meta.changes === 0) return;

  try {
    // Call the ChatRoom DO's /_sys/message endpoint.
    const stubId = env.CHAT_ROOM.idFromName(row.room_id);
    const stub = env.CHAT_ROOM.get(stubId);

    // Post as the action creator — this is a valid user in D1 (the
    // scheduled_actions.created_by FK guarantees it), so the D1 mirror
    // will not fail on a foreign-key constraint.
    // TODO(Q-sched-8): consider a dedicated "system" user concept for
    // clearly marking automated messages in the UI.
    const sysUserId = row.created_by;

    const doRes = await stub.fetch(
      new Request(`https://do-internal/${row.room_id}/_sys/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-loomwiki-sys": "1",
        },
        body: JSON.stringify({
          userId: sysUserId,
          roomId: row.room_id,
          body: row.prompt,
          parentId: null,
        }),
      }),
    );

    if (!doRes.ok) {
      throw new Error(`DO returned ${doRes.status}`);
    }

    // Success: update to real next state.
    const updatedAt = Math.floor(Date.now() / 1000);
    if (row.kind === "cron" && row.cron_expr) {
      let realNextFire: number;
      try {
        realNextFire = nextFireAt(row.cron_expr, nowS);
      } catch {
        // Cron expression broken; mark failed.
        await env.DB.prepare(
          `UPDATE scheduled_actions
           SET status = 'failed', failure_count = failure_count + 1, last_fired_at = ?,
               updated_at = ?
           WHERE id = ?`,
        )
          .bind(updatedAt, updatedAt, row.id)
          .run();
        return;
      }
      await env.DB.prepare(
        `UPDATE scheduled_actions
         SET status = 'active', last_fired_at = ?, next_fire_at = ?, failure_count = 0,
             updated_at = ?
         WHERE id = ?`,
      )
        .bind(updatedAt, realNextFire, updatedAt, row.id)
        .run();
    } else {
      // kind = 'once': mark fired
      await env.DB.prepare(
        `UPDATE scheduled_actions
         SET status = 'fired', last_fired_at = ?, updated_at = ?
         WHERE id = ?`,
      )
        .bind(updatedAt, updatedAt, row.id)
        .run();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn({
      event: "scheduled_action_fire_failed",
      action_id: row.id,
      room_id: row.room_id,
      error: message,
    });

    const updatedAt = Math.floor(Date.now() / 1000);
    const newFailureCount = (row.failure_count ?? 0) + 1;
    if (newFailureCount >= 3) {
      // Too many failures: mark permanently failed.
      await env.DB.prepare(
        `UPDATE scheduled_actions
         SET status = 'failed', failure_count = ?, updated_at = ?
         WHERE id = ?`,
      )
        .bind(newFailureCount, updatedAt, row.id)
        .run();
    } else {
      // Retry in 1 minute.
      await env.DB.prepare(
        `UPDATE scheduled_actions
         SET status = 'active', failure_count = ?, next_fire_at = ?, updated_at = ?
         WHERE id = ?`,
      )
        .bind(newFailureCount, nowS + 60, updatedAt, row.id)
        .run();
    }
  }
}
