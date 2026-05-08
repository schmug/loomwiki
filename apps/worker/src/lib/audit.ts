// SPDX-License-Identifier: Apache-2.0

// Append-only audit log writes (M8 / SPEC §22 / ADR-0007).
//
// Records workspace-owner-only actions (proposal merges/rejects, BYOK
// CRUD, AGENTS.md edits, workspace-settings updates, manual ingest
// triggers). Reads via GET /api/_admin/audit — JSON only in v0.0.1; a
// web UI lands in v0.1.
//
// Best-effort write contract: the audit row INSERT is wrapped via
// `c.executionCtx.waitUntil` at the call site so a failure doesn't
// fail the parent operation. Audit-log absence is bad, but blocking a
// merge/reject on the audit-log infrastructure is worse — the failure
// is captured by Sentry so the operator notices.
//
// Snapshot truncation: before_json / after_json are bounded to 4 KB
// each. Larger payloads are truncated with a `…[truncated]` suffix and
// flagged by a "_truncated": true sidecar key. Computing diffs on read
// (rather than storing pre-computed diffs) keeps writes cheap.

import {
  AUDIT_SNAPSHOT_MAX_BYTES,
  type AuditAction,
  type AuditResourceKind,
} from "@loomwiki/schema";
import { id as newId } from "@loomwiki/shared";
import type { Env } from "../env.js";

export interface RecordAuditOptions {
  env: Env;
  workspaceId: string;
  /** UUIDv7, or null for system/cron-driven actions. */
  actorUserId: string | null;
  action: AuditAction;
  resourceKind: AuditResourceKind;
  /** Resource id (proposal id, provider name, "workspace", etc.) — `null` when the action has no single resource. */
  resourceId: string | null;
  /** Optional snapshot of the resource before the action. JSON-stringified, then 4 KB-truncated. */
  before?: unknown;
  /** Optional snapshot of the resource after the action. */
  after?: unknown;
  /** Per-request correlation id (from c.var.request_id). */
  requestId?: string | null;
}

/**
 * Insert one audit row. Caller is responsible for not awaiting in the
 * critical path — wrap with `c.executionCtx.waitUntil(recordAudit(...))`
 * so the parent operation isn't blocked by D1 latency or transient
 * insert failures.
 */
export async function recordAudit(opts: RecordAuditOptions): Promise<void> {
  const id = newId();
  const beforeJson = serializeSnapshot(opts.before);
  const afterJson = serializeSnapshot(opts.after);
  const nowSec = Math.floor(Date.now() / 1000);
  await opts.env.DB.prepare(
    `INSERT INTO audit_log
       (id, workspace_id, actor_user_id, action, resource_kind, resource_id,
        before_json, after_json, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.workspaceId,
      opts.actorUserId,
      opts.action,
      opts.resourceKind,
      opts.resourceId,
      beforeJson,
      afterJson,
      opts.requestId ?? null,
      nowSec,
    )
    .run();
}

/**
 * JSON-stringify and clip to 4 KB. Returns null when `value` is
 * undefined (the column is nullable and "no snapshot" is meaningful —
 * a `byok.create` has no before, a `byok.delete` has no after).
 */
function serializeSnapshot(value: unknown): string | null {
  if (value === undefined) return null;
  let str: string;
  try {
    str = JSON.stringify(value);
  } catch {
    str = JSON.stringify({ _serialize_error: true });
  }
  if (str.length <= AUDIT_SNAPSHOT_MAX_BYTES) return str;
  // Embed the truncation marker inside a JSON object so downstream
  // readers can parse and detect it without inferring from string
  // shape. The leading bytes of the original payload are preserved as
  // an opaque prefix for forensic context.
  const prefix = str.slice(0, AUDIT_SNAPSHOT_MAX_BYTES - 64);
  const wrapped = JSON.stringify({ _truncated: true, prefix });
  // Worst case wrapped exceeds the cap due to JSON-encoding the prefix
  // again — clip to AUDIT_SNAPSHOT_MAX_BYTES as a hard backstop.
  return wrapped.length <= AUDIT_SNAPSHOT_MAX_BYTES
    ? wrapped
    : wrapped.slice(0, AUDIT_SNAPSHOT_MAX_BYTES);
}

// ---- Convenience helpers per action enum value ----

interface AuditCallContext {
  env: Env;
  workspaceId: string;
  actorUserId: string | null;
  requestId?: string | null;
}

export function auditProposalMerge(
  ctx: AuditCallContext,
  proposalId: string,
  before: { wiki_path: string; before_sha: string | null; before_body: string | null },
  after: { wiki_path: string; after_sha: string; after_body_len: number },
): Promise<void> {
  return recordAudit({
    ...ctx,
    action: "proposal.merge",
    resourceKind: "proposal",
    resourceId: proposalId,
    before,
    after,
  });
}

export function auditProposalReject(
  ctx: AuditCallContext,
  proposalId: string,
  before: { wiki_path: string; status: string },
): Promise<void> {
  return recordAudit({
    ...ctx,
    action: "proposal.reject",
    resourceKind: "proposal",
    resourceId: proposalId,
    before,
    after: { ...before, status: "rejected" },
  });
}

export function auditByokCreate(ctx: AuditCallContext, provider: string): Promise<void> {
  // Never include the key, ciphertext, or any prefix of either.
  return recordAudit({
    ...ctx,
    action: "byok.create",
    resourceKind: "byok",
    resourceId: provider,
    before: null,
    after: { provider, has_key: true },
  });
}

export function auditByokDelete(ctx: AuditCallContext, provider: string): Promise<void> {
  return recordAudit({
    ...ctx,
    action: "byok.delete",
    resourceKind: "byok",
    resourceId: provider,
    before: { provider, has_key: true },
    after: { provider, has_key: false },
  });
}

export function auditAgentsMdUpdate(
  ctx: AuditCallContext,
  before: { content: string; sha: string | null },
  after: { content: string; sha: string },
): Promise<void> {
  return recordAudit({
    ...ctx,
    action: "agentsmd.update",
    resourceKind: "agentsmd",
    resourceId: "/AGENTS.md",
    before,
    after,
  });
}

export function auditWorkspaceSettingsUpdate(
  ctx: AuditCallContext,
  before: { timezone: string; default_model: string } | null,
  after: { timezone: string; default_model: string },
): Promise<void> {
  return recordAudit({
    ...ctx,
    action: "workspace_settings.update",
    resourceKind: "workspace_settings",
    resourceId: "workspace",
    before,
    after,
  });
}

export function auditManualIngest(
  ctx: AuditCallContext,
  roomId: string,
  runId: string,
): Promise<void> {
  return recordAudit({
    ...ctx,
    action: "manual_ingest.trigger",
    resourceKind: "ingest",
    resourceId: runId,
    before: null,
    after: { room_id: roomId, run_id: runId },
  });
}
