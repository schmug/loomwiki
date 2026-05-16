// SPDX-License-Identifier: Apache-2.0

// Scheduled-actions routes — user-defined cron/once prompts that fire into
// a ChatRoom as system-authored messages.
//
// Mounted at /api/rooms (see index.ts), so the full paths are:
//   POST   /api/rooms/:roomId/scheduled-actions
//   GET    /api/rooms/:roomId/scheduled-actions
//   PATCH  /api/rooms/:roomId/scheduled-actions/:id
//   DELETE /api/rooms/:roomId/scheduled-actions/:id
//
// Auth: verified room membership (same as rooms.ts). Workspace ownership
// from c.var.workspace.owner_id. Soft quota: 50 active per workspace,
// 10 active per room.

import {
  CreateScheduledActionRequestSchema,
  PatchScheduledActionRequestSchema,
  type ScheduledActionRow,
  ScheduledActionRowSchema,
} from "@loomwiki/schema";
import { parseScheduledActionRow } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, apiOk, id, nextFireAt, parseCronExpr } from "@loomwiki/shared";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

const WORKSPACE_QUOTA_ACTIVE = 50;
const ROOM_QUOTA_ACTIVE = 10;
const LIST_PAGE_SIZE = 50;
const LIST_MAX_PAGE_SIZE = 200;

// Serialize a ScheduledActionRow → wire-safe JSON shape (epoch seconds as numbers, nulls intact).
function serializeAction(r: ScheduledActionRow): ScheduledActionRow {
  // Row is already the right shape — we return it directly. The Zod schema
  // mirrors the D1 column types, so no conversion needed here.
  return r;
}

/** Verify the caller is a member of the given room within the caller's workspace. */
async function requireRoomMember(
  env: AuthEnv["Bindings"],
  userId: string,
  workspaceId: string,
  roomId: string,
): Promise<void> {
  const row = await env.DB.prepare("SELECT workspace_id FROM rooms WHERE id = ?")
    .bind(roomId)
    .first<{ workspace_id: string }>();
  if (!row) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Room not found", { status: 404 });
  }
  if (row.workspace_id !== workspaceId) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Room not found", { status: 404 });
  }
  const member = await env.DB.prepare(
    "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1",
  )
    .bind(roomId, userId)
    .first();
  if (!member) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Not a member of this room", { status: 403 });
  }
}

/** Check that the caller is either the row's creator or the workspace owner. */
function requireAuthorOrOwner(createdBy: string, callerId: string, workspaceOwnerId: string): void {
  if (callerId !== createdBy && callerId !== workspaceOwnerId) {
    throw new LoomwikiError(
      ErrorCodes.FORBIDDEN,
      "Only the creator or workspace owner may modify this scheduled action",
      {
        status: 403,
      },
    );
  }
}

