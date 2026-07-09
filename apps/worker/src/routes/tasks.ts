// SPDX-License-Identifier: Apache-2.0

// Task routes (v0.1 M9). Mounted at /api (absolute paths declared here):
//   GET    /api/tasks       — workspace list w/ filters + before-cursor
//   POST   /api/tasks       — create
//   GET    /api/tasks/:id   — detail (with tags)
//   PATCH  /api/tasks/:id   — partial update (kanban drag = status patch)
//   DELETE /api/tasks/:id   — hard delete (task_tags first; D1 enforces FKs)
//
// Access: any workspace member reads everything (rooms are organizational,
// not ACLs — design doc §2). Writes on a room-scoped task require room
// membership with role != 'viewer'; roomless tasks are writable by any
// workspace member.

import {
  CreateTaskRequestSchema,
  PatchTaskRequestSchema,
  type Task,
  type TaskRow,
  TaskStatusSchema,
} from "@loomwiki/schema";
import { parseTaskRow } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, apiOk, id } from "@loomwiki/shared";
import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AuthEnv } from "../middleware/auth.js";

const LIST_PAGE_SIZE = 50;
const LIST_MAX_PAGE_SIZE = 200;

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

/**
 * Room-scoped writes require membership with role != 'viewer'.
 * Roomless (room_id null) writes are open to any workspace member.
 * Exported for reuse by routes/events.ts.
 */
export async function requireWriteAccess(
  env: Env,
  userId: string,
  roomId: string | null,
): Promise<void> {
  if (roomId === null) return;
  const member = await env.DB.prepare(
    "SELECT role FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1",
  )
    .bind(roomId, userId)
    .first<{ role: string }>();
  if (!member) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Not a member of this room", { status: 403 });
  }
  if (member.role === "viewer") {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Viewers cannot modify items", { status: 403 });
  }
}

async function requireUserExists(env: Env, userId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT 1 FROM users WHERE id = ? LIMIT 1").bind(userId).first();
  if (!row) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "assignee_id is not a workspace user", {
      status: 400,
    });
  }
}

