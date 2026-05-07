// SPDX-License-Identifier: Apache-2.0

// Settings — AGENTS.md editor (M8 / SPEC §22).
//
//   GET /api/settings/agentsmd  → { content, sha }
//   PUT /api/settings/agentsmd  → { content, confirmed: true }
//
// Owner-only. The PUT body must carry `confirmed: true` literal — server
// enforces the confirmation dialog so a mis-clicked save can't bypass
// the explicit user-consent contract. Content is hashed with SHA-256
// hex; the resulting sha is returned as the optimistic-lock token.
//
// The GET path falls back to the bundled vault-template seed when the
// vault has not yet been bootstrapped, so the editor can render the
// canonical content (with a null sha to indicate "no row in the
// backend yet"). Saving from this state writes the first AGENTS.md row.

import { UpdateAgentsMdRequestSchema } from "@loomwiki/schema";
import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import { VAULT_TEMPLATE_FILES } from "../../generated/vault-template-manifest.js";
import { auditAgentsMdUpdate } from "../../lib/audit.js";
import { defaultWikiBackend } from "../../lib/vault-bootstrap.js";
import type { AuthEnv } from "../../middleware/auth.js";

const AGENTS_MD_PATH = "/AGENTS.md";

function requireOwner(c: {
  var: { user: { id: string }; workspace: { owner_id: string } };
}): void {
  if (c.var.workspace.owner_id !== c.var.user.id) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Workspace admin only", { status: 403 });
  }
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function findTemplateAgentsMd(): string {
  const file = VAULT_TEMPLATE_FILES.find((f) => f.path === AGENTS_MD_PATH);
  if (!file) {
    // Build invariant — the precompute script always emits AGENTS.md.
    throw new LoomwikiError(ErrorCodes.INTERNAL_ERROR, "vault template missing /AGENTS.md", {
      status: 500,
    });
  }
  return file.content;
}

export const agentsMdSettingsRoute = new Hono<AuthEnv>()
  .get("/", async (c) => {
    const backend = defaultWikiBackend(c.env);
    const existing = await backend.read(AGENTS_MD_PATH);
    if (existing !== null) {
      return c.json(apiOk({ content: existing.raw, sha: existing.sha }));
    }
    // Pre-bootstrap fallback: render the seed text so the operator can
    // edit before the first ingest run materializes the page in KV.
    return c.json(apiOk({ content: findTemplateAgentsMd(), sha: null }));
  })

  .put("/", async (c) => {
    requireOwner(c);
    const bodyRaw = (await c.req.json().catch(() => null)) as unknown;
    const parsed = UpdateAgentsMdRequestSchema.safeParse(bodyRaw);
    if (!parsed.success) {
      throw new LoomwikiError(
        ErrorCodes.VALIDATION_FAILED,
        "Body must be { content: string, confirmed: true }",
        { status: 400, details: parsed.error.issues },
      );
    }
    const newSha = await sha256Hex(parsed.data.content);
    const backend = defaultWikiBackend(c.env);
    const before = await backend.read(AGENTS_MD_PATH);
    await backend.write({
      path: AGENTS_MD_PATH,
      raw: parsed.data.content,
      sha: newSha,
    });
    c.executionCtx.waitUntil(
      auditAgentsMdUpdate(
        {
          env: c.env,
          workspaceId: c.var.workspace.id,
          actorUserId: c.var.user.id,
          requestId: c.var.request_id ?? null,
        },
        { content: before?.raw ?? "", sha: before?.sha ?? null },
        { content: parsed.data.content, sha: newSha },
      ).catch(() => {}),
    );
    return c.json(apiOk({ saved: true, sha: newSha }));
  });
