// SPDX-License-Identifier: Apache-2.0

// Per-room ingest run lock tests. Drives `acquireRunLock` directly
// against the test D1 binding. The cron + manual route paths converge
// on this primitive so its concurrency contract is the load-bearing
// piece — tests here exercise: holding, expiry, takeover, success
// semantics, and the lock-not-blocked-by-finished-runs invariant.

import { env } from "cloudflare:test";
import { id } from "@loomwiki/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { acquireRunLock, markRunFailed, markRunSucceeded } from "../agents/lock.js";
import { getOrCreateUser } from "../lib/users.js";
import { getOrBootstrapWorkspace } from "../lib/workspace.js";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await resetDb();
});

async function bootstrapRoom(): Promise<{ roomId: string; userId: string }> {
  const user = await getOrCreateUser(env, "alice@example.com");
  const ws = await getOrBootstrapWorkspace(env, user.id);
  const roomId = id();
  await env.DB.prepare(
    "INSERT INTO rooms (id, workspace_id, slug, name, created_by) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(roomId, ws.id, "general", "General", user.id)
    .run();
  return { roomId, userId: user.id };
}

describe("acquireRunLock", () => {
  it("inserts a running row on first acquisition", async () => {
    const { roomId, userId } = await bootstrapRoom();

    const result = await acquireRunLock({
      env,
      roomId,
      triggeredBy: userId,
    });
    expect(result.acquired).toBe(true);
    expect(result.runId).toMatch(/^[0-9a-f]{8}-/);

    const row = await env.DB.prepare("SELECT * FROM ingest_runs WHERE id = ?")
      .bind(result.runId)
      .first<{ status: string; room_id: string; triggered_by: string }>();
    expect(row?.status).toBe("running");
    expect(row?.room_id).toBe(roomId);
    expect(row?.triggered_by).toBe(userId);
  });

  it("a second concurrent call returns the same run id with acquired=false", async () => {
    const { roomId, userId } = await bootstrapRoom();
    const a = await acquireRunLock({ env, roomId, triggeredBy: userId });
    const b = await acquireRunLock({ env, roomId, triggeredBy: userId });
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(false);
    expect(b.runId).toBe(a.runId);
  });

  it("a stale (>1h old) running row is failed out and a new lock is acquired", async () => {
    const { roomId, userId } = await bootstrapRoom();

    // Time A: 1 PM → acquire run
    const tA = Date.parse("2026-05-04T13:00:00Z");
    const first = await acquireRunLock({
      env,
      roomId,
      triggeredBy: userId,
      clock: () => tA,
    });
    expect(first.acquired).toBe(true);

    // Time B: 1h 1min later — first run is stale.
    const tB = tA + 61 * 60 * 1000;
    const second = await acquireRunLock({
      env,
      roomId,
      triggeredBy: userId,
      clock: () => tB,
    });
    expect(second.acquired).toBe(true);
    expect(second.runId).not.toBe(first.runId);

    // Old row should have been marked failed with `lock_expired`.
    const oldRow = await env.DB.prepare("SELECT status, error FROM ingest_runs WHERE id = ?")
      .bind(first.runId)
      .first<{ status: string; error: string }>();
    expect(oldRow?.status).toBe("failed");
    expect(oldRow?.error).toBe("lock_expired");
  });

  it("a finished (succeeded) run does not block a new acquisition", async () => {
    const { roomId, userId } = await bootstrapRoom();
    const first = await acquireRunLock({ env, roomId, triggeredBy: userId });
    await markRunSucceeded(env, first.runId, {
      lastMessageId: null,
      summary: "ok",
    });

    const second = await acquireRunLock({ env, roomId, triggeredBy: userId });
    expect(second.acquired).toBe(true);
    expect(second.runId).not.toBe(first.runId);
  });

  it("a failed run does not block a new acquisition", async () => {
    const { roomId, userId } = await bootstrapRoom();
    const first = await acquireRunLock({ env, roomId, triggeredBy: userId });
    await markRunFailed(env, first.runId, { error: "test_failure" });

    const second = await acquireRunLock({ env, roomId, triggeredBy: userId });
    expect(second.acquired).toBe(true);
  });

  it("isolates locks across rooms", async () => {
    const { userId } = await bootstrapRoom();
    const ws = await getOrBootstrapWorkspace(env, userId);
    const roomA = id();
    const roomB = id();
    const slugs = ["alpha", "beta"];
    for (const [i, rid] of [roomA, roomB].entries()) {
      await env.DB.prepare(
        "INSERT INTO rooms (id, workspace_id, slug, name, created_by) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(rid, ws.id, slugs[i], "R", userId)
        .run();
    }
    const a = await acquireRunLock({ env, roomId: roomA, triggeredBy: userId });
    const b = await acquireRunLock({ env, roomId: roomB, triggeredBy: userId });
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(a.runId).not.toBe(b.runId);
  });

  it("supports the cron triggered-by sentinel", async () => {
    const { roomId } = await bootstrapRoom();
    const result = await acquireRunLock({ env, roomId, triggeredBy: "cron" });
    expect(result.acquired).toBe(true);
    const row = await env.DB.prepare("SELECT triggered_by FROM ingest_runs WHERE id = ?")
      .bind(result.runId)
      .first<{ triggered_by: string }>();
    expect(row?.triggered_by).toBe("cron");
  });
});

describe("markRunSucceeded / markRunFailed", () => {
  it("only updates rows that are still in the running state", async () => {
    const { roomId, userId } = await bootstrapRoom();
    const lock = await acquireRunLock({ env, roomId, triggeredBy: userId });
    await markRunSucceeded(env, lock.runId, { lastMessageId: null, summary: "ok" });

    // Re-marking a succeeded row as failed must NOT overwrite (the
    // WHERE status='running' clause in the helper).
    await markRunFailed(env, lock.runId, { error: "should_not_apply" });
    const row = await env.DB.prepare("SELECT status, error, summary FROM ingest_runs WHERE id = ?")
      .bind(lock.runId)
      .first<{ status: string; error: string | null; summary: string | null }>();
    expect(row?.status).toBe("succeeded");
    expect(row?.error).toBeNull();
    expect(row?.summary).toBe("ok");
  });
});
