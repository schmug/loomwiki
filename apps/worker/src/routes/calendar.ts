// SPDX-License-Identifier: Apache-2.0

// Calendar union route (v0.1 M9). Mounted at /api:
//   GET /api/calendar?from=&to=&room=&user=
//
// Query-time union of non-cancelled events overlapping [from, to) and tasks
// with due_at in [from, to) — tasks of every status (the entry carries
// `status` so the UI can style done/cancelled). No pagination: the range cap
// (92 days) bounds the result set; the calendar UI always queries one grid.

import type { CalendarEntry } from "@loomwiki/schema";
import { parseEventRow, parseTaskRow } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";
import { validateRange } from "./events.js";

function requireEpochQuery(raw: string | undefined, name: string): number {
  if (raw === undefined) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, `${name} is required (epoch seconds)`, {
      status: 400,
    });
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, `${name} must be epoch seconds`, {
      status: 400,
    });
  }
  return n;
}

function entryInstant(e: CalendarEntry): number {
  return e.kind === "event" ? e.starts_at : e.due_at;
}

export const calendarRoute = new Hono<AuthEnv>().get("/calendar", async (c) => {
  const from = requireEpochQuery(c.req.query("from"), "from");
  const to = requireEpochQuery(c.req.query("to"), "to");
  validateRange(from, to);
  const room = c.req.query("room");
  const user = c.req.query("user");

  // Events overlapping the window.
  const eventConds = [
    "workspace_id = ?",
    "cancelled_at IS NULL",
    "starts_at < ?",
    "COALESCE(ends_at, starts_at) >= ?",
  ];
  const eventBinds: unknown[] = [c.var.workspace.id, to, from];
  if (room !== undefined) {
    eventConds.push("room_id = ?");
    eventBinds.push(room);
  }
  if (user !== undefined) {
    eventConds.push(
      "(created_by = ? OR EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_id = events.id AND ea.user_id = ?))",
    );
    eventBinds.push(user, user);
  }
  const eventRows = await c.env.DB.prepare(
    `SELECT * FROM events WHERE ${eventConds.join(" AND ")} ORDER BY starts_at ASC`,
  )
    .bind(...eventBinds)
    .all();

  // Tasks with a due date inside the window.
  const taskConds = ["workspace_id = ?", "due_at IS NOT NULL", "due_at >= ?", "due_at < ?"];
  const taskBinds: unknown[] = [c.var.workspace.id, from, to];
  if (room !== undefined) {
    taskConds.push("room_id = ?");
    taskBinds.push(room);
  }
  if (user !== undefined) {
    taskConds.push("(assignee_id = ? OR created_by = ?)");
    taskBinds.push(user, user);
  }
  const taskRows = await c.env.DB.prepare(
    `SELECT * FROM tasks WHERE ${taskConds.join(" AND ")} ORDER BY due_at ASC`,
  )
    .bind(...taskBinds)
    .all();

  const entries: CalendarEntry[] = [
    ...eventRows.results.map(parseEventRow).map(
      (e): CalendarEntry => ({
        kind: "event",
        id: e.id,
        title: e.title,
        room_id: e.room_id,
        starts_at: e.starts_at,
        ends_at: e.ends_at,
        all_day: e.all_day,
      }),
    ),
    ...taskRows.results.map(parseTaskRow).map(
      (t): CalendarEntry => ({
        kind: "task_due",
        id: t.id,
        title: t.title,
        status: t.status,
        room_id: t.room_id,
        assignee_id: t.assignee_id,
        // due_at is non-null by the WHERE clause; assert for the type system.
        due_at: t.due_at ?? 0,
      }),
    ),
  ];
  entries.sort((a, b) => entryInstant(a) - entryInstant(b) || (a.id < b.id ? -1 : 1));

  return c.json(apiOk({ entries, from, to }));
});