export const scheduledActionsRoute = new Hono<AuthEnv>()
  // ---------- POST /:roomId/scheduled-actions — create ----------
  .post("/:roomId/scheduled-actions", async (c) => {
    const roomId = c.req.param("roomId");
    await requireRoomMember(c.env, c.var.user.id, c.var.workspace.id, roomId);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Request body must be JSON", {
        status: 400,
      });
    }

    const parsed = CreateScheduledActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid request body", {
        status: 400,
        details: parsed.error.issues,
      });
    }

    const req = parsed.data;
    const nowS = Math.floor(Date.now() / 1000);

    // Validate cron_expr and compute next_fire_at
    let nextFire: number;
    if (req.kind === "cron") {
      const cronParsed = parseCronExpr(req.cron_expr);
      if (!cronParsed) {
        throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid cron expression", {
          status: 400,
        });
      }
      try {
        nextFire = nextFireAt(req.cron_expr, nowS);
      } catch {
        throw new LoomwikiError(
          ErrorCodes.VALIDATION_FAILED,
          "Cron expression produces no valid next fire time within 4 years",
          {
            status: 400,
          },
        );
      }
    } else {
      // kind === 'once'
      if (req.fire_at <= nowS) {
        throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "fire_at must be in the future", {
          status: 400,
        });
      }
      nextFire = req.fire_at;
    }

    // Soft quota checks
    const wsCount = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM scheduled_actions WHERE workspace_id = ? AND status = 'active'",
    )
      .bind(c.var.workspace.id)
      .first<{ n: number }>();
    if ((wsCount?.n ?? 0) >= WORKSPACE_QUOTA_ACTIVE) {
      throw new LoomwikiError(
        ErrorCodes.VALIDATION_FAILED,
        `Workspace quota of ${WORKSPACE_QUOTA_ACTIVE} active scheduled actions reached`,
        { status: 400 },
      );
    }

    const roomCount = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM scheduled_actions WHERE room_id = ? AND status = 'active'",
    )
      .bind(roomId)
      .first<{ n: number }>();
    if ((roomCount?.n ?? 0) >= ROOM_QUOTA_ACTIVE) {
      throw new LoomwikiError(
        ErrorCodes.VALIDATION_FAILED,
        `Room quota of ${ROOM_QUOTA_ACTIVE} active scheduled actions reached`,
        { status: 400 },
      );
    }

    const actionId = id();
    const cron_expr = req.kind === "cron" ? req.cron_expr : null;
    const fire_at = req.kind === "once" ? req.fire_at : null;

    await c.env.DB.prepare(
      `INSERT INTO scheduled_actions
         (id, workspace_id, room_id, created_by, kind, cron_expr, fire_at, prompt, status,
          failure_count, last_fired_at, next_fire_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, NULL, ?, ?, ?)`,
    )
      .bind(
        actionId,
        c.var.workspace.id,
        roomId,
        c.var.user.id,
        req.kind,
        cron_expr,
        fire_at,
        req.prompt,
        nextFire,
        nowS,
        nowS,
      )
      .run();

    const row = await c.env.DB.prepare("SELECT * FROM scheduled_actions WHERE id = ?")
      .bind(actionId)
      .first();
    const action = parseScheduledActionRow(row);

    return c.json(apiOk({ action: serializeAction(action) }), 201);
  })

  // ---------- GET /:roomId/scheduled-actions — list ----------
  .get("/:roomId/scheduled-actions", async (c) => {
    const roomId = c.req.param("roomId");
    await requireRoomMember(c.env, c.var.user.id, c.var.workspace.id, roomId);

    const statusFilter = c.req.query("status"); // optional: active|paused|fired|failed
    const beforeParam = c.req.query("before"); // cursor: action id
    const limitRaw = c.req.query("limit");
    let limit = LIST_PAGE_SIZE;
    if (limitRaw !== undefined) {
      const n = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "limit must be a positive integer", {
          status: 400,
        });
      }
      limit = Math.min(n, LIST_MAX_PAGE_SIZE);
    }

    // Validate status filter if provided
    if (statusFilter !== undefined) {
      const statusResult = ScheduledActionRowSchema.shape.status.safeParse(statusFilter);
      if (!statusResult.success) {
        throw new LoomwikiError(
          ErrorCodes.VALIDATION_FAILED,
          "status must be one of: active, paused, fired, failed",
          { status: 400 },
        );
      }
    }

    const fetched = limit + 1;
    let rows: { results: unknown[] };

    if (statusFilter !== undefined && beforeParam !== undefined) {
      rows = await c.env.DB.prepare(
        "SELECT * FROM scheduled_actions WHERE room_id = ? AND status = ? AND id < ? ORDER BY id DESC LIMIT ?",
      )
        .bind(roomId, statusFilter, beforeParam, fetched)
        .all();
    } else if (statusFilter !== undefined) {
      rows = await c.env.DB.prepare(
        "SELECT * FROM scheduled_actions WHERE room_id = ? AND status = ? ORDER BY id DESC LIMIT ?",
      )
        .bind(roomId, statusFilter, fetched)
        .all();
    } else if (beforeParam !== undefined) {
      rows = await c.env.DB.prepare(
        "SELECT * FROM scheduled_actions WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
      )
        .bind(roomId, beforeParam, fetched)
        .all();
    } else {
      rows = await c.env.DB.prepare(
        "SELECT * FROM scheduled_actions WHERE room_id = ? ORDER BY id DESC LIMIT ?",
      )
        .bind(roomId, fetched)
        .all();
    }

    const parsed = rows.results.map(parseScheduledActionRow);
    const hasMore = parsed.length > limit;
    const trimmed = hasMore ? parsed.slice(0, limit) : parsed;
    trimmed.reverse();

    return c.json(apiOk({ actions: trimmed.map(serializeAction), hasMore }));
  })

  // ---------- PATCH /:roomId/scheduled-actions/:id — update ----------
  .patch("/:roomId/scheduled-actions/:id", async (c) => {
    const roomId = c.req.param("roomId");
    const actionId = c.req.param("id");
    await requireRoomMember(c.env, c.var.user.id, c.var.workspace.id, roomId);

    const existing = await c.env.DB.prepare(
      "SELECT * FROM scheduled_actions WHERE id = ? AND room_id = ?",
    )
      .bind(actionId, roomId)
      .first();
    if (!existing) {
      throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Scheduled action not found", { status: 404 });
    }
    const action = parseScheduledActionRow(existing);

    requireAuthorOrOwner(action.created_by, c.var.user.id, c.var.workspace.owner_id);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Request body must be JSON", {
        status: 400,
      });
    }

    const parsed = PatchScheduledActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid request body", {
        status: 400,
        details: parsed.error.issues,
      });
    }

    const patch = parsed.data;
    const nowS = Math.floor(Date.now() / 1000);

    // Validate cron_expr if provided
    if (patch.cron_expr !== undefined) {
      const cronParsed = parseCronExpr(patch.cron_expr);
      if (!cronParsed) {
        throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid cron expression", {
          status: 400,
        });
      }
    }

    // Validate fire_at if provided
    if (patch.fire_at !== undefined && patch.fire_at <= nowS) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "fire_at must be in the future", {
        status: 400,
      });
    }

    // Compute new next_fire_at
    let nextFire = action.next_fire_at;
    const newStatus = patch.status ?? action.status;
    const newCronExpr = patch.cron_expr ?? action.cron_expr;
    const newFireAt = patch.fire_at ?? action.fire_at;

    if (newStatus === "active") {
      // On resume or when cron_expr/fire_at changes, recompute next_fire_at
      if (
        patch.status === "active" ||
        patch.cron_expr !== undefined ||
        patch.fire_at !== undefined
      ) {
        if (action.kind === "cron") {
          const exprToUse = newCronExpr ?? "";
          if (!exprToUse) {
            throw new LoomwikiError(
              ErrorCodes.VALIDATION_FAILED,
              "cron_expr required for cron kind",
              {
                status: 400,
              },
            );
          }
          try {
            nextFire = nextFireAt(exprToUse, nowS);
          } catch {
            throw new LoomwikiError(
              ErrorCodes.VALIDATION_FAILED,
              "Cron expression produces no valid next fire time within 4 years",
              {
                status: 400,
              },
            );
          }
        } else if (action.kind === "once") {
          nextFire = newFireAt ?? action.next_fire_at;
        }
      }
    }

    await c.env.DB.prepare(
      `UPDATE scheduled_actions
       SET status = ?, cron_expr = ?, fire_at = ?, prompt = ?, next_fire_at = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        newStatus,
        newCronExpr,
        newFireAt,
        patch.prompt ?? action.prompt,
        nextFire,
        nowS,
        actionId,
      )
      .run();

    const updated = await c.env.DB.prepare("SELECT * FROM scheduled_actions WHERE id = ?")
      .bind(actionId)
      .first();
    const updatedAction = parseScheduledActionRow(updated);

    return c.json(apiOk({ action: serializeAction(updatedAction) }));
  })

  // ---------- DELETE /:roomId/scheduled-actions/:id — delete ----------
  .delete("/:roomId/scheduled-actions/:id", async (c) => {
    const roomId = c.req.param("roomId");
    const actionId = c.req.param("id");
    await requireRoomMember(c.env, c.var.user.id, c.var.workspace.id, roomId);

    const existing = await c.env.DB.prepare(
      "SELECT * FROM scheduled_actions WHERE id = ? AND room_id = ?",
    )
      .bind(actionId, roomId)
      .first();
    if (!existing) {
      throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Scheduled action not found", { status: 404 });
    }
    const action = parseScheduledActionRow(existing);

    requireAuthorOrOwner(action.created_by, c.var.user.id, c.var.workspace.owner_id);

    await c.env.DB.prepare("DELETE FROM scheduled_actions WHERE id = ?").bind(actionId).run();

    return c.json(apiOk({ deleted: true }));
  });
