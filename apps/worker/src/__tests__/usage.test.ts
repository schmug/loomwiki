// SPDX-License-Identifier: Apache-2.0

// M6 usage-counter tests: race safety, UTC rollover, scope isolation.

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getUsage,
  incrementUsage,
  nextUtcMidnightIso,
  resetUsageToday,
  utcDayKey,
} from "../lib/usage.js";
import { getOrCreateUser } from "../lib/users.js";
import { DEFAULT_WORKSPACE_ID, getOrBootstrapWorkspace } from "../lib/workspace.js";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await resetDb();
});

const fixedClock = (iso: string) => () => Date.parse(iso);

async function bootstrap(): Promise<{ userA: string; userB: string }> {
  const a = await getOrCreateUser(env, "alice@example.com");
  const b = await getOrCreateUser(env, "bob@example.com");
  await getOrBootstrapWorkspace(env, a.id);
  return { userA: a.id, userB: b.id };
}

describe("utcDayKey + nextUtcMidnightIso", () => {
  it("formats the UTC day correctly", () => {
    expect(utcDayKey(Date.parse("2026-05-04T12:34:56Z"))).toBe("2026-05-04");
    expect(utcDayKey(Date.parse("2026-05-04T23:59:59Z"))).toBe("2026-05-04");
    expect(utcDayKey(Date.parse("2026-05-05T00:00:00Z"))).toBe("2026-05-05");
  });

  it("computes the next UTC midnight", () => {
    expect(nextUtcMidnightIso(Date.parse("2026-05-04T12:34:56Z"))).toBe("2026-05-05T00:00:00.000Z");
    // Edge: exact midnight reads as the start of THAT day; next midnight is +24h.
    expect(nextUtcMidnightIso(Date.parse("2026-05-04T00:00:00Z"))).toBe("2026-05-05T00:00:00.000Z");
  });
});

describe("getUsage", () => {
  it("returns zeros when no row exists", async () => {
    const { userA } = await bootstrap();
    const usage = await getUsage(env, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      scopeType: "user",
      scopeId: userA,
    });
    expect(usage).toEqual({ ask_count: 0, search_count: 0, ingest_count: 0 });
  });
});

describe("incrementUsage", () => {
  it("increments ask and search independently", async () => {
    const { userA } = await bootstrap();
    const scope = { workspaceId: DEFAULT_WORKSPACE_ID, scopeType: "user" as const, scopeId: userA };

    let usage = await incrementUsage(env, scope, "ask");
    expect(usage).toEqual({ ask_count: 1, search_count: 0, ingest_count: 0 });
    usage = await incrementUsage(env, scope, "ask");
    expect(usage).toEqual({ ask_count: 2, search_count: 0, ingest_count: 0 });
    usage = await incrementUsage(env, scope, "search");
    expect(usage).toEqual({ ask_count: 2, search_count: 1, ingest_count: 0 });
    usage = await incrementUsage(env, scope, "ingest");
    expect(usage).toEqual({ ask_count: 2, search_count: 1, ingest_count: 1 });
  });

  it("is race-safe under concurrent increments (ON CONFLICT DO UPDATE)", async () => {
    const { userA } = await bootstrap();
    const scope = { workspaceId: DEFAULT_WORKSPACE_ID, scopeType: "user" as const, scopeId: userA };

    // 25 concurrent +1s — D1 serializes writes within an instance and
    // ON CONFLICT DO UPDATE handles the row-exists case atomically.
    await Promise.all(Array.from({ length: 25 }, () => incrementUsage(env, scope, "ask")));

    const usage = await getUsage(env, scope);
    expect(usage.ask_count).toBe(25);
  });

  it("rolls over at UTC midnight (separate row per day)", async () => {
    const { userA } = await bootstrap();
    const scope = { workspaceId: DEFAULT_WORKSPACE_ID, scopeType: "user" as const, scopeId: userA };

    const day1 = fixedClock("2026-05-04T23:59:00Z");
    const day2 = fixedClock("2026-05-05T00:00:01Z");

    await incrementUsage(env, scope, "ask", day1);
    await incrementUsage(env, scope, "ask", day1);

    const day1Usage = await getUsage(env, scope, day1);
    expect(day1Usage.ask_count).toBe(2);

    await incrementUsage(env, scope, "ask", day2);

    const day2Usage = await getUsage(env, scope, day2);
    expect(day2Usage.ask_count).toBe(1); // fresh row for the new day

    // Day 1's row is untouched by the day-2 increment.
    expect((await getUsage(env, scope, day1)).ask_count).toBe(2);
  });

  it("isolates per-user counters from per-workspace and from other users", async () => {
    const { userA, userB } = await bootstrap();
    const aScope = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      scopeType: "user" as const,
      scopeId: userA,
    };
    const bScope = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      scopeType: "user" as const,
      scopeId: userB,
    };
    const wsScope = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      scopeType: "workspace" as const,
      scopeId: "_workspace",
    };

    await incrementUsage(env, aScope, "ask");
    await incrementUsage(env, aScope, "ask");
    await incrementUsage(env, bScope, "ask");
    await incrementUsage(env, wsScope, "ask");
    await incrementUsage(env, wsScope, "ask");
    await incrementUsage(env, wsScope, "ask");

    expect((await getUsage(env, aScope)).ask_count).toBe(2);
    expect((await getUsage(env, bScope)).ask_count).toBe(1);
    expect((await getUsage(env, wsScope)).ask_count).toBe(3);
  });
});

describe("resetUsageToday", () => {
  it("removes today's row only", async () => {
    const { userA } = await bootstrap();
    const scope = { workspaceId: DEFAULT_WORKSPACE_ID, scopeType: "user" as const, scopeId: userA };
    await incrementUsage(env, scope, "ask");
    await resetUsageToday(env, scope);
    expect(await getUsage(env, scope)).toEqual({
      ask_count: 0,
      search_count: 0,
      ingest_count: 0,
    });
  });
});
