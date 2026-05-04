// SPDX-License-Identifier: Apache-2.0

// Integration tests for archiveDay(). Wired against miniflare D1 with
// real migrations + an InMemoryWikiBackend so the orchestration is
// exercised end-to-end without touching KV. The schema is the same one
// production runs against (forward-only D1 migrations from
// packages/schema/d1-migrations).

import { env } from "cloudflare:test";
import { id } from "@loomwiki/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { archiveDay, formatChatLogPath } from "../lib/chat-log.js";
import { InMemoryWikiBackend, type WikiBackend } from "../lib/wiki-backend.js";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000000";
const OWNER_ID = "01900000-0000-7000-8000-eeeeeeeeeeee";

interface SeedHandles {
  aliceId: string;
  bobId: string;
  generalId: string;
  randomId: string;
}

async function seedFixtures(): Promise<SeedHandles> {
  // Workspace + users
  await env.DB.prepare(
    "INSERT INTO users (id, email, display_name) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING",
  )
    .bind(OWNER_ID, "owner@example.com", "Owner")
    .run();
  await env.DB.prepare(
    "INSERT INTO workspaces (id, name, owner_id, vault_repo) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(WORKSPACE_ID, "default", OWNER_ID, "loomwiki-vault")
    .run();

  const aliceId = id();
  const bobId = id();
  await env.DB.prepare("INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)")
    .bind(aliceId, "alice@example.com", "alice")
    .run();
  await env.DB.prepare("INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)")
    .bind(bobId, "bob@example.com", "bob")
    .run();

  // Two rooms
  const generalId = id();
  const randomId = id();
  await env.DB.prepare(
    "INSERT INTO rooms (id, workspace_id, slug, name, created_by) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(generalId, WORKSPACE_ID, "general", "General", aliceId)
    .run();
  await env.DB.prepare(
    "INSERT INTO rooms (id, workspace_id, slug, name, created_by) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(randomId, WORKSPACE_ID, "random", "Random", aliceId)
    .run();

  return { aliceId, bobId, generalId, randomId };
}

async function seedMessage(opts: {
  roomId: string;
  userId: string;
  body: string;
  createdAtSec: number;
  deletedAtSec?: number | null;
  editedAtSec?: number | null;
}): Promise<string> {
  const mid = id();
  await new Promise((r) => setTimeout(r, 1));
  await env.DB.prepare(
    `INSERT INTO messages
       (id, room_id, user_id, body, created_at, edited_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      mid,
      opts.roomId,
      opts.userId,
      opts.body,
      opts.createdAtSec,
      opts.editedAtSec ?? null,
      opts.deletedAtSec ?? null,
    )
    .run();
  return mid;
}

const TARGET_DATE = "2026-05-03";
const T0 = Math.floor(Date.parse(`${TARGET_DATE}T08:00:00Z`) / 1000);

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await resetDb();
});

describe("archiveDay", () => {
  it("produces zero files for an empty day", async () => {
    await seedFixtures();
    const backend = new InMemoryWikiBackend();
    const summary = await archiveDay({ env, dateUtc: TARGET_DATE, backend });
    expect(summary).toEqual({
      date: TARGET_DATE,
      files_written: 0,
      rooms_processed: 0,
      errors: [],
    });
    expect(backend.size()).toBe(0);
  });

  it("writes one file per room, at the canonical path", async () => {
    const { aliceId, bobId, generalId, randomId } = await seedFixtures();
    await seedMessage({ roomId: generalId, userId: aliceId, body: "g1", createdAtSec: T0 });
    await seedMessage({ roomId: generalId, userId: bobId, body: "g2", createdAtSec: T0 + 60 });
    await seedMessage({ roomId: randomId, userId: aliceId, body: "r1", createdAtSec: T0 + 120 });

    const backend = new InMemoryWikiBackend();
    const summary = await archiveDay({ env, dateUtc: TARGET_DATE, backend });
    expect(summary.rooms_processed).toBe(2);
    expect(summary.files_written).toBe(2);
    expect(summary.errors).toEqual([]);

    const generalRecord = await backend.read(formatChatLogPath("general", TARGET_DATE));
    const randomRecord = await backend.read(formatChatLogPath("random", TARGET_DATE));
    expect(generalRecord).not.toBeNull();
    expect(randomRecord).not.toBeNull();

    expect(generalRecord?.raw).toContain("room: general");
    expect(generalRecord?.raw).toContain("message_count: 2");
    expect(generalRecord?.raw).toContain("## 08:00 alice");
    expect(generalRecord?.raw).toContain("g1");
    expect(generalRecord?.raw).toContain("## 08:01 bob");
    expect(generalRecord?.raw).toContain("g2");

    expect(randomRecord?.raw).toContain("message_count: 1");
    expect(randomRecord?.raw).toContain("r1");
  });

  it("renders tombstoned messages as [deleted] and uses post-edit body for edits", async () => {
    const { aliceId, generalId } = await seedFixtures();
    await seedMessage({
      roomId: generalId,
      userId: aliceId,
      body: "edited body",
      createdAtSec: T0,
      editedAtSec: T0 + 5,
    });
    await seedMessage({
      roomId: generalId,
      userId: aliceId,
      body: "",
      createdAtSec: T0 + 60,
      deletedAtSec: T0 + 120,
    });

    const backend = new InMemoryWikiBackend();
    const summary = await archiveDay({ env, dateUtc: TARGET_DATE, backend });
    expect(summary.files_written).toBe(1);
    const record = await backend.read(formatChatLogPath("general", TARGET_DATE));
    expect(record?.raw).toContain("edited body");
    expect(record?.raw).toContain("[deleted]");
  });

  it("ignores messages outside the target UTC day", async () => {
    const { aliceId, generalId } = await seedFixtures();
    // Day before
    await seedMessage({
      roomId: generalId,
      userId: aliceId,
      body: "yesterday",
      createdAtSec: Math.floor(Date.parse("2026-05-02T23:59:59Z") / 1000),
    });
    // Target day
    await seedMessage({ roomId: generalId, userId: aliceId, body: "today", createdAtSec: T0 });
    // Day after
    await seedMessage({
      roomId: generalId,
      userId: aliceId,
      body: "tomorrow",
      createdAtSec: Math.floor(Date.parse("2026-05-04T00:00:00Z") / 1000),
    });

    const backend = new InMemoryWikiBackend();
    await archiveDay({ env, dateUtc: TARGET_DATE, backend });
    const record = await backend.read(formatChatLogPath("general", TARGET_DATE));
    expect(record?.raw).toContain("today");
    expect(record?.raw).not.toContain("yesterday");
    expect(record?.raw).not.toContain("tomorrow");
    expect(record?.raw).toContain("message_count: 1");
  });

  it("re-running for the same date overwrites cleanly (byte-identical for unchanged input)", async () => {
    const { aliceId, generalId } = await seedFixtures();
    await seedMessage({ roomId: generalId, userId: aliceId, body: "stable", createdAtSec: T0 });

    const backend = new InMemoryWikiBackend();
    await archiveDay({ env, dateUtc: TARGET_DATE, backend });
    const first = await backend.read(formatChatLogPath("general", TARGET_DATE));
    await archiveDay({ env, dateUtc: TARGET_DATE, backend });
    const second = await backend.read(formatChatLogPath("general", TARGET_DATE));

    expect(first?.raw).toBe(second?.raw);
    expect(first?.sha).toBe(second?.sha);
  });

  it("isolates per-room failures — one room's writeFile error does not block others", async () => {
    const { aliceId, generalId, randomId } = await seedFixtures();
    await seedMessage({ roomId: generalId, userId: aliceId, body: "g1", createdAtSec: T0 });
    await seedMessage({ roomId: randomId, userId: aliceId, body: "r1", createdAtSec: T0 });

    // Backend that throws when asked to write the `general` log.
    class FailingBackend extends InMemoryWikiBackend implements WikiBackend {
      override async writeFile(path: string, content: string): Promise<{ sha: string }> {
        if (path.includes("/rooms/general/")) {
          throw new Error("simulated KV outage");
        }
        return super.writeFile(path, content);
      }
    }
    const backend = new FailingBackend();

    const summary = await archiveDay({ env, dateUtc: TARGET_DATE, backend });
    expect(summary.rooms_processed).toBe(2);
    expect(summary.files_written).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.message).toMatch(/simulated KV outage/);
    // The `random` room still made it through.
    const randomRecord = await backend.read(formatChatLogPath("random", TARGET_DATE));
    expect(randomRecord?.raw).toContain("r1");
  });

  it("rejects an invalid date input at the orchestration boundary", async () => {
    const backend = new InMemoryWikiBackend();
    await expect(archiveDay({ env, dateUtc: "2026-13-99", backend })).rejects.toThrow(
      /invalid date/i,
    );
  });
});
