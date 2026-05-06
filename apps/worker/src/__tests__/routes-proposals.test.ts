// SPDX-License-Identifier: Apache-2.0

// Integration tests for the proposal inbox routes. The merge path is
// the load-bearing assertion — it routes through the shared writePage()
// helper, which means a successful merge results in a real wiki page
// AND a status='merged' row.

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
  // Clear KV between tests so wiki state doesn't leak.
  const list = await env.WIKI_KV.list();
  for (const k of list.keys) await env.WIKI_KV.delete(k.name);
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

async function authed(jwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("CF-Access-Jwt-Assertion", jwt);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`https://api.local${path}`, { ...init, headers });
}

async function bootstrap(): Promise<{ jwt: string; roomId: string; userId: string }> {
  const jwt = await fixture.mint({ email: "alice@example.com" });
  const me = await SELF.fetch("https://api.local/api/me", {
    headers: { "CF-Access-Jwt-Assertion": jwt },
  });
  const meBody = (await me.json()) as {
    data: { user: { id: string }; workspace: { id: string } };
  };
  const create = await SELF.fetch(
    `https://api.local/api/workspaces/${meBody.data.workspace.id}/rooms`,
    {
      method: "POST",
      headers: { "CF-Access-Jwt-Assertion": jwt, "content-type": "application/json" },
      body: JSON.stringify({ slug: "ops", name: "Ops" }),
    },
  );
  const room = (await create.json()) as { data: { room: { id: string } } };
  return { jwt, roomId: room.data.room.id, userId: meBody.data.user.id };
}

async function seedProposal(args: {
  roomId: string;
  userId: string;
  pagePath?: string;
}): Promise<{ proposalId: string; runId: string; pagePath: string }> {
  const runId = id();
  await env.DB.prepare(
    "INSERT INTO ingest_runs (id, room_id, triggered_by, status) VALUES (?, ?, ?, 'succeeded')",
  )
    .bind(runId, args.roomId, args.userId)
    .run();
  const proposalId = id();
  const pagePath = args.pagePath ?? "/wiki/decisions/2026-05-dmarc.md";
  const content = `---
title: DMARC Rollout
kind: decision
created: 2026-05-04
last_updated: 2026-05-04
status: draft
---

# DMARC Rollout

Body.
`;
  await env.DB.prepare(
    `INSERT INTO proposals (id, run_id, page_path, action, after_content, rationale, status)
     VALUES (?, ?, ?, 'create', ?, 'rationale', 'pending')`,
  )
    .bind(proposalId, runId, pagePath, content)
    .run();
  return { proposalId, runId, pagePath };
}

describe("GET /api/proposals", () => {
  it("returns the empty pending list initially", async () => {
    const { jwt } = await bootstrap();
    const res = await authed(jwt, "/api/proposals?status=pending");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { proposals: unknown[] } };
    expect(body.data.proposals).toEqual([]);
  });

  it("returns the count when count=true", async () => {
    const { jwt, roomId, userId } = await bootstrap();
    await seedProposal({ roomId, userId });
    await seedProposal({ roomId, userId, pagePath: "/wiki/concepts/spf.md" });
    const res = await authed(jwt, "/api/proposals?count=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number; status: string } };
    expect(body.data.count).toBe(2);
    expect(body.data.status).toBe("pending");
  });

  it("rejects unknown status", async () => {
    const { jwt } = await bootstrap();
    const res = await authed(jwt, "/api/proposals?status=auto_merged");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/proposals/:id", () => {
  it("returns the proposal", async () => {
    const { jwt, roomId, userId } = await bootstrap();
    const seeded = await seedProposal({ roomId, userId });
    const res = await authed(jwt, `/api/proposals/${seeded.proposalId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { proposal: { id: string; page_path: string } } };
    expect(body.data.proposal.id).toBe(seeded.proposalId);
    expect(body.data.proposal.page_path).toBe(seeded.pagePath);
  });

  it("returns 404 for an unknown proposal id", async () => {
    const { jwt } = await bootstrap();
    const res = await authed(jwt, `/api/proposals/${id()}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/proposals/:id/merge", () => {
  it("happy path: writes the wiki page and marks the proposal merged", async () => {
    const { jwt, roomId, userId } = await bootstrap();
    const seeded = await seedProposal({ roomId, userId });

    const res = await authed(jwt, `/api/proposals/${seeded.proposalId}/merge`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { merged: boolean; page_path: string; sha: string };
    };
    expect(body.data.merged).toBe(true);
    expect(body.data.page_path).toBe(seeded.pagePath);
    expect(body.data.sha).toMatch(/^[0-9a-f]{64}$/);

    // Wiki page should now be readable.
    const get = await authed(jwt, `/api${seeded.pagePath}`);
    expect(get.status).toBe(200);

    // Proposal row updated.
    const row = await env.DB.prepare(
      "SELECT status, reviewed_by, artifacts_commit FROM proposals WHERE id = ?",
    )
      .bind(seeded.proposalId)
      .first<{ status: string; reviewed_by: string; artifacts_commit: string }>();
    expect(row?.status).toBe("merged");
    expect(row?.reviewed_by).toBe(userId);
    expect(row?.artifacts_commit).toBe(body.data.sha);
  });

  it("non-owner gets 403", async () => {
    const { jwt, roomId, userId } = await bootstrap();
    const seeded = await seedProposal({ roomId, userId });
    // Different user, same workspace (v0.0.1 single-tenant). Their
    // user.id != workspace.owner_id so they fail requireOwner().
    const otherJwt = await fixture.mint({ email: "bob@example.com" });
    const res = await authed(otherJwt, `/api/proposals/${seeded.proposalId}/merge`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("rejects merging an already-merged proposal", async () => {
    const { jwt, roomId, userId } = await bootstrap();
    const seeded = await seedProposal({ roomId, userId });
    await env.DB.prepare("UPDATE proposals SET status = 'merged' WHERE id = ?")
      .bind(seeded.proposalId)
      .run();
    const res = await authed(jwt, `/api/proposals/${seeded.proposalId}/merge`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/proposals/:id/reject", () => {
  it("soft-deletes via status='rejected'", async () => {
    const { jwt, roomId, userId } = await bootstrap();
    const seeded = await seedProposal({ roomId, userId });
    const res = await authed(jwt, `/api/proposals/${seeded.proposalId}/reject`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT status, reviewed_by FROM proposals WHERE id = ?")
      .bind(seeded.proposalId)
      .first<{ status: string; reviewed_by: string }>();
    expect(row?.status).toBe("rejected");
    expect(row?.reviewed_by).toBe(userId);
  });
});