async function fetchTagsFor(env: Env, taskIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (taskIds.length === 0) return map;
  const placeholders = taskIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT task_id, tag FROM task_tags WHERE task_id IN (${placeholders}) ORDER BY tag`,
  )
    .bind(...taskIds)
    .all<{ task_id: string; tag: string }>();
  for (const r of rows.results) {
    const list = map.get(r.task_id) ?? [];
    list.push(r.tag);
    map.set(r.task_id, list);
  }
  return map;
}

async function replaceTags(env: Env, taskId: string, tags: string[]): Promise<void> {
  const stmts = [env.DB.prepare("DELETE FROM task_tags WHERE task_id = ?").bind(taskId)];
  for (const tag of tags) {
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES (?, ?)").bind(
        taskId,
        tag,
      ),
    );
  }
  await env.DB.batch(stmts);
}

async function loadTaskRow(env: Env, workspaceId: string, taskId: string): Promise<TaskRow> {
  const row = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
  if (!row) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Task not found", { status: 404 });
  }
  const task = parseTaskRow(row);
  if (task.workspace_id !== workspaceId) {
    // Cross-workspace defense in depth: 404, not 403.
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Task not found", { status: 404 });
  }
  return task;
}

async function withTags(env: Env, row: TaskRow): Promise<Task> {
  const tags = (await fetchTagsFor(env, [row.id])).get(row.id) ?? [];
  return { ...row, tags };
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

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return LIST_PAGE_SIZE;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "limit must be a positive integer", {
      status: 400,
    });
  }
  return Math.min(n, LIST_MAX_PAGE_SIZE);
}

function parseEpochQuery(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, `${name} must be epoch seconds`, {
      status: 400,
    });
  }
  return n;
}

export const tasksRoute = new Hono<AuthEnv>()
  // ---------- GET /tasks — list ----------
  .get("/tasks", async (c) => {
    const conditions = ["workspace_id = ?"];
    const binds: unknown[] = [c.var.workspace.id];

    const status = c.req.query("status");
    if (status !== undefined) {
      if (!TaskStatusSchema.safeParse(status).success) {
        throw new LoomwikiError(
          ErrorCodes.VALIDATION_FAILED,
          "status must be one of: backlog, todo, doing, done, cancelled",
          { status: 400 },
        );
      }
      conditions.push("status = ?");
      binds.push(status);
    }
    const room = c.req.query("room");
    if (room !== undefined) {
      conditions.push("room_id = ?");
      binds.push(room);
    }
    const assignee = c.req.query("assignee");
    if (assignee !== undefined) {
      conditions.push("assignee_id = ?");
      binds.push(assignee);
    }
    const tag = c.req.query("tag");
    if (tag !== undefined) {
      conditions.push(
        "EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = tasks.id AND tt.tag = ?)",
      );
      binds.push(tag);
    }
    const dueBefore = parseEpochQuery(c.req.query("due_before"), "due_before");
    if (dueBefore !== undefined) {
      conditions.push("due_at IS NOT NULL AND due_at < ?");
      binds.push(dueBefore);
    }
    const dueAfter = parseEpochQuery(c.req.query("due_after"), "due_after");
    if (dueAfter !== undefined) {
      conditions.push("due_at IS NOT NULL AND due_at >= ?");
      binds.push(dueAfter);
    }
    const before = c.req.query("before");
    if (before !== undefined) {
      conditions.push("id < ?");
      binds.push(before);
    }

    const limit = parseLimit(c.req.query("limit"));
    const fetched = limit + 1;
    binds.push(fetched);

    const rows = await c.env.DB.prepare(
      `SELECT * FROM tasks WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`,
    )
      .bind(...binds)
      .all();

    const parsed = rows.results.map(parseTaskRow);
    const hasMore = parsed.length > limit;
    const trimmed = hasMore ? parsed.slice(0, limit) : parsed;
    trimmed.reverse(); // oldest-first within the page (repo cursor convention)

    const tagMap = await fetchTagsFor(
      c.env,
      trimmed.map((t) => t.id),
    );
    const tasks: Task[] = trimmed.map((t) => ({ ...t, tags: tagMap.get(t.id) ?? [] }));

    return c.json(apiOk({ tasks, hasMore }));
  })

  // ---------- POST /tasks — create ----------
  .post("/tasks", async (c) => {
    const parsed = CreateTaskRequestSchema.safeParse(await readJsonBody(c));
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
    const assigneeId = req.assignee_id ?? null;
    if (assigneeId !== null) {
      await requireUserExists(c.env, assigneeId);
    }

    const taskId = id();
    const nowS = Math.floor(Date.now() / 1000);
    const status = req.status ?? "todo";

    await c.env.DB.prepare(
      `INSERT INTO tasks
         (id, workspace_id, room_id, title, body, status, assignee_id, due_at,
          origin_message_id, created_by, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
      .bind(
        taskId,
        c.var.workspace.id,
        roomId,
        req.title,
        req.body ?? null,
        status,
        assigneeId,
        req.due_at ?? null,
        c.var.user.id,
        nowS,
        nowS,
        status === "done" ? nowS : null,
      )
      .run();

    if (req.tags !== undefined && req.tags.length > 0) {
      await replaceTags(c.env, taskId, req.tags);
    }

    const task = await withTags(c.env, await loadTaskRow(c.env, c.var.workspace.id, taskId));
    return c.json(apiOk({ task }), 201);
  })

  // ---------- GET /tasks/:id ----------
  .get("/tasks/:id", async (c) => {
    const task = await withTags(
      c.env,
      await loadTaskRow(c.env, c.var.workspace.id, c.req.param("id")),
    );
    return c.json(apiOk({ task }));
  })

  // ---------- PATCH /tasks/:id ----------
  .patch("/tasks/:id", async (c) => {
    const existing = await loadTaskRow(c.env, c.var.workspace.id, c.req.param("id"));
    await requireWriteAccess(c.env, c.var.user.id, existing.room_id);

    const parsed = PatchTaskRequestSchema.safeParse(await readJsonBody(c));
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
    const newAssignee = patch.assignee_id !== undefined ? patch.assignee_id : existing.assignee_id;
    if (patch.assignee_id !== undefined && patch.assignee_id !== null) {
      await requireUserExists(c.env, patch.assignee_id);
    }

    const nowS = Math.floor(Date.now() / 1000);
    const newStatus = patch.status ?? existing.status;
    let completedAt = existing.completed_at;
    if (patch.status !== undefined && patch.status !== existing.status) {
      completedAt = patch.status === "done" ? nowS : null;
    }

    await c.env.DB.prepare(
      `UPDATE tasks
       SET title = ?, body = ?, status = ?, room_id = ?, assignee_id = ?, due_at = ?,
           updated_at = ?, completed_at = ?
       WHERE id = ?`,
    )
      .bind(
        patch.title ?? existing.title,
        patch.body !== undefined ? patch.body : existing.body,
        newStatus,
        newRoomId,
        newAssignee,
        patch.due_at !== undefined ? patch.due_at : existing.due_at,
        nowS,
        completedAt,
        existing.id,
      )
      .run();

    if (patch.tags !== undefined) {
      await replaceTags(c.env, existing.id, patch.tags);
    }

    const task = await withTags(c.env, await loadTaskRow(c.env, c.var.workspace.id, existing.id));
    return c.json(apiOk({ task }));
  })

  // ---------- DELETE /tasks/:id ----------
  .delete("/tasks/:id", async (c) => {
    const existing = await loadTaskRow(c.env, c.var.workspace.id, c.req.param("id"));
    await requireWriteAccess(c.env, c.var.user.id, existing.room_id);
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM task_tags WHERE task_id = ?").bind(existing.id),
      c.env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(existing.id),
    ]);
    return c.json(apiOk({ deleted: true }));
  });
