// SPDX-License-Identifier: Apache-2.0

// Unified timeline read API (issue #32). Covers: empty workspace,
// owner-gating (non-owner → 403), source-pill filtering, cursor
// pagination round-trip, and graceful handling when the optional
// scheduled_actions / issue_threads tables are absent.

import { SELF, env } from "cloudflare:test";
import { id } from "@loomwiki/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";
import { type JwtFixture, makeJwtFixture } from "./__fixtures__/jwt.js";

let fixture: JwtFixture;

beforeAll(async () => {
  await applyMigrations();
  fixture = await makeJwtFixture();
});

beforeEach(async () => {
  await resetDb();
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

async function authed(jwt: string, path: string): Promise<Response> {
  return SELF.fetch(`https://api.local${path}`, {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
}

async function bootstrapOwner(): Promise<{
  jwt: string;
  userId: string;
  workspaceId: string;
}> {
  const jwt = await fixture.mint({ email: "owner@example.com" });
  const res = await SELF.fetch("https://api.local/api/me", {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
  const body = (await res.json()) as {
    data: { user: { id: string }; workspace: { id: string } };
  };
  return { jwt, userId: body.data.user.id, workspaceId: body.data.workspace.id };
}

async function plantNonOwner(): Promise<{ jwt: string }> {
  const jwt = await fixture.mint({ email: "guest@example.com" });
  await SELF.fetch("https://api.local/api/me", {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
  return { jwt };
}

async function createRoom(jwt: string, workspaceId: string, slug: string): Promise<string> {
  const res = await SELF.fetch(`https://api.local/api/workspaces/${workspaceId}/rooms`, {
    method: "POST",
    headers: { "CF-Access-Jwt-Assertion": jwt, "content-type": "application/json" },
    body: JSON.stringify({ slug, name: slug }),
  });
  const body = (await res.json()) as { data: { room: { id: string } } };
  return body.data.room.id;
}

// UUIDv7 is monotonic within the process, so ids minted later sort
// after earlier ones. We mint explicitly so a row's cursor ordering is
// deterministic regardless of created_at ties.
async function seedAudit(
  workspaceId: string,
  userId: string,
  rows: { action: string; resourceKind: string; resourceId: string; createdAt: number }[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const r of rows) {
    const rowId = id();
    ids.push(rowId);
    await env.DB.prepare(
      `INSERT INTO audit_log
         (id, workspace_id, actor_user_id, action, resource_kind, resource_id,
          before_json, after_json, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    )
      .bind(rowId, workspaceId, userId, r.action, r.resourceKind, r.resourceId, r.createdAt)
      .run();
  }
  return ids;
}

async function seedRun(
  roomId: string,
  triggeredBy: string,
  status: string,
  startedAt: number,
  finishedAt: number | null,
): Promise<string> {
  const runId = id();
  await env.DB.prepare(
    `INSERT INTO ingest_runs
       (id, room_id, triggered_by, started_at, finished_at, last_message_id, status, summary, error)
     VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
  )
    .bind(runId, roomId, triggeredBy, startedAt, finishedAt, status)
    .run();
  return runId;
}

interface TimelineBody {
  data: {
    entries: { id: string; source: string; at: number; pill?: string | null }[];
    next_cursor: string | null;
  };
}

describe("GET /api/timeline", () => {
  it("returns an empty feed for a fresh workspace", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/timeline");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineBody;
    expect(body.data.entries).toEqual([]);
    expect(body.data.next_cursor).toBeNull();
  });

  it("returns 403 for a non-owner", async () => {
    await bootstrapOwner();
    const { jwt: guestJwt } = await plantNonOwner();
    const res = await authed(guestJwt, "/api/timeline");
    expect(res.status).toBe(403);
  });

  it("unions audit + ingest rows newest-first", async () => {
    const { jwt, userId, workspaceId } = await bootstrapOwner();
    const roomId = await createRoom(jwt, workspaceId, "ops");
    const base = Math.floor(Date.now() / 1000);
    await seedAudit(workspaceId, userId, [
      { action: "proposal.merge", resourceKind: "proposal", resourceId: "p1", createdAt: base },
    ]);
    // Finished run at base+10 → renders newest.
    await seedRun(roomId, userId, "succeeded", base + 5, base + 10);

    const res = await authed(jwt, "/api/timeline");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineBody;
    expect(body.data.entries).toHaveLength(2);
    expect(body.data.entries[0]?.source).toBe("ingest");
    expect(body.data.entries[0]?.at).toBe(base + 10);
    expect(body.data.entries[1]?.source).toBe("audit");
  });

  it("filters by source pill (wiki vs ingest)", async () => {
    const { jwt, userId, workspaceId } = await bootstrapOwner();
    const roomId = await createRoom(jwt, workspaceId, "ops");
    const base = Math.floor(Date.now() / 1000);
    await seedAudit(workspaceId, userId, [
      // proposal → `wiki` pill.
      { action: "proposal.merge", resourceKind: "proposal", resourceId: "p1", createdAt: base },
      // byok → no pill (admin-only); never matches a pill filter.
      { action: "byok.create", resourceKind: "byok", resourceId: "anthropic", createdAt: base + 1 },
    ]);
    await seedRun(roomId, userId, "succeeded", base + 2, base + 3);

    const wiki = (await (await authed(jwt, "/api/timeline?sources=wiki")).json()) as TimelineBody;
    expect(wiki.data.entries).toHaveLength(1);
    expect(wiki.data.entries[0]?.source).toBe("audit");
    expect(wiki.data.entries[0]?.pill).toBe("wiki");

    const ing = (await (await authed(jwt, "/api/timeline?sources=ingest")).json()) as TimelineBody;
    expect(ing.data.entries).toHaveLength(1);
    expect(ing.data.entries[0]?.source).toBe("ingest");

    // chat pill has no producer yet → empty (Q-tl-2 / TODO).
    const chat = (await (await authed(jwt, "/api/timeline?sources=chat")).json()) as TimelineBody;
    expect(chat.data.entries).toEqual([]);

    // Unfiltered still includes the no-pill byok row.
    const all = (await (await authed(jwt, "/api/timeline")).json()) as TimelineBody;
    expect(all.data.entries).toHaveLength(3);
  });

  it("round-trips cursor pagination without gaps or duplicates", async () => {
    const { jwt, userId, workspaceId } = await bootstrapOwner();
    const base = Math.floor(Date.now() / 1000);
    const rows = Array.from({ length: 5 }, (_, i) => ({
      action: "proposal.merge",
      resourceKind: "proposal",
      resourceId: `p${i}`,
      createdAt: base + i,
    }));
    await seedAudit(workspaceId, userId, rows);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const path: string =
        cursor === null ? "/api/timeline?limit=2" : `/api/timeline?limit=2&cursor=${cursor}`;
      const body = (await (await authed(jwt, path)).json()) as TimelineBody;
      for (const e of body.data.entries) seen.push(e.id);
      cursor = body.data.next_cursor;
      if (cursor === null) break;
    }
    // 5 rows, no dupes, all distinct.
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("rejects a malformed cursor with 400", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/timeline?cursor=not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("rejects an unknown source filter with 400", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/timeline?sources=lint");
    expect(res.status).toBe(400);
  });

  it("includes scheduled_actions rows under the scheduled pill", async () => {
    const { jwt, userId, workspaceId } = await bootstrapOwner();
    const roomId = await createRoom(jwt, workspaceId, "ops");
    const base = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO scheduled_actions
         (id, workspace_id, room_id, created_by, kind, cron_expr, fire_at, prompt,
          status, failure_count, last_fired_at, next_fire_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'cron', '0 9 * * *', NULL, 'daily standup',
               'active', 0, NULL, ?, ?, ?)`,
    )
      .bind(id(), workspaceId, roomId, userId, base + 3600, base, base)
      .run();

    const body = (await (
      await authed(jwt, "/api/timeline?sources=scheduled")
    ).json()) as TimelineBody;
    expect(body.data.entries).toHaveLength(1);
    expect(body.data.entries[0]?.source).toBe("scheduled");
    // Never fired → renders at next_fire_at.
    expect(body.data.entries[0]?.at).toBe(base + 3600);
  });

  describe("graceful handling of absent optional tables", () => {
    afterEach(async () => {
      // Re-create the dropped table so resetDb's TRUNCATE list and any
      // later test case don't trip. applyD1Migrations tracks applied
      // state per-DB and will NOT re-run 0005 once it's marked applied,
      // so we restore the table with its exact 0005 DDL directly.
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS scheduled_actions (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           room_id TEXT NOT NULL REFERENCES rooms(id),
           created_by TEXT NOT NULL REFERENCES users(id),
           kind TEXT NOT NULL CHECK(kind IN ('cron','once')),
           cron_expr TEXT,
           fire_at INTEGER,
           prompt TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','fired','failed')),
           failure_count INTEGER NOT NULL DEFAULT 0,
           last_fired_at INTEGER,
           next_fire_at INTEGER NOT NULL,
           created_at INTEGER NOT NULL DEFAULT (unixepoch()),
           updated_at INTEGER NOT NULL DEFAULT (unixepoch())
         )`,
      ).run();
    });

    it("does not 500 when scheduled_actions / issue_threads are absent", async () => {
      const { jwt, userId, workspaceId } = await bootstrapOwner();
      const base = Math.floor(Date.now() / 1000);
      await seedAudit(workspaceId, userId, [
        { action: "proposal.merge", resourceKind: "proposal", resourceId: "p1", createdAt: base },
      ]);
      // issue_threads never existed; drop scheduled_actions to simulate
      // a deploy where #33 hasn't shipped.
      await env.DB.prepare("DROP TABLE IF EXISTS scheduled_actions").run();

      // Unfiltered union still works (audit row comes through).
      const all = (await (await authed(jwt, "/api/timeline")).json()) as TimelineBody;
      expect(all.data.entries).toHaveLength(1);
      expect(all.data.entries[0]?.source).toBe("audit");

      // The scheduled pill simply renders empty, not a 500.
      const sched = await authed(jwt, "/api/timeline?sources=scheduled");
      expect(sched.status).toBe(200);
      expect(((await sched.json()) as TimelineBody).data.entries).toEqual([]);

      // The issue pill (table never built) is also empty, not a 500.
      const issue = await authed(jwt, "/api/timeline?sources=issue");
      expect(issue.status).toBe(200);
      expect(((await issue.json()) as TimelineBody).data.entries).toEqual([]);
    });
  });
});
