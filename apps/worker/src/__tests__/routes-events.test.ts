// SPDX-License-Identifier: Apache-2.0

// Integration tests for event routes:
//   GET    /api/events
//   POST   /api/events
//   GET    /api/events/:id
//   PATCH  /api/events/:id
//   DELETE /api/events/:id
//   POST   /api/events/:id/attendees/:uid
//   DELETE /api/events/:id/attendees/:uid

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

const T0 = 1789344000; // 2026-09-14T00:00:00Z
const DAY = 86400;

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

describe("POST /api/events", () => {
  it("returns 401 without JWT", async () => {
    const res = await SELF.fetch("https://api.local/api/events", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("creates a timed event with attendees", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const bob = await bootstrapSecondUser("bob@example.com");
    const { res, event } = await createEvent(ownerJwt, {
      title: "Standup",
      starts_at: T0 + 9 * 3600,
      ends_at: T0 + 9 * 3600 + 1800,
      attendee_ids: [bob.userId],
    });
    expect(res.status).toBe(201);
    expect(event.all_day).toBe(0);
    expect(event.attendee_ids).toEqual([bob.userId]);
  });

  it("400s ends_at before starts_at and unknown attendees", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const bad1 = await createEvent(ownerJwt, { title: "x", starts_at: T0, ends_at: T0 - 1 });
    expect(bad1.res.status).toBe(400);
    const bad2 = await createEvent(ownerJwt, { title: "x", starts_at: T0, attendee_ids: [id()] });
    expect(bad2.res.status).toBe(400);
  });
});

describe("GET /api/events — range list", () => {
  it("requires from/to and rejects oversize ranges", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    expect((await authedFetch(ownerJwt, "/api/events")).status).toBe(400);
    const tooBig = await authedFetch(ownerJwt, `/api/events?from=${T0}&to=${T0 + 100 * DAY}`);
    expect(tooBig.status).toBe(400);
  });

  it("returns overlapping events only, excluding cancelled", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    await createEvent(ownerJwt, { title: "inside", starts_at: T0 + DAY });
    await createEvent(ownerJwt, {
      title: "straddles-start",
      starts_at: T0 - 3600,
      ends_at: T0 + 3600,
    });
    await createEvent(ownerJwt, { title: "outside", starts_at: T0 + 30 * DAY });
    const { event: cancelled } = await createEvent(ownerJwt, {
      title: "gone",
      starts_at: T0 + DAY,
    });
    await authedFetch(ownerJwt, `/api/events/${cancelled.id}`, { method: "DELETE" });

    const res = await authedFetch(ownerJwt, `/api/events?from=${T0}&to=${T0 + 7 * DAY}`);
    const body = (await res.json()) as { data: { events: EventShape[] } };
    expect(body.data.events.map((e) => e.title)).toEqual(["straddles-start", "inside"]);
  });
});

describe("PATCH + DELETE + attendees", () => {
  it("soft-cancels on DELETE, idempotently; detail stays readable", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { event } = await createEvent(ownerJwt, { title: "x", starts_at: T0 });
    const del1 = await authedFetch(ownerJwt, `/api/events/${event.id}`, { method: "DELETE" });
    expect(del1.status).toBe(200);
    const del2 = await authedFetch(ownerJwt, `/api/events/${event.id}`, { method: "DELETE" });
    expect(del2.status).toBe(200);
    const detail = await authedFetch(ownerJwt, `/api/events/${event.id}`);
    const d = (await detail.json()) as { data: { event: EventShape } };
    expect(d.data.event.cancelled_at).not.toBeNull();
  });

  it("PATCH rejects a merged ends_at < starts_at", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { event } = await createEvent(ownerJwt, {
      title: "x",
      starts_at: T0,
      ends_at: T0 + 3600,
    });
    const res = await authedFetch(ownerJwt, `/api/events/${event.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starts_at: T0 + 7200 }),
    });
    expect(res.status).toBe(400);
  });

  it("adds and removes attendees idempotently", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const bob = await bootstrapSecondUser("bob@example.com");
    const { event } = await createEvent(ownerJwt, { title: "x", starts_at: T0 });

    const add = await authedFetch(ownerJwt, `/api/events/${event.id}/attendees/${bob.userId}`, {
      method: "POST",
    });
    expect(add.status).toBe(200);
    const addAgain = await authedFetch(
      ownerJwt,
      `/api/events/${event.id}/attendees/${bob.userId}`,
      {
        method: "POST",
      },
    );
    const a = (await addAgain.json()) as { data: { event: EventShape } };
    expect(a.data.event.attendee_ids).toEqual([bob.userId]);

    const rm = await authedFetch(ownerJwt, `/api/events/${event.id}/attendees/${bob.userId}`, {
      method: "DELETE",
    });
    const r = (await rm.json()) as { data: { event: EventShape } };
    expect(r.data.event.attendee_ids).toEqual([]);
  });
});
