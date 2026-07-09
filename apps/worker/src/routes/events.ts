// SPDX-License-Identifier: Apache-2.0

// Event routes (v0.1 M9). Mounted at /api:
//   GET    /api/events                       — range list (from/to required)
//   POST   /api/events                       — create
//   GET    /api/events/:id                   — detail (cancelled readable)
//   PATCH  /api/events/:id                   — partial update
//   DELETE /api/events/:id                   — SOFT-cancel (sets cancelled_at)
//   POST   /api/events/:id/attendees/:uid    — add attendee (idempotent)
//   DELETE /api/events/:id/attendees/:uid    — remove attendee (idempotent)
//
// Access mirrors routes/tasks.ts: reads open to workspace members; writes on
// room-scoped events require membership with role != 'viewer'.

import {
  CreateEventRequestSchema,
  type EventRow,
  type EventWithAttendees,
  PatchEventRequestSchema,
} from "@loomwiki/schema";
import { parseEventRow } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, apiOk, id } from "@loomwiki/shared";
import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AuthEnv } from "../middleware/auth.js";
import { requireWriteAccess } from "./tasks.js";

const RANGE_MAX_S = 92 * 86400;
const LIST_LIMIT = 500;

async function requireRoomInWorkspace(
  env: Env,
  workspaceId: string,
  roomId: string,
): Promise<void> {
  const row = await env.DB.prepare("SELECT workspace_id FROM rooms WHERE id = ?")
    .bind(roomId)
    .first<{ workspace_id: string }>();
  if (!row || row.workspace_id !== workspaceId) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Room not found", { status: 404 });
  }
}

