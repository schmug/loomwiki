// SPDX-License-Identifier: Apache-2.0

// Audit log writer tests. Covers the recordAudit primitive plus each
// of the M8 helper wrappers, snapshot truncation, and the
// best-effort-write contract.

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditAgentsMdUpdate,
  auditByokCreate,
  auditByokDelete,
  auditManualIngest,
  auditProposalMerge,
  auditProposalReject,
  auditWorkspaceSettingsUpdate,
  recordAudit,
} from "../lib/audit.js";
import { getOrCreateUser } from "../lib/users.js";
import { DEFAULT_WORKSPACE_ID, getOrBootstrapWorkspace } from "../lib/workspace.js";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";

const VALID_UUIDV7 = "01900000-0000-7000-8000-000000000001";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await resetDb();
});

async function bootstrap(): Promise<{ userId: string }> {
  const user = await getOrCreateUser(env, "owner@example.com");
  await getOrBootstrapWorkspace(env, user.id);
  return { userId: user.id };
}

async function loadAudit(): Promise<
  {
    action: string;
    resource_kind: string;
    resource_id: string | null;
    before_json: string | null;
    after_json: string | null;
  }[]
> {
  const rs = await env.DB.prepare(
    "SELECT action, resource_kind, resource_id, before_json, after_json FROM audit_log ORDER BY created_at ASC, id ASC",
  ).all();
  return (rs.results ?? []) as {
    action: string;
    resource_kind: string;
    resource_id: string | null;
    before_json: string | null;
    after_json: string | null;
  }[];
}

describe("recordAudit", () => {
  it("inserts a row with all fields populated", async () => {
    const { userId } = await bootstrap();
    await recordAudit({
      env,
      workspaceId: DEFAULT_WORKSPACE_ID,
      actorUserId: userId,
      action: "proposal.merge",
      resourceKind: "proposal",
      resourceId: VALID_UUIDV7,
      before: { status: "pending" },
      after: { status: "merged" },
      requestId: "req-abc-123",
    });
    const rows = await loadAudit();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("unreachable");
    expect(row.action).toBe("proposal.merge");
    expect(row.resource_kind).toBe("proposal");
    expect(row.resource_id).toBe(VALID_UUIDV7);
    expect(row.before_json && JSON.parse(row.before_json)).toEqual({ status: "pending" });
    expect(row.after_json && JSON.parse(row.after_json)).toEqual({ status: "merged" });
  });

  it("accepts null actor (cron-triggered actions)", async () => {
    await bootstrap();
    await recordAudit({
      env,
      workspaceId: DEFAULT_WORKSPACE_ID,
      actorUserId: null,
      action: "manual_ingest.trigger",
      resourceKind: "ingest",
      resourceId: VALID_UUIDV7,
    });
    const rows = await loadAudit();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("unreachable");
    expect(row.before_json).toBeNull();
    expect(row.after_json).toBeNull();
  });

  it("truncates oversized snapshots and marks them with _truncated", async () => {
    await bootstrap();
    const huge = "x".repeat(10 * 1024); // 10 KB, > 4 KB cap
    await recordAudit({
      env,
      workspaceId: DEFAULT_WORKSPACE_ID,
      actorUserId: null,
      action: "agentsmd.update",
      resourceKind: "agentsmd",
      resourceId: "/AGENTS.md",
      before: huge,
    });
    const rows = await loadAudit();
    const row = rows[0];
    if (!row) throw new Error("unreachable");
    expect(row.before_json).not.toBeNull();
    if (!row.before_json) throw new Error("unreachable");
    expect(row.before_json.length).toBeLessThanOrEqual(4 * 1024);
    expect(row.before_json).toContain("_truncated");
  });

  it("survives JSON-unserializable values (cycles)", async () => {
    await bootstrap();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await recordAudit({
      env,
      workspaceId: DEFAULT_WORKSPACE_ID,
      actorUserId: null,
      action: "workspace_settings.update",
      resourceKind: "workspace_settings",
      resourceId: "workspace",
      before: cycle,
    });
    const rows = await loadAudit();
    const row = rows[0];
    if (!row) throw new Error("unreachable");
    expect(row.before_json).toContain("_serialize_error");
  });
});

describe("audit-helper wrappers", () => {
  it("byok.create records the provider but never the key", async () => {
    const { userId } = await bootstrap();
    await auditByokCreate(
      { env, workspaceId: DEFAULT_WORKSPACE_ID, actorUserId: userId, requestId: null },
      "anthropic",
    );
    const row = (await loadAudit())[0];
    if (!row) throw new Error("unreachable");
    expect(row.action).toBe("byok.create");
    expect(row.resource_id).toBe("anthropic");
    expect(row.before_json).toBe("null");
    expect(row.after_json).toContain("has_key");
    expect(row.after_json).not.toContain("sk-ant");
  });

  it("byok.delete records the transition", async () => {
    const { userId } = await bootstrap();
    await auditByokDelete(
      { env, workspaceId: DEFAULT_WORKSPACE_ID, actorUserId: userId, requestId: null },
      "openai",
    );
    const row = (await loadAudit())[0];
    if (!row) throw new Error("unreachable");
    expect(row.action).toBe("byok.delete");
    expect(row.resource_id).toBe("openai");
  });

  it("proposal.merge captures before/after wiki state", async () => {
    const { userId } = await bootstrap();
    await auditProposalMerge(
      { env, workspaceId: DEFAULT_WORKSPACE_ID, actorUserId: userId, requestId: null },
      VALID_UUIDV7,
      { wiki_path: "/wiki/x.md", before_sha: null, before_body: null },
      { wiki_path: "/wiki/x.md", after_sha: "abcd1234", after_body_len: 256 },
    );
    const row = (await loadAudit())[0];
    if (!row) throw new Error("unreachable");
    expect(row.action).toBe("proposal.merge");
    expect(row.after_json).toContain("after_sha");
  });

  it("proposal.reject records the rejection", async () => {
    const { userId } = await bootstrap();
    await auditProposalReject(
      { env, workspaceId: DEFAULT_WORKSPACE_ID, actorUserId: userId, requestId: null },
      VALID_UUIDV7,
      { wiki_path: "/wiki/x.md", status: "pending" },
    );
    const row = (await loadAudit())[0];
    if (!row) throw new Error("unreachable");
    expect(row.action).toBe("proposal.reject");
  });

  it("agentsmd.update captures before/after content", async () => {
    const { userId } = await bootstrap();
    await auditAgentsMdUpdate(
      { env, workspaceId: DEFAULT_WORKSPACE_ID, actorUserId: userId, requestId: null },
      { content: "old content", sha: null },
      { content: "new content", sha: "abcd1234" },
    );
    const row = (await loadAudit())[0];
    if (!row) throw new Error("unreachable");
    expect(row.action).toBe("agentsmd.update");
    expect(row.after_json).toContain("new content");
  });

  it("workspace_settings.update + manual_ingest.trigger both write rows", async () => {
    const { userId } = await bootstrap();
    await auditWorkspaceSettingsUpdate(
      { env, workspaceId: DEFAULT_WORKSPACE_ID, actorUserId: userId, requestId: null },
      null,
      { timezone: "UTC", default_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
    );
    await auditManualIngest(
      { env, workspaceId: DEFAULT_WORKSPACE_ID, actorUserId: userId, requestId: null },
      VALID_UUIDV7,
      VALID_UUIDV7,
    );
    const rows = await loadAudit();
    expect(rows.map((r) => r.action)).toEqual([
      "workspace_settings.update",
      "manual_ingest.trigger",
    ]);
  });
});
