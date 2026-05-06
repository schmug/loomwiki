// SPDX-License-Identifier: Apache-2.0

// M6 cost-guard attestation. The PR description cites this file as
// proof that all three layers of defense are independent — these tests
// trip the per-user cap, the per-workspace cap, and verify isolation
// between users.

import { env } from "cloudflare:test";
import { isLoomwikiError } from "@loomwiki/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { assertWithinLimit, readLimits } from "../lib/cost-guard.js";
import { getUsage } from "../lib/usage.js";
import { getOrCreateUser } from "../lib/users.js";
import { DEFAULT_WORKSPACE_ID, getOrBootstrapWorkspace } from "../lib/workspace.js";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await resetDb();
});

async function bootstrap() {
  const a = await getOrCreateUser(env, "alice@example.com");
  const b = await getOrCreateUser(env, "bob@example.com");
  await getOrBootstrapWorkspace(env, a.id);
  return { userA: a.id, userB: b.id };
}

// Build an Env with the given numeric limits without mutating the
// shared workerd env (which would leak across tests).
function envWithLimits(
  overrides: Partial<{
    user_ask: number;
    user_search: number;
    ws_ask: number;
    ws_search: number;
    ws_ingest: number;
  }>,
): Env {
  return {
    ...env,
    LLM_DAILY_LIMIT_PER_USER_ASK: String(overrides.user_ask ?? 1000),
    LLM_DAILY_LIMIT_PER_USER_SEARCH: String(overrides.user_search ?? 1000),
    LLM_DAILY_LIMIT_PER_WORKSPACE_ASK: String(overrides.ws_ask ?? 10000),
    LLM_DAILY_LIMIT_PER_WORKSPACE_SEARCH: String(overrides.ws_search ?? 10000),
    INGEST_DAILY_LIMIT_PER_WORKSPACE: String(overrides.ws_ingest ?? 100),
  } as Env;
}

describe("readLimits", () => {
  it("falls back to defaults on missing/invalid env values", () => {
    const limits = readLimits({
      ...env,
      LLM_DAILY_LIMIT_PER_USER_ASK: "",
      LLM_DAILY_LIMIT_PER_USER_SEARCH: "garbage",
      LLM_DAILY_LIMIT_PER_WORKSPACE_ASK: "-1",
      LLM_DAILY_LIMIT_PER_WORKSPACE_SEARCH: "10000",
    } as Env);
    expect(limits).toEqual({
      perUserAsk: 100,
      perUserSearch: 1000,
      perWorkspaceAsk: 1000,
      perWorkspaceSearch: 10000,
      perWorkspaceIngest: 100,
    });
  });
});

