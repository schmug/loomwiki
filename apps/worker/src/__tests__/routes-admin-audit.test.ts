// SPDX-License-Identifier: Apache-2.0

// Admin audit-log read API. Owner-only; pagination by UUIDv7 cursor;
// optional action filter.

import { SELF, env } from "cloudflare:test";
import { id } from "@loomwiki/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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

async function authed(jwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("CF-Access-Jwt-Assertion", jwt);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`https://api.local${path}`, { ...init, headers });
}

async function bootstrapOwner(): Promise<{ jwt: string; userId: string; workspaceId: string }> {
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

async function seedAuditRows(
  workspaceId: string,
  userId: string,
  rows: { action: string; resourceKind: string; resourceId: string; offsetSec?: number }[],
): Promise<string[]> {
  // Returns the id of each inserted row (in insertion order). Inserts
  // rows with monotonically-increasing UUIDv7 + adjustable created_at
  // so tests can reason about ordering deterministically.
  const ids: string[] = [];
  const baseSec = Math.floor(Date.now() / 1000);
  for (const [i, r] of rows.entries()) {
    const rowId = id();
    ids.push(rowId);
    await env.DB.prepare(
      `INSERT INTO audit_log
         (id, workspace_id, actor_user_id, action, resource_kind, resource_id, before_json, after_json, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    )
      .bind(
        rowId,
        workspaceId,
        userId,
        r.action,
        r.resourceKind,
        r.resourceId,
        baseSec + (r.offsetSec ?? i),
      )
      .run();
  }
  return ids;
}

describe("GET /api/_admin/audit", () => {
  it("returns the empty list initially", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/_admin/audit");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entries: unknown[]; next_cursor: string | null } };
    expect(body.data.entries).toEqual([]);
    expect(body.data.next_cursor).toBeNull();
  });

  it("returns rows newest-first and paginates with next_cursor", async () => {
    const { jwt, userId, workspaceId } = await bootstrapOwner();
    await seedAuditRows(workspaceId, userId, [
      { action: "byok.create", resourceKind: "byok", resourceId: "anthropic", offsetSec: 0 },
      { action: "byok.delete", resourceKind: "byok", resourceId: "anthropic", offsetSec: 1 },
      {
        action: "agentsmd.update",
        resourceKind: "agentsmd",
        resourceId: "/AGENTS.md",
        offsetSec: 2,
      },
      {
        action: "workspace_settings.update",
        resourceKind: "workspace_settings",
        resourceId: "workspace",
        offsetSec: 3,
      },
      { action: "manual_ingest.trigger", resourceKind: "ingest", resourceId: id(), offsetSec: 4 },
    ]);

    // Limit=2 → first page is the two newest entries.
    const page1 = await authed(jwt, "/api/_admin/audit?limit=2");
    expect(page1.status).toBe(200);
    const body1 = (await page1.json()) as {
      data: { entries: { id: string; action: string }[]; next_cursor: string | null };
    };
    expect(body1.data.entries).toHaveLength(2);
    expect(body1.data.entries[0]?.action).toBe("manual_ingest.trigger");
    expect(body1.data.entries[1]?.action).toBe("workspace_settings.update");
    expect(body1.data.next_cursor).not.toBeNull();

    // Page 2 — pass the cursor.
    const page2 = await authed(jwt, `/api/_admin/audit?limit=2&since=${body1.data.next_cursor}`);
    const body2 = (await page2.json()) as {
      data: { entries: { action: string }[]; next_cursor: string | null };
    };
    expect(body2.data.entries.map((e) => e.action)).toEqual(["agentsmd.update", "byok.delete"]);
  });

  it("filters by action when ?action= is supplied", async () => {
    const { jwt, userId, workspaceId } = await bootstrapOwner();
    await seedAuditRows(workspaceId, userId, [
      { action: "byok.create", resourceKind: "byok", resourceId: "anthropic" },
      { action: "byok.delete", resourceKind: "byok", resourceId: "anthropic" },
      { action: "byok.create", resourceKind: "byok", resourceId: "openai" },
    ]);
    const res = await authed(jwt, "/api/_admin/audit?action=byok.create");
    const body = (await res.json()) as { data: { entries: { action: string }[] } };
    expect(body.data.entries.map((e) => e.action)).toEqual(["byok.create", "byok.create"]);
  });

  it("rejects an unknown action filter with 400", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/_admin/audit?action=unknown.thing");
    expect(res.status).toBe(400);
  });

  it("rejects a malformed since cursor with 400", async () => {
    const { jwt } = await bootstrapOwner();
    const res = await authed(jwt, "/api/_admin/audit?since=not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("non-owner gets 403", async () => {
    await bootstrapOwner();
    const { jwt: guestJwt } = await plantNonOwner();
    const res = await authed(guestJwt, "/api/_admin/audit");
    expect(res.status).toBe(403);
  });
});