async function requireUsersExist(env: Env, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const placeholders = userIds.map(() => "?").join(",");
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE id IN (${placeholders})`)
    .bind(...userIds)
    .first<{ n: number }>();
  if ((row?.n ?? 0) !== new Set(userIds).size) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "attendee is not a workspace user", {
      status: 400,
    });
  }
}

async function fetchAttendees(env: Env, eventId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT user_id FROM event_attendees WHERE event_id = ? ORDER BY user_id",
  )
    .bind(eventId)
    .all<{ user_id: string }>();
  return rows.results.map((r) => r.user_id);
}

async function loadEventRow(env: Env, workspaceId: string, eventId: string): Promise<EventRow> {
  const row = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first();
  if (!row) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Event not found", { status: 404 });
  }
  const event = parseEventRow(row);
  if (event.workspace_id !== workspaceId) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Event not found", { status: 404 });
  }
  return event;
}

async function withAttendees(env: Env, row: EventRow): Promise<EventWithAttendees> {
  return { ...row, attendee_ids: await fetchAttendees(env, row.id) };
}

async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Request body must be JSON", {
      status: 400,
    });
  }
}

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

export function validateRange(from: number, to: number): void {
  if (to <= from) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "to must be greater than from", {
      status: 400,
    });
  }
  if (to - from > RANGE_MAX_S) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "range must be 92 days or less", {
      status: 400,
    });
  }
}

export const eventsRoute = new Hono<AuthEnv>()
  // ---------- GET /events — range list ----------
  .get("/events", async (c) => {
    const from = requireEpochQuery(c.req.query("from"), "from");
    const to = requireEpochQuery(c.req.query("to"), "to");
    validateRange(from, to);

    const conditions = [
      "workspace_id = ?",
      "cancelled_at IS NULL",
      "starts_at < ?",
      "COALESCE(ends_at, starts_at) >= ?",
    ];
    const binds: unknown[] = [c.var.workspace.id, to, from];
    const room = c.req.query("room");
    if (room !== undefined) {
      conditions.push("room_id = ?");
      binds.push(room);
    }
    binds.push(LIST_LIMIT + 1);

    const rows = await c.env.DB.prepare(
      `SELECT * FROM events WHERE ${conditions.join(" AND ")} ORDER BY starts_at ASC, id ASC LIMIT ?`,
    )
      .bind(...binds)
      .all();
    const parsed = rows.results.map(parseEventRow);
    const hasMore = parsed.length > LIST_LIMIT;
    const trimmed = hasMore ? parsed.slice(0, LIST_LIMIT) : parsed;

    const events: EventWithAttendees[] = [];
    for (const row of trimmed) {
      events.push(await withAttendees(c.env, row));
    }
    return c.json(apiOk({ events, hasMore }));
  })

  // ---------- POST /events — create ----------
  .post("/events", async (c) => {
    const parsed = CreateEventRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid request body", {
        status: 400,
        details: parsed.error.issues,
      });
    }
    const req = parsed.data;
    const roomId = req.room_id ?? null;
    if (roomId !== null) {
      await requireRoomInWorkspace(c.env, c.var.workspace.id, roomId);
    }
    await requireWriteAccess(c.env, c.var.user.id, roomId);
    const attendees = req.attendee_ids ?? [];
    await requireUsersExist(c.env, attendees);

    const eventId = id();
    const nowS = Math.floor(Date.now() / 1000);

    await c.env.DB.prepare(
      `INSERT INTO events
         (id, workspace_id, room_id, title, body, starts_at, ends_at, all_day, rrule,
          origin_message_id, created_by, created_at, updated_at, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
    )
      .bind(
        eventId,
        c.var.workspace.id,
        roomId,
        req.title,
        req.body ?? null,
        req.starts_at,
        req.ends_at ?? null,
        req.all_day === true ? 1 : 0,
        c.var.user.id,
        nowS,
        nowS,
      )
      .run();

    if (attendees.length > 0) {
      await c.env.DB.batch(
        attendees.map((uid) =>
          c.env.DB.prepare(
            "INSERT OR IGNORE INTO event_attendees (event_id, user_id) VALUES (?, ?)",
          ).bind(eventId, uid),
        ),
      );
    }

    const event = await withAttendees(
      c.env,
      await loadEventRow(c.env, c.var.workspace.id, eventId),
    );
    return c.json(apiOk({ event }), 201);
  })

  // ---------- GET /events/:id ----------
  .get("/events/:id", async (c) => {
    const event = await withAttendees(
      c.env,
      await loadEventRow(c.env, c.var.workspace.id, c.req.param("id")),
    );
    return c.json(apiOk({ event }));
  })

  // ---------- PATCH /events/:id ----------
  .patch("/events/:id", async (c) => {
    const existing = await loadEventRow(c.env, c.var.workspace.id, c.req.param("id"));
    await requireWriteAccess(c.env, c.var.user.id, existing.room_id);

    const parsed = PatchEventRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid request body", {
        status: 400,
        details: parsed.error.issues,
      });
    }
    const patch = parsed.data;

    const newRoomId = patch.room_id !== undefined ? patch.room_id : existing.room_id;
    if (patch.room_id !== undefined && patch.room_id !== null) {
      await requireRoomInWorkspace(c.env, c.var.workspace.id, patch.room_id);
      await requireWriteAccess(c.env, c.var.user.id, patch.room_id);
    }

    const newStarts = patch.starts_at ?? existing.starts_at;
    const newEnds = patch.ends_at !== undefined ? patch.ends_at : existing.ends_at;
    if (newEnds !== null && newEnds < newStarts) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "ends_at must be >= starts_at", {
        status: 400,
      });
    }

    const nowS = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `UPDATE events
       SET title = ?, body = ?, room_id = ?, starts_at = ?, ends_at = ?, all_day = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        patch.title ?? existing.title,
        patch.body !== undefined ? patch.body : existing.body,
        newRoomId,
        newStarts,
        newEnds,
        patch.all_day !== undefined ? (patch.all_day ? 1 : 0) : existing.all_day,
        nowS,
        existing.id,
      )
      .run();

    const event = await withAttendees(
      c.env,
      await loadEventRow(c.env, c.var.workspace.id, existing.id),
    );
    return c.json(apiOk({ event }));
  })

  // ---------- DELETE /events/:id — soft-cancel ----------
  .delete("/events/:id", async (c) => {
    const existing = await loadEventRow(c.env, c.var.workspace.id, c.req.param("id"));
    await requireWriteAccess(c.env, c.var.user.id, existing.room_id);
    if (existing.cancelled_at === null) {
      const nowS = Math.floor(Date.now() / 1000);
      await c.env.DB.prepare("UPDATE events SET cancelled_at = ?, updated_at = ? WHERE id = ?")
        .bind(nowS, nowS, existing.id)
        .run();
    }
    const event = await withAttendees(
      c.env,
      await loadEventRow(c.env, c.var.workspace.id, existing.id),
    );
    return c.json(apiOk({ event }));
  })

  // ---------- POST /events/:id/attendees/:uid ----------
  .post("/events/:id/attendees/:uid", async (c) => {
    const existing = await loadEventRow(c.env, c.var.workspace.id, c.req.param("id"));
    await requireWriteAccess(c.env, c.var.user.id, existing.room_id);
    const uid = c.req.param("uid");
    await requireUsersExist(c.env, [uid]);
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO event_attendees (event_id, user_id) VALUES (?, ?)",
    )
      .bind(existing.id, uid)
      .run();
    const event = await withAttendees(c.env, existing);
    return c.json(apiOk({ event }));
  })

  // ---------- DELETE /events/:id/attendees/:uid ----------
  .delete("/events/:id/attendees/:uid", async (c) => {
    const existing = await loadEventRow(c.env, c.var.workspace.id, c.req.param("id"));
    await requireWriteAccess(c.env, c.var.user.id, existing.room_id);
    await c.env.DB.prepare("DELETE FROM event_attendees WHERE event_id = ? AND user_id = ?")
      .bind(existing.id, c.req.param("uid"))
      .run();
    const event = await withAttendees(c.env, existing);
    return c.json(apiOk({ event }));
  });
