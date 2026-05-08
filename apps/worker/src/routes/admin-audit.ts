// SPDX-License-Identifier: Apache-2.0

// Admin — audit log read API (M8 / SPEC §22 / ADR-0007).
//
//   GET /api/_admin/audit?since=&limit=&action=
//
// Owner-only. Returns recent audit-log rows for the current workspace,
// newest first. Pagination via UUIDv7 cursor: pass the `id` of the
// last row from the previous page as `since`, and the next call returns
// rows with `id < since` (UUIDv7 is sortable, so this orders by time).
//
// Optional `action` query filters to a single AuditAction value. v0.0.1
// returns JSON only; a web UI lands in v0.1.

import { AuditActionSchema, Uuidv7Schema } from "@loomwiki/schema";
import { parseAuditLogRow } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function requireOwner(c: {
  var: { user: { id: string }; workspace: { owner_id: string } };
}): void {
  if (c.var.workspace.owner_id !== c.var.user.id) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Workspace admin only", { status: 403 });
  }
}

export const adminAuditRoute = new Hono<AuthEnv>().get("/_admin/audit", async (c) => {
  requireOwner(c);

  const sinceRaw = c.req.query("since");
  let since: string | null = null;
  if (sinceRaw !== undefined && sinceRaw.length > 0) {
    const parsed = Uuidv7Schema.safeParse(sinceRaw);
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "since must be a UUIDv7 cursor", {
        status: 400,
      });
    }
    since = parsed.data;
  }

  const limitRaw = c.req.query("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const parsedLimit = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "limit must be a positive integer", {
        status: 400,
      });
    }
    limit = Math.min(parsedLimit, MAX_LIMIT);
  }

  const actionRaw = c.req.query("action");
  let actionFilter: string | null = null;
  if (actionRaw !== undefined && actionRaw.length > 0) {
    const parsedAction = AuditActionSchema.safeParse(actionRaw);
    if (!parsedAction.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Unknown audit action", {
        status: 400,
      });
    }
    actionFilter = parsedAction.data;
  }

  // Build the query dynamically — D1 prepare doesn't support optional
  // bind clauses, so we pick the right SQL once and bind the right
  // tuple. Order by created_at DESC, id DESC so the cursor (which is
  // monotonic-on-time UUIDv7) yields a stable page even when two rows
  // share a created_at second.
  let rs: D1Result<Record<string, unknown>>;
  if (since !== null && actionFilter !== null) {
    rs = await c.env.DB.prepare(
      `SELECT id, workspace_id, actor_user_id, action, resource_kind, resource_id,
              before_json, after_json, request_id, created_at
         FROM audit_log
        WHERE workspace_id = ? AND id < ? AND action = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
      .bind(c.var.workspace.id, since, actionFilter, limit)
      .all();
  } else if (since !== null) {
    rs = await c.env.DB.prepare(
      `SELECT id, workspace_id, actor_user_id, action, resource_kind, resource_id,
              before_json, after_json, request_id, created_at
         FROM audit_log
        WHERE workspace_id = ? AND id < ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
      .bind(c.var.workspace.id, since, limit)
      .all();
  } else if (actionFilter !== null) {
    rs = await c.env.DB.prepare(
      `SELECT id, workspace_id, actor_user_id, action, resource_kind, resource_id,
              before_json, after_json, request_id, created_at
         FROM audit_log
        WHERE workspace_id = ? AND action = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
      .bind(c.var.workspace.id, actionFilter, limit)
      .all();
  } else {
    rs = await c.env.DB.prepare(
      `SELECT id, workspace_id, actor_user_id, action, resource_kind, resource_id,
              before_json, after_json, request_id, created_at
         FROM audit_log
        WHERE workspace_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
      .bind(c.var.workspace.id, limit)
      .all();
  }

  const entries = (rs.results ?? []).map((r) => parseAuditLogRow(r));
  let nextCursor: string | null = null;
  if (entries.length === limit) {
    // The smallest id in this page (last entry, since DESC order) is
    // the cursor for the next page. Caller passes it back as `since`
    // and gets rows strictly older than this.
    const last = entries[entries.length - 1];
    nextCursor = last?.id ?? null;
  }

  return c.json(apiOk({ entries, next_cursor: nextCursor }));
});

// Local type alias for the dynamic-query result shape.
type D1Result<T> = { results?: T[] };
