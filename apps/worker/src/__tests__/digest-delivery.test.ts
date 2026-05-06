// SPDX-License-Identifier: Apache-2.0

// Digest delivery integration tests. Drives the full flow against an
// InMemoryWikiBackend so we can assert that the digest file lands at
// `/wiki/_inbox/<date>.md` with valid frontmatter + the expected body.

import { env } from "cloudflare:test";
import { id } from "@loomwiki/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type DigestDelivery,
  WikiPageDigestDelivery,
  loadDigestInputs,
  renderDailyDigest,
} from "../lib/digest-delivery.js";
import { getOrCreateUser } from "../lib/users.js";
import { InMemoryWikiBackend } from "../lib/wiki-backend.js";
import { DEFAULT_WORKSPACE_ID, getOrBootstrapWorkspace } from "../lib/workspace.js";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await resetDb();
});

async function bootstrap(): Promise<{
  userId: string;
  roomId: string;
  runId: string;
}> {
  const user = await getOrCreateUser(env, "alice@example.com");
  await getOrBootstrapWorkspace(env, user.id);
  const roomId = id();
  await env.DB.prepare(
    "INSERT INTO rooms (id, workspace_id, slug, name, created_by) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(roomId, DEFAULT_WORKSPACE_ID, "ops-cyber", "Ops Cyber", user.id)
    .run();
  const runId = id();
  await env.DB.prepare(
    "INSERT INTO ingest_runs (id, room_id, triggered_by, status, started_at, finished_at) VALUES (?, ?, ?, 'succeeded', ?, ?)",
  )
    .bind(runId, roomId, user.id, dayStart("2026-05-04") + 100, dayStart("2026-05-04") + 110)
    .run();
  return { userId: user.id, roomId, runId };
}

function dayStart(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

async function seedProposal(runId: string, pagePath: string): Promise<string> {
  const pid = id();
  await env.DB.prepare(
    `INSERT INTO proposals (id, run_id, page_path, action, after_content, rationale, status, created_at)
     VALUES (?, ?, ?, 'create', '---\ntitle: x\nkind: concept\ncreated: 2026-05-04\nlast_updated: 2026-05-04\nstatus: draft\n---\n\nbody', 'rationale', 'pending', ?)`,
  )
    .bind(pid, runId, pagePath, dayStart("2026-05-04") + 200)
    .run();
  return pid;
}

describe("loadDigestInputs", () => {
  it("returns empty for a day with no runs", async () => {
    const inputs = await loadDigestInputs(env, { date: "2026-05-04" });
    expect(inputs.proposals).toEqual([]);
    expect(inputs.stats.run_count).toBe(0);
  });

  it("aggregates pending proposals + run stats across the day", async () => {
    const { runId } = await bootstrap();
    await seedProposal(runId, "/wiki/decisions/2026-05-dmarc.md");
    await seedProposal(runId, "/wiki/concepts/spf.md");

    const inputs = await loadDigestInputs(env, { date: "2026-05-04" });
    expect(inputs.proposals).toHaveLength(2);
    expect(inputs.stats.run_count).toBe(1);
    expect(inputs.stats.error_count).toBe(0);
    expect(inputs.stats.p50_duration_ms).toBe(10_000);
  });
});

describe("WikiPageDigestDelivery", () => {
  it("writes the digest to /wiki/_inbox/<date>.md", async () => {
    const { runId } = await bootstrap();
    await seedProposal(runId, "/wiki/decisions/2026-05-dmarc.md");

    const backend = new InMemoryWikiBackend();
    const delivery: DigestDelivery = new WikiPageDigestDelivery(backend);
    const result = await renderDailyDigest({
      env,
      date: "2026-05-04",
      workspaceId: DEFAULT_WORKSPACE_ID,
      delivery,
    });
    expect(result.delivered).toBe(true);
    expect(result.path).toBe("/wiki/_inbox/2026-05-04.md");

    const stored = await backend.read(result.path);
    expect(stored).not.toBeNull();
    expect(stored?.raw).toContain("title: Inbox Digest — 2026-05-04");
    expect(stored?.raw).toContain("/wiki/decisions/2026-05-dmarc.md");
  });

  it("re-rendering with identical inputs is idempotent (same SHA)", async () => {
    const { runId } = await bootstrap();
    await seedProposal(runId, "/wiki/decisions/2026-05-dmarc.md");

    const backend = new InMemoryWikiBackend();
    const delivery: DigestDelivery = new WikiPageDigestDelivery(backend);
    await renderDailyDigest({
      env,
      date: "2026-05-04",
      workspaceId: DEFAULT_WORKSPACE_ID,
      delivery,
    });
    const first = await backend.read("/wiki/_inbox/2026-05-04.md");

    await renderDailyDigest({
      env,
      date: "2026-05-04",
      workspaceId: DEFAULT_WORKSPACE_ID,
      delivery,
    });
    const second = await backend.read("/wiki/_inbox/2026-05-04.md");

    expect(first?.sha).toBe(second?.sha);
    expect(first?.raw).toBe(second?.raw);
  });

  it("renders an empty digest when no proposals exist for the date", async () => {
    const backend = new InMemoryWikiBackend();
    const delivery: DigestDelivery = new WikiPageDigestDelivery(backend);
    const result = await renderDailyDigest({
      env,
      date: "2026-05-04",
      workspaceId: DEFAULT_WORKSPACE_ID,
      delivery,
    });
    expect(result.delivered).toBe(true);
    const stored = await backend.read(result.path);
    expect(stored?.raw).toContain("No pending proposals");
  });
});
