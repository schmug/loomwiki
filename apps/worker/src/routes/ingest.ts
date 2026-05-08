// SPDX-License-Identifier: Apache-2.0

// Manual ingest trigger: POST /api/rooms/:rid/ingest.
//
// Flow: acquire the per-room run lock synchronously, then dispatch the
// LLM phase via ctx.waitUntil so the HTTP response returns immediately
// with the run_id. The client polls GET /api/runs/:id for status.
//
// Response shape:
//   200 { run_id, status: "running" }      — lock acquired; agent dispatched
//   202 { run_id, status: "lock_held" }    — another run already in flight
//   429 RATE_LIMITED                       — workspace daily ingest cap hit
//   403 FORBIDDEN                          — not a room member
//   404 NOT_FOUND                          — room missing or wrong workspace

import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import { executeIngestWork } from "../agents/ingest-agent.js";
import { acquireRunLock } from "../agents/lock.js";
import type { Env } from "../env.js";
import { auditManualIngest } from "../lib/audit.js";
import type { AuthEnv } from "../middleware/auth.js";

async function assertRoomMember(
  env: Env,
  workspaceId: string,
  rid: string,
  userId: string,
): Promise<void> {
  const room = await env.DB.prepare("SELECT workspace_id FROM rooms WHERE id = ?")
    .bind(rid)
    .first<{ workspace_id: string }>();
  if (!room || room.workspace_id !== workspaceId) {
    // Cross-workspace defense: 404, not 403, mirroring routes/rooms.ts.
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Room not found", { status: 404 });
  }
  const member = await env.DB.prepare(
    "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1",
  )
    .bind(rid, userId)
    .first();
  if (!member) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Not a member of this room", {
      status: 403,
    });
  }
}

export const ingestRoute = new Hono<AuthEnv>().post("/rooms/:rid/ingest", async (c) => {
  const rid = c.req.param("rid");
  await assertRoomMember(c.env, c.var.workspace.id, rid, c.var.user.id);

  // Acquire the lock synchronously. This is cheap (one D1 SELECT, at
  // most one INSERT). The slow LLM work happens later via waitUntil.
  const lock = await acquireRunLock({
    env: c.env,
    roomId: rid,
    triggeredBy: c.var.user.id,
  });

  if (!lock.acquired) {
    return c.json(apiOk({ run_id: lock.runId, status: "lock_held" }), 202);
  }

  // Dispatch the LLM phase asynchronously. ctx.waitUntil keeps the
  // isolate alive past the HTTP response. Errors during the work land
  // on the run row's status/error columns; we only log here.
  const ctx = c.executionCtx as { waitUntil: (p: Promise<unknown>) => void } | undefined;
  const work = executeIngestWork({
    env: c.env,
    roomId: rid,
    workspaceId: c.var.workspace.id,
    triggeredBy: c.var.user.id,
    runId: lock.runId,
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn({
      event: "ingest_work_failed",
      run_id: lock.runId,
      room_id: rid,
      error: msg,
    });
  });

  if (ctx?.waitUntil) {
    ctx.waitUntil(work);
    ctx.waitUntil(
      auditManualIngest(
        {
          env: c.env,
          workspaceId: c.var.workspace.id,
          actorUserId: c.var.user.id,
          requestId: c.var.request_id ?? null,
        },
        rid,
        lock.runId,
      ).catch(() => {}),
    );
  } else {
    void work;
    void auditManualIngest(
      {
        env: c.env,
        workspaceId: c.var.workspace.id,
        actorUserId: c.var.user.id,
        requestId: c.var.request_id ?? null,
      },
      rid,
      lock.runId,
    ).catch(() => {});
  }

  return c.json(apiOk({ run_id: lock.runId, status: "running" }), 200);
});
