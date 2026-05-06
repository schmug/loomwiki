// SPDX-License-Identifier: Apache-2.0

// Ingest run lookup routes:
//
//   GET /api/runs/:id              — single run detail
//   GET /api/rooms/:rid/runs       — recent runs for a room (newest first)
//
// Used by the inbox UI to surface "latest run" status badges and by
// any client that wants to poll a manual trigger to completion.
//
// Auth: workspace member (auth middleware) + room scope check inside
// the handler. Cross-workspace lookups return 404 (not 403) to match
// the rest of the app's "don't leak existence" policy.

import { parseIngestRunRow } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import type { Env } from "../env.js";
import { serializeIngestRun } from "../lib/serialize.js";
import type { AuthEnv } from "../middleware/auth.js";

async function loadWorkspaceForRoom(env: Env, roomId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT workspace_id FROM rooms WHERE id = ?")
    .bind(roomId)
    .first<{ workspace_id: string }>();
  return row?.workspace_id ?? null;
}

async function assertRoomScope(
  env: Env,
  workspaceId: string,
  rid: string,
  userId: string,
): Promise<void> {
  const ws = await loadWorkspaceForRoom(env, rid);
  if (ws !== workspaceId) {
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

export const runsRoute = new Hono<AuthEnv>()
  .get("/runs/:id", async (c) => {
    const rid = c.req.param("id");
    const row = await c.env.DB.prepare("SELECT * FROM ingest_runs WHERE id = ?").bind(rid).first();
    if (!row) {
      throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Run not found", { status: 404 });
    }
    const run = parseIngestRunRow(row);
    // Scope check: the run's room must belong to the caller's workspace.
    const ws = await loadWorkspaceForRoom(c.env, run.room_id);
    if (ws !== c.var.workspace.id) {
      throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Run not found", { status: 404 });
    }
    return c.json(apiOk({ run: serializeIngestRun(run) }));
  })
  .get("/rooms/:rid/runs", async (c) => {
    const rid = c.req.param("rid");
    await assertRoomScope(c.env, c.var.workspace.id, rid, c.var.user.id);

    const limitRaw = c.req.query("limit");
    let limit = 20;
    if (limitRaw !== undefined) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "limit must be a positive integer", {
          status: 400,
        });
      }
      limit = Math.min(parsed, 100);
    }

    const rs = await c.env.DB.prepare(
      "SELECT * FROM ingest_runs WHERE room_id = ? ORDER BY started_at DESC LIMIT ?",
    )
      .bind(rid, limit)
      .all();
    const rows = (rs.results ?? []).map((r) => parseIngestRunRow(r));
    return c.json(apiOk({ runs: rows.map(serializeIngestRun) }));
  });
