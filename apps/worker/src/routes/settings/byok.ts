// SPDX-License-Identifier: Apache-2.0

// Settings — BYOK (M8 / SPEC §22).
//
//   GET    /api/settings/byok            — list metadata (no plaintext)
//   PUT    /api/settings/byok/:provider  — set/replace a key (owner-only)
//   DELETE /api/settings/byok/:provider  — soft-delete (owner-only)
//
// Plaintext keys NEVER appear in any GET response. The PUT body carries
// the plaintext; it lives in memory only for the duration of the
// request. The response is metadata only.
//
// Audit log: byok.create / byok.delete are written via auditByokCreate
// / auditByokDelete and wrapped in `c.executionCtx.waitUntil` so the
// audit infra cannot fail the parent op (per ADR-0007).

import { BYOK_UI_PROVIDERS, ByokProviderSchema, SetBYOKKeyRequestSchema } from "@loomwiki/schema";
import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import { auditByokCreate, auditByokDelete } from "../../lib/audit.js";
import { type ByokProvider, deleteBYOK, listBYOK, setBYOK } from "../../lib/byok.js";
import type { AuthEnv } from "../../middleware/auth.js";

function requireOwner(c: {
  var: { user: { id: string }; workspace: { owner_id: string } };
}): void {
  if (c.var.workspace.owner_id !== c.var.user.id) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Workspace admin only", { status: 403 });
  }
}

function parseProviderParam(raw: string | undefined): ByokProvider {
  const parsed = ByokProviderSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Unknown BYOK provider", { status: 400 });
  }
  // v0.0.1 UI surfaces only anthropic + openai. Reject google at the
  // route layer even though the underlying lib supports it — this
  // matches the SPEC §19 M8 deliverable. The runtime mapper still
  // resolves a `byok:google` model if a future operator hand-inserts
  // a row, but the public API path is closed for now.
  if (!(BYOK_UI_PROVIDERS as readonly string[]).includes(parsed.data)) {
    throw new LoomwikiError(
      ErrorCodes.VALIDATION_FAILED,
      `Provider not available in v0.0.1 UI: ${parsed.data}`,
      { status: 400 },
    );
  }
  return parsed.data;
}

export const byokSettingsRoute = new Hono<AuthEnv>()
  .get("/", async (c) => {
    const keys = await listBYOK(c.env, c.var.workspace.id);
    return c.json(apiOk({ keys }));
  })

  .put("/:provider", async (c) => {
    requireOwner(c);
    const provider = parseProviderParam(c.req.param("provider"));
    const bodyRaw = (await c.req.json().catch(() => null)) as unknown;
    const parsed = SetBYOKKeyRequestSchema.safeParse(bodyRaw);
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Body must be { key: string }", {
        status: 400,
        details: parsed.error.issues,
      });
    }
    const meta = await setBYOK(c.env, c.var.workspace.id, provider, parsed.data.key, c.var.user.id);
    c.executionCtx.waitUntil(
      auditByokCreate(
        {
          env: c.env,
          workspaceId: c.var.workspace.id,
          actorUserId: c.var.user.id,
          requestId: c.var.request_id ?? null,
        },
        provider,
      ).catch(() => {
        // Best-effort. Sentry middleware captures unhandled errors at
        // the request layer; the audit-log writer's own failures get
        // swallowed here so a flaky D1 doesn't fail the parent PUT.
      }),
    );
    return c.json(apiOk({ key: meta }));
  })

  .delete("/:provider", async (c) => {
    requireOwner(c);
    const provider = parseProviderParam(c.req.param("provider"));
    await deleteBYOK(c.env, c.var.workspace.id, provider);
    c.executionCtx.waitUntil(
      auditByokDelete(
        {
          env: c.env,
          workspaceId: c.var.workspace.id,
          actorUserId: c.var.user.id,
          requestId: c.var.request_id ?? null,
        },
        provider,
      ).catch(() => {}),
    );
    return c.json(apiOk({ deleted: true, provider }));
  });
