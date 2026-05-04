// SPDX-License-Identifier: Apache-2.0

// Tests for the cron `scheduled()` handler. The handler is thin —
// most of its responsibility is computing the previous UTC day and
// handing off to archiveDay() via ctx.waitUntil. We test:
//   1. it returns void synchronously,
//   2. ctx.waitUntil is invoked exactly once,
//   3. the date arithmetic lands on the previous UTC day.
//
// We don't drive end-to-end archival here (that's archive-day.test.ts);
// these tests own the handler-shape contract.

import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduled } from "../scheduled.js";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await resetDb();
  // Drop any KV state seeded by other tests before this one runs.
  const list = await env.WIKI_KV.list();
  for (const k of list.keys) await env.WIKI_KV.delete(k.name);
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface FakeCtx {
  waitUntil: ReturnType<typeof vi.fn>;
  passThroughOnException: () => void;
}

function makeCtx(): FakeCtx {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: () => {},
  };
}

function controllerAt(
  iso: string,
  cron = "0 2 * * *",
): {
  scheduledTime: number;
  cron: string;
  noRetry: () => void;
} {
  return {
    scheduledTime: Date.parse(iso),
    cron,
    noRetry: () => {},
  };
}

describe("scheduled handler", () => {
  it("returns void and forwards work to ctx.waitUntil", async () => {
    const ctx = makeCtx();
    // 02:00 UTC — the production schedule.
    const controller = controllerAt("2026-05-04T02:00:00Z");
    // biome-ignore lint/suspicious/noExplicitAny: ScheduledController shape mismatch between Cloudflare's two type packages
    const result = await scheduled(controller as any, env, ctx as any);
    expect(result).toBeUndefined();
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("handler completes without throwing and produces no archive errors for an empty DB", async () => {
    const ctx = makeCtx();
    let promise: Promise<unknown> | undefined;
    ctx.waitUntil.mockImplementation((p: Promise<unknown>) => {
      promise = p;
    });
    const controller = controllerAt("2026-05-04T02:00:00Z");
    // biome-ignore lint/suspicious/noExplicitAny: ScheduledController shape mismatch
    await scheduled(controller as any, env, ctx as any);
    // The waitUntil promise resolves cleanly (no rooms → no errors).
    await expect(promise).resolves.toBeUndefined();
  });

  it("dispatches the M7 ingest cron (0 3 * * *) without throwing on an empty workspace", async () => {
    const ctx = makeCtx();
    let promise: Promise<unknown> | undefined;
    ctx.waitUntil.mockImplementation((p: Promise<unknown>) => {
      promise = p;
    });
    const controller = controllerAt("2026-05-04T03:00:00Z", "0 3 * * *");
    // biome-ignore lint/suspicious/noExplicitAny: ScheduledController shape mismatch
    await scheduled(controller as any, env, ctx as any);
    await expect(promise).resolves.toBeUndefined();

    // The digest page for today should now exist (empty state).
    const list = await env.WIKI_KV.list({ prefix: "wiki:/wiki/_inbox/" });
    expect(list.keys.length).toBeGreaterThan(0);
  });

  it("logs a warning for an unrecognized cron string instead of failing", async () => {
    const logs: unknown[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((arg: unknown) => {
      logs.push(arg);
    });
    const ctx = makeCtx();
    const controller = controllerAt("2026-05-04T04:00:00Z", "0 4 * * *");
    // biome-ignore lint/suspicious/noExplicitAny: ScheduledController shape mismatch
    await scheduled(controller as any, env, ctx as any);
    spy.mockRestore();

    const matched = logs.find(
      (entry): entry is { event: string; cron: string } =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { event?: unknown }).event === "cron_unrecognized",
    );
    expect(matched?.cron).toBe("0 4 * * *");
  });

  it("computes previous-UTC-day correctly across the date boundary", async () => {
    // Confirm the handler hands the right date down by inspecting
    // whichever side-effect we can observe — here, the handler logs
    // an `archive_run_complete` line that includes the date.
    const logs: unknown[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((arg: unknown) => {
      logs.push(arg);
    });

    const ctx = makeCtx();
    let promise: Promise<unknown> | undefined;
    ctx.waitUntil.mockImplementation((p: Promise<unknown>) => {
      promise = p;
    });
    // 02:00 UTC tick — yesterday is 2026-05-03.
    const controller = controllerAt("2026-05-04T02:00:00Z");
    // biome-ignore lint/suspicious/noExplicitAny: ScheduledController shape mismatch
    await scheduled(controller as any, env, ctx as any);
    await promise;

    spy.mockRestore();
    const completion = logs.find(
      (entry): entry is { event: string; date: string } =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { event?: unknown }).event === "archive_run_complete",
    );
    expect(completion?.date).toBe("2026-05-03");
  });
});
