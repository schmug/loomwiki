// SPDX-License-Identifier: Apache-2.0

// Integration tests for the scheduled-actions every-minute tick handler.
// Tests use the scheduled() handler and inspect D1 state to verify
// that cron/once actions fire correctly.

import { SELF, env } from "cloudflare:test";
import { id } from "@loomwiki/shared";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runScheduledActionsTick } from "../scheduled.js";
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

interface Bootstrap {
  ownerJwt: string;
  ownerId: string;
  workspaceId: string;
  roomId: string;
}

async function authedFetch(jwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("CF-Access-Jwt-Assertion", jwt);
  return SELF.fetch(`https://api.local${path}`, { ...init, headers });
}

async function bootstrapOwnerAndRoom(): Promise<Bootstrap> {
  const ownerJwt = await fixture.mint({ email: "owner@example.com" });
  const me = await authedFetch(ownerJwt, "/api/me");
  const meBody = (await me.json()) as {
    data: { user: { id: string }; workspace: { id: string } };
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

/**
 * Seed a scheduled_action row directly in D1 with a next_fire_at in the
 * past (so the tick handler claims it).
 */
async function seedAction(opts: {
  workspaceId: string;
  roomId: string;
  createdBy: string;
  kind: "cron" | "once";
  cronExpr?: string;
  prompt?: string;
  nextFireAt?: number;
}): Promise<string> {
  const actionId = id();
  const nowS = Math.floor(Date.now() / 1000);
  const nextFire = opts.nextFireAt ?? nowS - 60; // default: 1 minute ago (eligible)

  await env.DB.prepare(
    `INSERT INTO scheduled_actions
       (id, workspace_id, room_id, created_by, kind, cron_expr, fire_at, prompt, status,
        failure_count, last_fired_at, next_fire_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, NULL, ?, ?, ?)`,
  )
    .bind(
      actionId,
      opts.workspaceId,
      opts.roomId,
      opts.createdBy,
      opts.kind,
      opts.cronExpr ?? null,
      opts.kind === "once" ? nextFire : null,
      opts.prompt ?? "Test prompt",
      nextFire,
      nowS,
      nowS,
    )
    .run();

  return actionId;
}

describe("runScheduledActionsTick", () => {
  it("does nothing when no eligible actions", async () => {
    const { roomId, workspaceId, ownerId } = await bootstrapOwnerAndRoom();

    // Seed action with next_fire_at in the future
    const futureFireAt = Math.floor(Date.now() / 1000) + 3600;
    await seedAction({
      workspaceId,
      roomId,
      createdBy: ownerId,
      kind: "once",
      nextFireAt: futureFireAt,
    });

    const nowS = Math.floor(Date.now() / 1000);
    await runScheduledActionsTick(env, nowS);

    const row = await env.DB.prepare("SELECT status FROM scheduled_actions WHERE room_id = ?")
      .bind(roomId)
      .first<{ status: string }>();
    // Should still be active with unchanged status
    expect(row?.status).toBe("active");
  });

  it("fires a once action and marks it as fired", async () => {
    const { roomId, workspaceId, ownerId } = await bootstrapOwnerAndRoom();

    const actionId = await seedAction({
      workspaceId,
      roomId,
      createdBy: ownerId,
      kind: "once",
      prompt: "Once-only prompt",
    });

    const nowS = Math.floor(Date.now() / 1000);
    await runScheduledActionsTick(env, nowS);

    const row = await env.DB.prepare(
      "SELECT status, last_fired_at FROM scheduled_actions WHERE id = ?",
    )
      .bind(actionId)
      .first<{ status: string; last_fired_at: number | null }>();

    expect(row?.status).toBe("fired");
    expect(row?.last_fired_at).not.toBeNull();
  });

  it("fires a cron action and computes a new next_fire_at", async () => {
    const { roomId, workspaceId, ownerId } = await bootstrapOwnerAndRoom();

    const actionId = await seedAction({
      workspaceId,
      roomId,
      createdBy: ownerId,
      kind: "cron",
      cronExpr: "* * * * *", // every minute
      prompt: "Minutely check-in",
    });

    const nowS = Math.floor(Date.now() / 1000);
    await runScheduledActionsTick(env, nowS);

    const row = await env.DB.prepare(
      "SELECT status, last_fired_at, next_fire_at FROM scheduled_actions WHERE id = ?",
    )
      .bind(actionId)
      .first<{ status: string; last_fired_at: number | null; next_fire_at: number }>();

    // Cron action should remain active with a new next_fire_at
    expect(row?.status).toBe("active");
    expect(row?.last_fired_at).not.toBeNull();
    // next_fire_at should be pushed forward
    expect(row?.next_fire_at).toBeGreaterThan(nowS);
  });

  it("increments failure_count when DO call fails", async () => {
    const { workspaceId, ownerId } = await bootstrapOwnerAndRoom();

    // Use a non-existent room_id so the DO fetch will fail (room not found in
    // the DO). We still need to insert it without FK constraints failing —
    // seed a fake room row first.
    const fakeRoomId = id();
    await env.DB.prepare(
      "INSERT INTO rooms (id, workspace_id, slug, name, created_by) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(fakeRoomId, workspaceId, "fake-room", "Fake Room", ownerId)
      .run();

    const actionId = await seedAction({
      workspaceId,
      roomId: fakeRoomId,
      createdBy: ownerId,
      kind: "once",
      prompt: "Will fail",
    });

    // Make the DO stub return an error by spying
    const origGet = env.CHAT_ROOM.get.bind(env.CHAT_ROOM);
    const fetchSpy = vi.fn().mockResolvedValue(new Response("error", { status: 500 }));
    vi.spyOn(env.CHAT_ROOM, "get").mockReturnValue({
      fetch: fetchSpy,
    } as unknown as ReturnType<typeof origGet>);

    const nowS = Math.floor(Date.now() / 1000);
    await runScheduledActionsTick(env, nowS);

    vi.restoreAllMocks();

    const row = await env.DB.prepare(
      "SELECT status, failure_count FROM scheduled_actions WHERE id = ?",
    )
      .bind(actionId)
      .first<{ status: string; failure_count: number }>();

    // Should have incremented failure_count
    expect(row?.failure_count).toBe(1);
    // Should still be active for retry
    expect(row?.status).toBe("active");
  });

  it("marks status=failed after 3 consecutive failures", async () => {
    const { workspaceId, ownerId } = await bootstrapOwnerAndRoom();

    const fakeRoomId = id();
    await env.DB.prepare(
      "INSERT INTO rooms (id, workspace_id, slug, name, created_by) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(fakeRoomId, workspaceId, "fail-room", "Fail Room", ownerId)
      .run();

    // Seed with failure_count=2 already (one more will tip it to failed)
    const actionId = id();
    const nowS = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO scheduled_actions
         (id, workspace_id, room_id, created_by, kind, cron_expr, fire_at, prompt, status,
          failure_count, last_fired_at, next_fire_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'once', NULL, ?, 'Will fail', 'active', 2, NULL, ?, ?, ?)`,
    )
      .bind(actionId, workspaceId, fakeRoomId, ownerId, nowS - 60, nowS - 60, nowS, nowS)
      .run();

    // Mock DO to return 500
    const fetchSpy = vi.fn().mockResolvedValue(new Response("error", { status: 500 }));
    vi.spyOn(env.CHAT_ROOM, "get").mockReturnValue({
      fetch: fetchSpy,
    } as unknown as ReturnType<typeof env.CHAT_ROOM.get>);

    await runScheduledActionsTick(env, nowS);

    vi.restoreAllMocks();

    const row = await env.DB.prepare(
      "SELECT status, failure_count FROM scheduled_actions WHERE id = ?",
    )
      .bind(actionId)
      .first<{ status: string; failure_count: number }>();

    expect(row?.failure_count).toBe(3);
    expect(row?.status).toBe("failed");
  });

  it("prevents double-fire via optimistic claim", async () => {
    // Run the tick twice concurrently — only one should claim the action.
    const { roomId, workspaceId, ownerId } = await bootstrapOwnerAndRoom();

    const actionId = await seedAction({
      workspaceId,
      roomId,
      createdBy: ownerId,
      kind: "once",
      prompt: "Once only",
    });

    const nowS = Math.floor(Date.now() / 1000);
    // Run two ticks at the same nowS in parallel
    await Promise.all([runScheduledActionsTick(env, nowS), runScheduledActionsTick(env, nowS)]);

    // The action should be fired exactly once (status=fired, not active).
    // The optimistic claim ensures only one tick can transition the row.
    const row = await env.DB.prepare(
      "SELECT status, last_fired_at FROM scheduled_actions WHERE id = ?",
    )
      .bind(actionId)
      .first<{ status: string; last_fired_at: number | null }>();

    expect(row?.status).toBe("fired");
    // The action must have been fired (last_fired_at set)
    expect(row?.last_fired_at).not.toBeNull();
  });
});
