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
import { runIngestForRoom } from "./agents/ingest-agent.js";
import type { Env } from "./env.js";
import { archiveDay, previousUtcDayFromScheduledTime } from "./lib/chat-log.js";
import { renderDailyDigest } from "./lib/digest-delivery.js";
import { DEFAULT_WORKSPACE_ID } from "./lib/workspace.js";

const ARCHIVE_CRON = "0 2 * * *";
const INGEST_CRON = "0 3 * * *";

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
