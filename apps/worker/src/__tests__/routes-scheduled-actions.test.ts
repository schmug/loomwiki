// SPDX-License-Identifier: Apache-2.0

// Integration tests for scheduled-actions routes:
//   POST   /api/rooms/:roomId/scheduled-actions
//   GET    /api/rooms/:roomId/scheduled-actions
//   PATCH  /api/rooms/:roomId/scheduled-actions/:id
//   DELETE /api/rooms/:roomId/scheduled-actions/:id

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

interface OkBody<T> {
  ok: true;
  data: T;
}
interface ErrBody {
  ok: false;
  error: { code: string; message: string };
}

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

async function bootstrapNonMember(): Promise<{ jwt: string; userId: string }> {
  const jwt = await fixture.mint({ email: "outsider@example.com" });
  const me = await authedFetch(jwt, "/api/me");
  const meBody = (await me.json()) as { data: { user: { id: string } } };
  return { jwt, userId: meBody.data.user.id };
}

// Future epoch 1 hour from now (as epoch seconds)
function futureEpoch(offsetS = 3600): number {
  return Math.floor(Date.now() / 1000) + offsetS;
}

describe("POST /api/rooms/:roomId/scheduled-actions", () => {
  it("returns 401 without JWT", async () => {
    const res = await SELF.fetch("https://api.local/api/rooms/fake-room/scheduled-actions", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent room", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const res = await authedFetch(ownerJwt, `/api/rooms/${id()}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "once", fire_at: futureEpoch(), prompt: "hello" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-member", async () => {
    const { roomId } = await bootstrapOwnerAndRoom();
    const { jwt } = await bootstrapNonMember();
    const res = await authedFetch(jwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "once", fire_at: futureEpoch(), prompt: "hello" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrBody;
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("creates a once action and returns correct next_fire_at", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const fireAt = futureEpoch(7200);
    const res = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "once", fire_at: fireAt, prompt: "Run daily standup" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as OkBody<{
      action: { id: string; kind: string; next_fire_at: number; status: string };
    }>;
    expect(body.ok).toBe(true);
    expect(body.data.action.kind).toBe("once");
    expect(body.data.action.next_fire_at).toBe(fireAt);
    expect(body.data.action.status).toBe("active");
  });

  it("creates a cron action and computes next_fire_at", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const res = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "cron", cron_expr: "0 9 * * 1", prompt: "Weekly standup" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as OkBody<{
      action: { id: string; kind: string; next_fire_at: number; cron_expr: string };
    }>;
    expect(body.ok).toBe(true);
    expect(body.data.action.kind).toBe("cron");
    expect(body.data.action.cron_expr).toBe("0 9 * * 1");
    expect(body.data.action.next_fire_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("returns 400 for an invalid cron expression", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const res = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "cron", cron_expr: "not a cron expression!", prompt: "test" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrBody;
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 for a once action with fire_at in the past", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const res = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "once", fire_at: 1000, prompt: "Old event" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrBody;
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 for missing discriminated union fields", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    // Missing cron_expr for kind='cron'
    const res = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "cron", prompt: "test" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/rooms/:roomId/scheduled-actions", () => {
  it("returns empty list for a new room", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const res = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody<{ actions: unknown[]; hasMore: boolean }>;
    expect(body.ok).toBe(true);
    expect(body.data.actions).toHaveLength(0);
    expect(body.data.hasMore).toBe(false);
  });

  it("returns created actions in the list", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "once", fire_at: futureEpoch(3600), prompt: "P1" }),
    });
    await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "once", fire_at: futureEpoch(7200), prompt: "P2" }),
    });

    const res = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`);
    const body = (await res.json()) as OkBody<{ actions: { prompt: string }[] }>;
    expect(body.data.actions).toHaveLength(2);
  });

  it("returns 403 for non-member", async () => {
    const { roomId } = await bootstrapOwnerAndRoom();
    const { jwt } = await bootstrapNonMember();
    const res = await authedFetch(jwt, `/api/rooms/${roomId}/scheduled-actions`);
    expect(res.status).toBe(403);
  });

  it("filters by status query param", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();

    // Create one active action
    const createRes = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "once", fire_at: futureEpoch(3600), prompt: "Active" }),
    });
    const created = (await createRes.json()) as OkBody<{ action: { id: string } }>;
    const actionId = created.data.action.id;

    // Pause it
    await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions/${actionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });

    const activeRes = await authedFetch(
      ownerJwt,
      `/api/rooms/${roomId}/scheduled-actions?status=active`,
    );
    const active = (await activeRes.json()) as OkBody<{ actions: unknown[] }>;
    expect(active.data.actions).toHaveLength(0);

    const pausedRes = await authedFetch(
      ownerJwt,
      `/api/rooms/${roomId}/scheduled-actions?status=paused`,
    );
    const paused = (await pausedRes.json()) as OkBody<{ actions: { status: string }[] }>;
    expect(paused.data.actions).toHaveLength(1);
    expect(paused.data.actions[0]?.status).toBe("paused");
  });
});

describe("PATCH /api/rooms/:roomId/scheduled-actions/:id", () => {
  it("pauses an action", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const createRes = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "once", fire_at: futureEpoch(3600), prompt: "Test" }),
    });
    const created = (await createRes.json()) as OkBody<{ action: { id: string } }>;
    const actionId = created.data.action.id;

    const res = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions/${actionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody<{ action: { status: string } }>;
    expect(body.data.action.status).toBe("paused");
  });

  it("resumes a paused action and recomputes next_fire_at", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const fireAt = futureEpoch(7200);
    const createRes = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "cron", cron_expr: "0 0 * * *", prompt: "Midnight" }),
    });
    const created = (await createRes.json()) as OkBody<{
      action: { id: string; next_fire_at: number };
    }>;
    const actionId = created.data.action.id;
    const originalNextFire = created.data.action.next_fire_at;

    // Pause
    await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions/${actionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });

    // Resume
    const res = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions/${actionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody<{ action: { status: string; next_fire_at: number } }>;
    expect(body.data.action.status).toBe("active");
    // next_fire_at should be recomputed from now, not from original
    expect(body.data.action.next_fire_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // For "0 0 * * *", next fire is at midnight — should be tomorrow or later
    expect(body.data.action.next_fire_at).toBeGreaterThan(originalNextFire - 1);
    // Suppress unused variable warning
    void fireAt;
  });

  it("returns 404 for non-existent action", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const res = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions/${id()}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when non-author non-owner tries to patch", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();

    // Create action as owner
    const createRes = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "once", fire_at: futureEpoch(3600), prompt: "Owner's action" }),
    });
    const created = (await createRes.json()) as OkBody<{ action: { id: string } }>;
    const actionId = created.data.action.id;

    // Second member joins the room
    const memberJwt = await fixture.mint({ email: "member@example.com" });
    const memberMe = await authedFetch(memberJwt, "/api/me");
    const memberBody = (await memberMe.json()) as { data: { user: { id: string } } };
    await env.DB.prepare(
      "INSERT OR IGNORE INTO room_members (room_id, user_id, role) VALUES (?, ?, 'member')",
    )
      .bind(roomId, memberBody.data.user.id)
      .run();

    // Member tries to patch owner's action
    const res = await authedFetch(memberJwt, `/api/rooms/${roomId}/scheduled-actions/${actionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrBody;
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 when patching with empty body", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const createRes = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "once", fire_at: futureEpoch(3600), prompt: "Test" }),
    });
    const created = (await createRes.json()) as OkBody<{ action: { id: string } }>;
    const actionId = created.data.action.id;

    const res = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions/${actionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrBody;
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("DELETE /api/rooms/:roomId/scheduled-actions/:id", () => {
  it("deletes an action", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const createRes = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "once", fire_at: futureEpoch(3600), prompt: "Temporary" }),
    });
    const created = (await createRes.json()) as OkBody<{ action: { id: string } }>;
    const actionId = created.data.action.id;

    const res = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions/${actionId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody<{ deleted: boolean }>;
    expect(body.data.deleted).toBe(true);

    // Verify it's gone
    const listRes = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`);
    const list = (await listRes.json()) as OkBody<{ actions: unknown[] }>;
    expect(list.data.actions).toHaveLength(0);
  });

  it("returns 404 for non-existent action", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const res = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions/${id()}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when non-author non-owner tries to delete", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const createRes = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "once", fire_at: futureEpoch(3600), prompt: "Important" }),
    });
    const created = (await createRes.json()) as OkBody<{ action: { id: string } }>;
    const actionId = created.data.action.id;

    const memberJwt = await fixture.mint({ email: "member2@example.com" });
    const memberMe = await authedFetch(memberJwt, "/api/me");
    const memberBody = (await memberMe.json()) as { data: { user: { id: string } } };
    await env.DB.prepare(
      "INSERT OR IGNORE INTO room_members (room_id, user_id, role) VALUES (?, ?, 'member')",
    )
      .bind(roomId, memberBody.data.user.id)
      .run();

    const res = await authedFetch(memberJwt, `/api/rooms/${roomId}/scheduled-actions/${actionId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("workspace owner can delete any action", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();

    // A member creates an action
    const memberJwt = await fixture.mint({ email: "creator@example.com" });
    const memberMe = await authedFetch(memberJwt, "/api/me");
    const memberBody = (await memberMe.json()) as { data: { user: { id: string } } };
    await env.DB.prepare(
      "INSERT OR IGNORE INTO room_members (room_id, user_id, role) VALUES (?, ?, 'member')",
    )
      .bind(roomId, memberBody.data.user.id)
      .run();

    const createRes = await authedFetch(memberJwt, `/api/rooms/${roomId}/scheduled-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "once", fire_at: futureEpoch(3600), prompt: "Member's action" }),
    });
    const created = (await createRes.json()) as OkBody<{ action: { id: string } }>;
    const actionId = created.data.action.id;

    // Owner deletes it
    const res = await authedFetch(ownerJwt, `/api/rooms/${roomId}/scheduled-actions/${actionId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
  });
});
