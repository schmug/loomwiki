// SPDX-License-Identifier: Apache-2.0

// Single-tenant workspace bootstrap (SPEC §16, Q19 = solo).
//
// v0.0.1 deploys host exactly one workspace per Worker. Rather than add a
// UNIQUE on workspaces.name (which would deviate from SPEC §7.1), we key the
// single row by a constant UUIDv7-formatted ID and let `INSERT ... ON
// CONFLICT(id) DO NOTHING` handle racing first-time requests atomically.
//
// When v0.1 ships multi-workspace, this constant goes away and each workspace
// is created with a fresh UUIDv7 from id().

import { type Workspace, parseWorkspaceRow } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError } from "@loomwiki/shared";
import type { Env } from "../env.js";

// UUIDv7-formatted constant (version nibble = 7, variant nibble = 8).
// Reserved for the v0.0.1 single-tenant default workspace.
export const DEFAULT_WORKSPACE_ID = "00000000-0000-7000-8000-000000000000";

export async function getOrBootstrapWorkspace(env: Env, ownerId: string): Promise<Workspace> {
  const existing = await env.DB.prepare("SELECT * FROM workspaces WHERE id = ?")
    .bind(DEFAULT_WORKSPACE_ID)
    .first();
  if (existing) return parseWorkspaceRow(existing);

  const name = env.WORKSPACE_NAME && env.WORKSPACE_NAME.length > 0 ? env.WORKSPACE_NAME : "default";
  const vaultRepo =
    env.ARTIFACTS_REPO && env.ARTIFACTS_REPO.length > 0 ? env.ARTIFACTS_REPO : "loomwiki-vault";

  await env.DB.prepare(
    "INSERT INTO workspaces (id, name, owner_id, vault_repo) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(DEFAULT_WORKSPACE_ID, name, ownerId, vaultRepo)
    .run();

  const row = await env.DB.prepare("SELECT * FROM workspaces WHERE id = ?")
    .bind(DEFAULT_WORKSPACE_ID)
    .first();
  if (!row) {
    throw new LoomwikiError(ErrorCodes.INTERNAL_ERROR, "Workspace bootstrap failed", {
      status: 500,
    });
  }
  return parseWorkspaceRow(row);
}
