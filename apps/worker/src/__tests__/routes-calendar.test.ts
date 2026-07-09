// SPDX-License-Identifier: Apache-2.0

// Integration tests for the calendar union route:
//   GET /api/calendar

import { SELF, env } from "cloudflare:test";
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

interface EventShape {
  id: string;
  title: string;
  room_id: string | null;
  starts_at: number;
  ends_at: number | null;
  all_day: 0 | 1;
  cancelled_at: number | null;
  attendee_ids: string[];
}

async function createEvent(
  jwt: string,
  body: unknown,
): Promise<{ res: Response; event: EventShape }> {
  const res = await authedFetch(jwt, "/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as { ok: boolean; data?: { event: EventShape } };
  return { res, event: parsed.data?.event as EventShape };
}

const T0 = 1789344000; // 2026-09-14T00:00:00Z
const DAY = 86400;

describe("GET /api/calendar", () => {
  it("returns 401 without JWT and 400 without range", async () => {
    expect((await SELF.fetch("https://api.local/api/calendar")).status).toBe(401);
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    expect((await authedFetch(ownerJwt, "/api/calendar")).status).toBe(400);
  });

  it("unions events and due tasks sorted by instant", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    await createEvent(ownerJwt, { title: "release", starts_at: T0 + 2 * DAY });
    await createTask(ownerJwt, { title: "prep notes", due_at: T0 + 1 * DAY });
    await createTask(ownerJwt, { title: "no due date" });

    const res = await authedFetch(ownerJwt, `/api/calendar?from=${T0}&to=${T0 + 7 * DAY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ kind: string; title: string }> };
    };
    expect(body.data.entries.map((e) => `${e.kind}:${e.title}`)).toEqual([
      "task_due:prep notes",
      "event:release",
    ]);
  });

  it("filters by room and by user", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const bob = await bootstrapSecondUser("bob@example.com");
    await createTask(ownerJwt, { title: "room task", room_id: roomId, due_at: T0 + DAY });
    await createTask(ownerJwt, { title: "bob task", assignee_id: bob.userId, due_at: T0 + DAY });
    await createEvent(ownerJwt, {
      title: "bob event",
      starts_at: T0 + DAY,
      attendee_ids: [bob.userId],
    });

    const byRoom = await authedFetch(
      ownerJwt,
      `/api/calendar?from=${T0}&to=${T0 + 7 * DAY}&room=${roomId}`,
    );
    const r = (await byRoom.json()) as { data: { entries: Array<{ title: string }> } };
    expect(r.data.entries.map((e) => e.title)).toEqual(["room task"]);

    const byUser = await authedFetch(
      ownerJwt,
      `/api/calendar?from=${T0}&to=${T0 + 7 * DAY}&user=${bob.userId}`,
    );
    const u = (await byUser.json()) as { data: { entries: Array<{ title: string }> } };
    expect(u.data.entries.map((e) => e.title).sort()).toEqual(["bob event", "bob task"]);
  });
});
