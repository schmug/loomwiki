// SPDX-License-Identifier: Apache-2.0

// Wiki HTTP routes. Backed by the WikiBackend abstraction — KV-backed
// in v0.0.1, git-backed in M4.5. The Artifacts binding is touched only
// at the admin routes (bootstrap + token mint).
//
// Endpoints:
//   GET    /api/wiki-tree                     → { paths: string[] }
//   GET    /api/wiki/*                        → { path, frontmatter, body, sha }
//   PUT    /api/wiki/*                        → 200 / 409 CONFLICT
//   DELETE /api/wiki/*                        → 200
//   POST   /api/_admin/wiki/bootstrap-vault   → seeds the backend
//   POST   /api/_admin/wiki/vault-token       → mints a write token
//
// Admin routes are gated by workspace ownership (only the workspace
// owner can call them). All other routes are gated by workspace
// membership (already enforced upstream by authMiddleware).

import { WikiPageWriteRequestSchema, validateWikiPath } from "@loomwiki/schema";
import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import { mintVaultToken } from "../lib/artifacts.js";
import { bootstrapVault, defaultWikiBackend } from "../lib/vault-bootstrap.js";
import { deserializePage } from "../lib/wiki-content.js";
import {
  type WikiPagePayload,
  syncIndexesOnDelete,
  syncIndexesOnUpsert,
  writePage,
} from "../lib/wiki-write.js";
import type { AuthEnv } from "../middleware/auth.js";

function pathFromRequest(c: { req: { path: string } }): string {
  // The route is mounted at /api/wiki, so c.req.path looks like
  // /api/wiki/concepts/dmarc.md. Strip the prefix to get the vault
  // path. We also accept the bare /api/wiki shape (empty splat) as a
  // 404, not a 500.
  const match = c.req.path.match(/^\/api\/wiki(\/.*)?$/);
  if (!match || match[1] === undefined || match[1].length === 0) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "wiki path missing", { status: 404 });
  }
  // The backend stores the path with a `/wiki/` prefix, mirroring the
  // vault layout in SPEC §7.2 and what the M7 ingest agent emits.
  const vaultPath = `/wiki${match[1]}`;
  if (!validateWikiPath(vaultPath)) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, `Invalid wiki path: ${vaultPath}`, {
      status: 400,
    });
  }
  return vaultPath;
}

function requireOwner(c: { var: { user: { id: string }; workspace: { owner_id: string } } }): void {
  if (c.var.workspace.owner_id !== c.var.user.id) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Workspace owner only", { status: 403 });
  }
}

async function readPagePayload(
  backend: ReturnType<typeof defaultWikiBackend>,
  path: string,
): Promise<WikiPagePayload | null> {
  const record = await backend.read(path);
  if (record === null) return null;
  const parsed = await deserializePage(record.raw);
  return {
    path,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    sha: record.sha,
  };
}

export const wikiRoute = new Hono<AuthEnv>()
  .get("/wiki-tree", async (c) => {
    const backend = defaultWikiBackend(c.env);
    const paths = await backend.listPaths();
    return c.json(apiOk({ paths }));
  })
  .get("/wiki/*", async (c) => {
    const path = pathFromRequest(c);
    const backend = defaultWikiBackend(c.env);
    const payload = await readPagePayload(backend, path);
    if (payload === null) {
      throw new LoomwikiError(ErrorCodes.NOT_FOUND, "page not found", { status: 404 });
    }
    return c.json(apiOk({ page: payload }));
  })
  .put("/wiki/*", async (c) => {
    const path = pathFromRequest(c);
    const body = await c.req.json().catch(() => null);
    const parsed = WikiPageWriteRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid wiki write request", {
        status: 400,
        details: parsed.error.issues,
      });
    }
    const backend = defaultWikiBackend(c.env);
    const payload = await writePage(backend, path, parsed.data);
    await syncIndexesOnUpsert(c.env, payload);
    return c.json(apiOk({ page: payload }));
  })
  .delete("/wiki/*", async (c) => {
    const path = pathFromRequest(c);
    const backend = defaultWikiBackend(c.env);
    // Owner-only delete keeps the v0.0.1 footprint tight; M5+ may
    // relax to admin members of the workspace.
    requireOwner(c);
    await backend.delete(path);
    await syncIndexesOnDelete(c.env, path);
    return c.json(apiOk({ path }));
  })
  .post("/_admin/wiki/bootstrap-vault", async (c) => {
    requireOwner(c);
    const backend = defaultWikiBackend(c.env);
    const result = await bootstrapVault(c.env, backend);
    return c.json(apiOk({ bootstrap: result }));
  })
  .post("/_admin/wiki/vault-token", async (c) => {
    requireOwner(c);
    const body = (await c.req.json().catch(() => null)) as {
      scope?: "read" | "write";
      ttl_seconds?: number;
    } | null;
    const scope = body?.scope === "read" ? "read" : "write";
    const ttl = typeof body?.ttl_seconds === "number" ? body.ttl_seconds : 3600;
    if (ttl < 60 || ttl > 31_536_000) {
      throw new LoomwikiError(
        ErrorCodes.VALIDATION_FAILED,
        "ttl_seconds must be between 60 and 31536000",
        { status: 400 },
      );
    }
    const minted = await mintVaultToken(c.env, scope, ttl);
    return c.json(
      apiOk({
        token: minted.plaintext,
        scope: minted.scope,
        expires_at: minted.expiresAt,
        remote: minted.remote,
        repo_name: minted.repoName,
      }),
    );
  });
