// SPDX-License-Identifier: Apache-2.0

// Integration tests for task routes:
//   GET    /api/tasks
//   POST   /api/tasks
//   GET    /api/tasks/:id
//   PATCH  /api/tasks/:id
//   DELETE /api/tasks/:id

import { SELF, env } from "cloudflare:test";
import { id } from "@loomwiki/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";
import { type JwtFixture, makeJwtFixture } from "./__fixtures__/jwt.js";

let fixture: JwtFixture;

beforeAll(async () => {
  await applyMigrations();
  fixture = await makeJwtFixture();
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

beforeEach(async () => {
  await resetDb();
});

async function authedFetch(jwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("CF-Access-Jwt-Assertion", jwt);
  return SELF.fetch(`https://api.local${path}`, { ...init, headers });
}

interface Bootstrap {
  ownerJwt: string;
  ownerId: string;
  workspaceId: string;
  roomId: string;
}

async function bootstrapOwnerAndRoom(): Promise<Bootstrap> {
  const ownerJwt = await fixture.mint({ email: "owner@example.com" });
  const me = await authedFetch(ownerJwt, "/api/me");
  const meBody = (await me.json()) as {
    data: { user: { id: string }; workspace: { id: string; owner_id: string } };
  };
  const ownerId = meBody.data.user.id;
  const workspaceId = meBody.data.workspace.id;

  const createRoom = await authedFetch(ownerJwt, `/api/workspaces/${workspaceId}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: "general", name: "General" }),
  });
  const roomBody = (await createRoom.json()) as { data: { room: { id: string } } };
  const roomId = roomBody.data.room.id;

  return { ownerJwt, ownerId, workspaceId, roomId };
}

async function bootstrapSecondUser(email: string): Promise<{ jwt: string; userId: string }> {
  const jwt = await fixture.mint({ email });
  const me = await authedFetch(jwt, "/api/me");
  const meBody = (await me.json()) as { data: { user: { id: string } } };
  return { jwt, userId: meBody.data.user.id };
}

interface TaskShape {
  id: string;
  title: string;
  status: string;
  room_id: string | null;
  assignee_id: string | null;
  due_at: number | null;
  completed_at: number | null;
  tags: string[];
}

async function createTask(jwt: string, body: unknown): Promise<{ res: Response; task: TaskShape }> {
  const res = await authedFetch(jwt, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as { ok: boolean; data?: { task: TaskShape } };
  return { res, task: parsed.data?.task as TaskShape };
}

describe("POST /api/tasks", () => {
  it("returns 401 without JWT", async () => {
    const res = await SELF.fetch("https://api.local/api/tasks", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("creates a minimal roomless task defaulting to todo", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { res, task } = await createTask(ownerJwt, { title: "Fix login bug" });
    expect(res.status).toBe(201);
    expect(task.status).toBe("todo");
    expect(task.room_id).toBeNull();
    expect(task.tags).toEqual([]);
  });

  it("creates a room-scoped task with tags, assignee, due date", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const bob = await bootstrapSecondUser("bob@example.com");
    const due = 1789344000; // 2026-09-14T00:00:00Z
    const { res, task } = await createTask(ownerJwt, {
      title: "Ship M9",
      room_id: roomId,
      assignee_id: bob.userId,
      due_at: due,
      tags: ["m9", "backend"],
    });
    expect(res.status).toBe(201);
    expect(task.room_id).toBe(roomId);
    expect(task.assignee_id).toBe(bob.userId);
    expect(task.due_at).toBe(due);
    expect(task.tags).toEqual(["backend", "m9"]);
  });

  it("404s an unknown room", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { res } = await createTask(ownerJwt, { title: "x", room_id: id() });
    expect(res.status).toBe(404);
  });

  it("403s a viewer writing a room-scoped task", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const eve = await bootstrapSecondUser("eve@example.com");
    await env.DB.prepare(
      "INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, 'viewer')",
    )
      .bind(roomId, eve.userId)
      .run();
    const { res } = await createTask(eve.jwt, { title: "x", room_id: roomId });
    expect(res.status).toBe(403);
  });

  it("400s an unknown assignee", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { res } = await createTask(ownerJwt, { title: "x", assignee_id: id() });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/tasks — filters + pagination", () => {
  it("filters by status, tag, and assignee", async () => {
    const { ownerJwt, ownerId } = await bootstrapOwnerAndRoom();
    await createTask(ownerJwt, { title: "a", status: "done" });
    await createTask(ownerJwt, { title: "b", tags: ["bug"] });
    await createTask(ownerJwt, { title: "c", assignee_id: ownerId });

    const byStatus = await authedFetch(ownerJwt, "/api/tasks?status=done");
    const s = (await byStatus.json()) as { data: { tasks: TaskShape[] } };
    expect(s.data.tasks.map((t) => t.title)).toEqual(["a"]);

    const byTag = await authedFetch(ownerJwt, "/api/tasks?tag=bug");
    const g = (await byTag.json()) as { data: { tasks: TaskShape[] } };
    expect(g.data.tasks.map((t) => t.title)).toEqual(["b"]);

    const byAssignee = await authedFetch(ownerJwt, `/api/tasks?assignee=${ownerId}`);
    const a = (await byAssignee.json()) as { data: { tasks: TaskShape[] } };
    expect(a.data.tasks.map((t) => t.title)).toEqual(["c"]);
  });

  it("paginates with before-cursor", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    await createTask(ownerJwt, { title: "t1" });
    await createTask(ownerJwt, { title: "t2" });
    await createTask(ownerJwt, { title: "t3" });

    const page1 = await authedFetch(ownerJwt, "/api/tasks?limit=2");
    const p1 = (await page1.json()) as { data: { tasks: TaskShape[]; hasMore: boolean } };
    expect(p1.data.hasMore).toBe(true);
    expect(p1.data.tasks.map((t) => t.title)).toEqual(["t2", "t3"]); // oldest-first within page
    const oldestOnPage = p1.data.tasks[0];
    if (!oldestOnPage) throw new Error("unreachable");

    const page2 = await authedFetch(ownerJwt, `/api/tasks?limit=2&before=${oldestOnPage.id}`);
    const p2 = (await page2.json()) as { data: { tasks: TaskShape[]; hasMore: boolean } };
    expect(p2.data.hasMore).toBe(false);
    expect(p2.data.tasks.map((t) => t.title)).toEqual(["t1"]);
  });
});

describe("PATCH /api/tasks/:id", () => {
  it("status→done stamps completed_at; leaving done clears it", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { task } = await createTask(ownerJwt, { title: "x" });

    const done = await authedFetch(ownerJwt, `/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    const d = (await done.json()) as { data: { task: TaskShape } };
    expect(d.data.task.status).toBe("done");
    expect(d.data.task.completed_at).not.toBeNull();

    const reopen = await authedFetch(ownerJwt, `/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "doing" }),
    });
    const r = (await reopen.json()) as { data: { task: TaskShape } };
    expect(r.data.task.status).toBe("doing");
    expect(r.data.task.completed_at).toBeNull();
  });

  it("replaces tags", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { task } = await createTask(ownerJwt, { title: "x", tags: ["old"] });
    const res = await authedFetch(ownerJwt, `/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["new-a", "new-b"] }),
    });
    const b = (await res.json()) as { data: { task: TaskShape } };
    expect(b.data.task.tags).toEqual(["new-a", "new-b"]);
  });

  it("400s an empty patch", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { task } = await createTask(ownerJwt, { title: "x" });
    const res = await authedFetch(ownerJwt, `/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/tasks/:id", () => {
  it("hard-deletes the task and its tags", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { task } = await createTask(ownerJwt, { title: "x", tags: ["a"] });
    const res = await authedFetch(ownerJwt, `/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const gone = await authedFetch(ownerJwt, `/api/tasks/${task.id}`);
    expect(gone.status).toBe(404);
    const tagRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM task_tags WHERE task_id = ?")
      .bind(task.id)
      .first<{ n: number }>();
    expect(tagRows?.n).toBe(0);
  });
});
