// SPDX-License-Identifier: Apache-2.0

// Settings — workspace settings (M8 / SPEC §22).
//
//   GET /api/settings/workspace  → { settings }
//   PUT /api/settings/workspace  → { timezone, default_model } (strict)
//
// Owner-only on PUT. The schema enforces an allowlist of timezones
// (~40 IANA zones) and an allowlist of default LLM model ids — typo'd
// values reject with 400. Audit log records the prior settings (or
// null when no row existed yet) and the new settings.

import { UpdateWorkspaceSettingsRequestSchema } from "@loomwiki/schema";
import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import { auditWorkspaceSettingsUpdate } from "../../lib/audit.js";
import { getWorkspaceSettings, setWorkspaceSettings } from "../../lib/workspace-settings.js";
import type { AuthEnv } from "../../middleware/auth.js";

function requireOwner(c: {
  var: { user: { id: string }; workspace: { owner_id: string } };
}): void {
  if (c.var.workspace.owner_id !== c.var.user.id) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Workspace admin only", { status: 403 });
  }
}

export const workspaceSettingsRoute = new Hono<AuthEnv>()
  .get("/", async (c) => {
    const settings = await getWorkspaceSettings(c.env, c.var.workspace.id);
    return c.json(apiOk({ settings }));
  })

  .put("/", async (c) => {
    requireOwner(c);
    const bodyRaw = (await c.req.json().catch(() => null)) as unknown;
    const parsed = UpdateWorkspaceSettingsRequestSchema.safeParse(bodyRaw);
    if (!parsed.success) {
      throw new LoomwikiError(
        ErrorCodes.VALIDATION_FAILED,
        "Body must be { timezone, default_model } from the allowlists",
        { status: 400, details: parsed.error.issues },
      );
    }
    // Read prior to capture the audit-log "before" snapshot. The DB-level
    // check determines whether a real row was previously present (the
    // `getWorkspaceSettings` helper synthesizes a default row when none
    // exists, so we can't infer previously-set-ness from its return).
    const priorRow = await c.env.DB.prepare(
      "SELECT timezone, default_model FROM workspace_settings WHERE workspace_id = ?",
    )
      .bind(c.var.workspace.id)
      .first<{ timezone: string; default_model: string }>();

    const settings = await setWorkspaceSettings(
      c.env,
      c.var.workspace.id,
      c.var.user.id,
      parsed.data,
    );
    c.executionCtx.waitUntil(
      auditWorkspaceSettingsUpdate(
        {
          env: c.env,
          workspaceId: c.var.workspace.id,
          actorUserId: c.var.user.id,
          requestId: c.var.request_id ?? null,
        },
        priorRow ?? null,
        { timezone: parsed.data.timezone, default_model: parsed.data.default_model },
      ).catch(() => {}),
    );
    return c.json(apiOk({ settings }));
  });