describe("assertWithinLimit", () => {
  it("trips the per-user ask cap with the right details payload", async () => {
    const { userA } = await bootstrap();
    const e = envWithLimits({ user_ask: 2, ws_ask: 1000 });

    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userA,
      kind: "ask",
    });
    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userA,
      kind: "ask",
    });

    let caught: unknown = null;
    try {
      await assertWithinLimit({
        env: e,
        workspaceId: DEFAULT_WORKSPACE_ID,
        userId: userA,
        kind: "ask",
      });
    } catch (err) {
      caught = err;
    }
    expect(isLoomwikiError(caught)).toBe(true);
    if (!isLoomwikiError(caught)) return;
    expect(caught.code).toBe("RATE_LIMITED");
    expect(caught.status).toBe(429);
    expect(caught.details).toMatchObject({
      limit: 2,
      used: 2,
      scope: "user",
    });
    // reset_at must be a parseable ISO date.
    expect(typeof (caught.details as { reset_at: string }).reset_at).toBe("string");
  });

  it("trips the per-workspace ask cap when only the workspace counter is over", async () => {
    const { userA, userB } = await bootstrap();
    // High user cap, low workspace cap — combined activity from two
    // users hits workspace ceiling first.
    const e = envWithLimits({ user_ask: 1000, ws_ask: 3 });

    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userA,
      kind: "ask",
    });
    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userB,
      kind: "ask",
    });
    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userA,
      kind: "ask",
    });

    let caught: unknown = null;
    try {
      await assertWithinLimit({
        env: e,
        workspaceId: DEFAULT_WORKSPACE_ID,
        userId: userB,
        kind: "ask",
      });
    } catch (err) {
      caught = err;
    }
    expect(isLoomwikiError(caught)).toBe(true);
    if (!isLoomwikiError(caught)) return;
    expect(caught.details).toMatchObject({ limit: 3, used: 3, scope: "workspace" });
  });

  it("user A's cap doesn't tank user B's request", async () => {
    const { userA, userB } = await bootstrap();
    const e = envWithLimits({ user_ask: 1, ws_ask: 1000 });

    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userA,
      kind: "ask",
    });
    await expect(
      assertWithinLimit({ env: e, workspaceId: DEFAULT_WORKSPACE_ID, userId: userA, kind: "ask" }),
    ).rejects.toThrow();

    // userB still has fresh counter — should succeed.
    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userB,
      kind: "ask",
    });

    expect(
      (
        await getUsage(env, {
          workspaceId: DEFAULT_WORKSPACE_ID,
          scopeType: "user",
          scopeId: userB,
        })
      ).ask_count,
    ).toBe(1);
  });

  it("ingest is workspace-scoped only — does not touch the user counter", async () => {
    const { userA } = await bootstrap();
    const e = envWithLimits({ ws_ingest: 5 });

    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userA,
      kind: "ingest",
    });

    // Workspace counter should be at 1; user counter must be 0 (no
    // per-user counting for ingest).
    const wsUsage = await getUsage(env, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      scopeType: "workspace",
      scopeId: "_workspace",
    });
    const userUsage = await getUsage(env, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      scopeType: "user",
      scopeId: userA,
    });
    expect(wsUsage.ingest_count).toBe(1);
    expect(userUsage.ingest_count).toBe(0);
  });

  it("ingest cap rejects with workspace-scope details", async () => {
    const { userA } = await bootstrap();
    const e = envWithLimits({ ws_ingest: 2 });

    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userA,
      kind: "ingest",
    });
    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userA,
      kind: "ingest",
    });

    let caught: unknown = null;
    try {
      await assertWithinLimit({
        env: e,
        workspaceId: DEFAULT_WORKSPACE_ID,
        userId: userA,
        kind: "ingest",
      });
    } catch (err) {
      caught = err;
    }
    expect(isLoomwikiError(caught)).toBe(true);
    if (!isLoomwikiError(caught)) return;
    expect(caught.code).toBe("RATE_LIMITED");
    expect(caught.details).toMatchObject({ limit: 2, used: 2, scope: "workspace" });
  });

  it("ingest counter is independent of ask/search", async () => {
    const { userA } = await bootstrap();
    const e = envWithLimits({ user_ask: 1, ws_ingest: 100 });

    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userA,
      kind: "ask",
    });
    await expect(
      assertWithinLimit({ env: e, workspaceId: DEFAULT_WORKSPACE_ID, userId: userA, kind: "ask" }),
    ).rejects.toThrow();

    // Ingest still works despite the user's ask cap being hit.
    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userA,
      kind: "ingest",
    });
  });

  it("ask and search counters are independent", async () => {
    const { userA } = await bootstrap();
    const e = envWithLimits({ user_ask: 1, user_search: 100 });

    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userA,
      kind: "ask",
    });
    await expect(
      assertWithinLimit({ env: e, workspaceId: DEFAULT_WORKSPACE_ID, userId: userA, kind: "ask" }),
    ).rejects.toThrow();

    // Search is fine despite ask being capped.
    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userA,
      kind: "search",
    });
  });

  it("on success, increments BOTH the per-user and per-workspace counter", async () => {
    const { userA } = await bootstrap();
    const e = envWithLimits({ user_ask: 100, ws_ask: 100 });

    await assertWithinLimit({
      env: e,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: userA,
      kind: "ask",
    });

    expect(
      (
        await getUsage(env, {
          workspaceId: DEFAULT_WORKSPACE_ID,
          scopeType: "user",
          scopeId: userA,
        })
      ).ask_count,
    ).toBe(1);
    expect(
      (
        await getUsage(env, {
          workspaceId: DEFAULT_WORKSPACE_ID,
          scopeType: "workspace",
          scopeId: "_workspace",
        })
      ).ask_count,
    ).toBe(1);
  });
});
