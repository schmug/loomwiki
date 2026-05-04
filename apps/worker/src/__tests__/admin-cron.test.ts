// SPDX-License-Identifier: Apache-2.0

// Tests for POST /api/_admin/cron/archive-day. Owner-only, validates
// the date param, and shares the archiveDay() code path with the
// scheduled() cron handler. We hit SELF.fetch so the full Hono
// pipeline (auth → owner gate → handler → ApiResult) runs.

import { SELF, env } from "cloudflare:test";
import { id } from "@loomwiki/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";
import { type JwtFixture, makeJwtFixture } from "./__fixtures__/jwt.js";

let fixture: JwtFixture;

async function clearWikiKv(): Promise<void> {
  const list = await env.WIKI_KV.list();
  for (const k of list.keys) await env.WIKI_KV.delete(k.name);
}

beforeAll(async () => {
  await applyMigrations();
  fixture = await makeJwtFixture();
});

beforeEach(async () => {
  await resetDb();
  await clearWikiKv();
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

interface Ok<T> {
  ok: true;
  data: T;
}
interface Err {
  ok: false;
  error: { code: string; message: string };
}

async function authedFetch(jwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("CF-Access-Jwt-Assertion", jwt);
  return SELF.fetch(`https://api.local${path}`, { ...init, headers });
}

async function bootstrapOwnerAndRoom(): Promise<{
  ownerJwt: string;
  ownerId: string;
  roomId: string;
}> {
  // Hitting /api/me triggers JIT user + workspace bootstrap; the first
  // caller becomes workspace owner.
  const ownerJwt = await fixture.mint({ email: "owner@example.com" });
  const me = await authedFetch(ownerJwt, "/api/me");
  const meBody = (await me.json()) as { data: { user: { id: string }; workspace: { id: string } } };
  const ownerId = meBody.data.user.id;
  const create = await authedFetch(ownerJwt, `/api/workspaces/${meBody.data.workspace.id}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: "general", name: "General" }),
  });
  const room = (await create.json()) as { data: { room: { id: string } } };
  return { ownerJwt, ownerId, roomId: room.data.room.id };
}

const TARGET_DATE = "2026-05-03";
const T0 = Math.floor(Date.parse(`${TARGET_DATE}T08:00:00Z`) / 1000);

describe("POST /api/_admin/cron/archive-day", () => {
  it("returns 401 without a JWT", async () => {
    const res = await SELF.fetch(
      `https://api.local/api/_admin/cron/archive-day?date=${TARGET_DATE}`,
      { method: "POST" },
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-owner caller", async () => {
    await bootstrapOwnerAndRoom();
    const intruderJwt = await fixture.mint({ email: "intruder@example.com" });
    // /api/me bootstraps the user but not as owner (workspace already
    // exists, owned by the first caller).
    await authedFetch(intruderJwt, "/api/me");
    const res = await authedFetch(intruderJwt, `/api/_admin/cron/archive-day?date=${TARGET_DATE}`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Err;
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 for a missing or malformed date param", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const missing = await authedFetch(ownerJwt, "/api/_admin/cron/archive-day", { method: "POST" });
    expect(missing.status).toBe(400);

    const malformed = await authedFetch(ownerJwt, "/api/_admin/cron/archive-day?date=2026-13-99", {
      method: "POST",
    });
    expect(malformed.status).toBe(400);
    const body = (await malformed.json()) as Err;
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("succeeds for the owner and writes a log file the day has messages", async () => {
    const { ownerJwt, ownerId, roomId } = await bootstrapOwnerAndRoom();
    // Seed one message in the target day directly via D1.
    await env.DB.prepare(
      "INSERT INTO messages (id, room_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id(), roomId, ownerId, "hello", T0)
      .run();

    const res = await authedFetch(ownerJwt, `/api/_admin/cron/archive-day?date=${TARGET_DATE}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Ok<{
      date: string;
      files_written: number;
      rooms_processed: number;
      errors: unknown[];
    }>;
    expect(body.data.date).toBe(TARGET_DATE);
    expect(body.data.files_written).toBe(1);
    expect(body.data.rooms_processed).toBe(1);
    expect(body.data.errors).toEqual([]);

    // Confirm the file landed in WIKI_KV at the canonical path.
    const stored = await env.WIKI_KV.get(`wiki:/rooms/general/log/${TARGET_DATE}.md`);
    expect(stored).toMatch(/room: general/);
    expect(stored).toMatch(/message_count: 1/);
    expect(stored).toMatch(/hello/);
  });

  it("is idempotent — running twice yields byte-identical KV content", async () => {
    const { ownerJwt, ownerId, roomId } = await bootstrapOwnerAndRoom();
    await env.DB.prepare(
      "INSERT INTO messages (id, room_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id(), roomId, ownerId, "hello", T0)
      .run();

    const first = await authedFetch(ownerJwt, `/api/_admin/cron/archive-day?date=${TARGET_DATE}`, {
      method: "POST",
    });
    expect(first.status).toBe(200);
    const after1 = await env.WIKI_KV.get(`wiki:/rooms/general/log/${TARGET_DATE}.md`);

    const second = await authedFetch(ownerJwt, `/api/_admin/cron/archive-day?date=${TARGET_DATE}`, {
      method: "POST",
    });
    expect(second.status).toBe(200);
    const after2 = await env.WIKI_KV.get(`wiki:/rooms/general/log/${TARGET_DATE}.md`);

    expect(after1).not.toBeNull();
    expect(after1).toBe(after2);
  });
});
