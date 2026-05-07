// SPDX-License-Identifier: Apache-2.0

// Workspace settings storage layer (M8).
//
// Single-row-per-workspace D1 table provisioned by 0004_audit.sql.
// First read after a fresh deploy returns env-default-derived values
// (timezone defaults to env.WORKSPACE_DEFAULT_TIMEZONE ?? "UTC", model
// defaults to env.DEFAULT_LLM_MODEL). PUT /api/settings/workspace is
// the only writer; the route layer enforces owner-only access.

import type { UpdateWorkspaceSettingsRequest, WorkspaceSettingsRow } from "@loomwiki/schema";
import { parseWorkspaceSettingsRow } from "@loomwiki/schema/parsers";
import type { Env } from "../env.js";

/**
 * Read workspace settings, returning env-derived defaults when the
 * workspace has not yet saved customized values. Always returns a
 * fully-populated object so callers don't need to special-case "no
 * row" — but the `updated_by` field is `null` for the synthetic
 * default row (as opposed to a real persisted-but-unchanged row).
 */
export async function getWorkspaceSettings(
  env: Env,
  workspaceId: string,
): Promise<WorkspaceSettingsRow> {
  const row = await env.DB.prepare(
    `SELECT workspace_id, timezone, default_model, updated_at, updated_by
       FROM workspace_settings WHERE workspace_id = ?`,
  )
    .bind(workspaceId)
    .first();
  if (row !== null) return parseWorkspaceSettingsRow(row);

  // Synthetic default row, parsed through the same schema so the API
  // shape is uniform.
  return parseWorkspaceSettingsRow({
    workspace_id: workspaceId,
    timezone:
      env.WORKSPACE_DEFAULT_TIMEZONE && env.WORKSPACE_DEFAULT_TIMEZONE.length > 0
        ? env.WORKSPACE_DEFAULT_TIMEZONE
        : "UTC",
    default_model: env.DEFAULT_LLM_MODEL,
    updated_at: 0,
    updated_by: null,
  });
}

/**
 * Upsert workspace settings. Caller is the workspace owner (enforced
 * at the route layer). Records `updated_at` (now) and `updated_by`
 * (the actor's user id).
 */
export async function setWorkspaceSettings(
  env: Env,
  workspaceId: string,
  actorUserId: string,
  next: UpdateWorkspaceSettingsRequest,
): Promise<WorkspaceSettingsRow> {
  const nowSec = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO workspace_settings (workspace_id, timezone, default_model, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         timezone = excluded.timezone,
         default_model = excluded.default_model,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
  )
    .bind(workspaceId, next.timezone, next.default_model, nowSec, actorUserId)
    .run();
  return parseWorkspaceSettingsRow({
    workspace_id: workspaceId,
    timezone: next.timezone,
    default_model: next.default_model,
    updated_at: nowSec,
    updated_by: actorUserId,
  });
}
