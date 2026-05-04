// SPDX-License-Identifier: Apache-2.0

// Cron handler entry point. Wired into the default export of
// apps/worker/src/index.ts as `scheduled` alongside `fetch`.
//
// Schedule: 02:00 UTC daily — declared in wrangler.jsonc under
// `triggers.crons`. The handler computes the previous UTC day from
// `controller.scheduledTime` and invokes archiveDay() to materialize a
// log file per active room into the vault.
//
// Why ctx.waitUntil: the runtime may otherwise short-circuit the
// invocation when the synchronous body returns. archiveDay() is
// long-lived (D1 query + N KV writes); waitUntil keeps the isolate
// alive until the work settles.

import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import type { Env } from "./env.js";
import { archiveDay, previousUtcDayFromScheduledTime } from "./lib/chat-log.js";

export async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const dateUtc = previousUtcDayFromScheduledTime(controller.scheduledTime);
  ctx.waitUntil(runArchive(env, dateUtc, controller.cron));
}

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
    // Re-throw so Workers Logs marks the cron run as failed and
    // observability surfaces the error. waitUntil swallows the throw
    // for the request lifecycle but the runtime still flags the run.
    throw err;
  }
}
