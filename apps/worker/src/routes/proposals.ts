// SPDX-License-Identifier: Apache-2.0

// Proposal inbox routes:
//
//   GET   /api/proposals                — list (filtered by ?status=)
//   GET   /api/proposals/:id            — single proposal detail
//   POST  /api/proposals/:id/merge      — apply via wiki write path
//   POST  /api/proposals/:id/reject     — soft-delete
//
// Merge calls into the shared writePage() helper (lib/wiki-write.ts) so
// the M4 conflict-detection + index-sync flow runs verbatim. A 409
// CONFLICT response carries the same merge-payload shape as M4's PUT —
// the web UI's existing merge dialog renders against it directly.
//
// Defense layer 5 (admin-merge-only): merge/reject require an
// authenticated workspace owner. Non-owner members can list and view
// proposals but not act on them. v0.0.1 admin == workspace owner.

import { ProposalStatusSchema, validateWikiPath } from "@loomwiki/schema";
import { parseProposalRow } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import type { Env } from "../env.js";
import { serializeProposal } from "../lib/serialize.js";
import { defaultWikiBackend } from "../lib/vault-bootstrap.js";
import { syncIndexesOnUpsert, writePage } from "../lib/wiki-write.js";
import type { AuthEnv } from "../middleware/auth.js";

function requireOwner(c: { var: { user: { id: string }; workspace: { owner_id: string } } }): void {
  if (c.var.workspace.owner_id !== c.var.user.id) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Workspace admin only", { status: 403 });
  }
}

async function loadProposalForWorkspace(
  env: Env,
  workspaceId: string,
  proposalId: string,
): Promise<ReturnType<typeof parseProposalRow>> {
  // Join through ingest_runs → rooms to scope the read by workspace.
  // The proposals table doesn't carry workspace_id directly; the
  // chain is `proposals.run_id → ingest_runs.room_id → rooms.workspace_id`.
  const row = await env.DB.prepare(
    `SELECT p.*, r.workspace_id AS __workspace_id FROM proposals p
       JOIN ingest_runs ir ON ir.id = p.run_id
       JOIN rooms       r  ON r.id  = ir.room_id
      WHERE p.id = ?`,
  )
    .bind(proposalId)
    .first<Record<string, unknown> & { __workspace_id: string }>();
  if (!row) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Proposal not found", { status: 404 });
  }
  if (row.__workspace_id !== workspaceId) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Proposal not found", { status: 404 });
  }
  // Strip the join column before parsing.
  const { __workspace_id, ...proposalRow } = row;
  void __workspace_id;
  return parseProposalRow(proposalRow);
}

export const proposalsRoute = new Hono<AuthEnv>()
  .get("/proposals", async (c) => {
    const statusRaw = c.req.query("status");
    let statusFilter: ReturnType<typeof ProposalStatusSchema.parse> | null = null;
    if (statusRaw !== undefined) {
      const parsed = ProposalStatusSchema.safeParse(statusRaw);
      if (!parsed.success) {
        throw new LoomwikiError(
          ErrorCodes.VALIDATION_FAILED,
          "status must be one of pending|merged|rejected|superseded",
          { status: 400 },
        );
      }
      statusFilter = parsed.data;
    }
    // Default to pending — it's the only status that's actionable.
    const status = statusFilter ?? "pending";

    // Count-only mode for the inbox-badge poll.
    const countOnly = c.req.query("count") === "true";
    if (countOnly) {
      const row = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM proposals p
           JOIN ingest_runs ir ON ir.id = p.run_id
           JOIN rooms       r  ON r.id  = ir.room_id
          WHERE p.status = ? AND r.workspace_id = ?`,
      )
        .bind(status, c.var.workspace.id)
        .first<{ n: number }>();
      return c.json(apiOk({ status, count: row?.n ?? 0 }));
    }

    const limitRaw = c.req.query("limit");
    let limit = 50;
    if (limitRaw !== undefined) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "limit must be a positive integer", {
          status: 400,
        });
      }
      limit = Math.min(parsed, 200);
    }

    const rs = await c.env.DB.prepare(
      `SELECT p.* FROM proposals p
         JOIN ingest_runs ir ON ir.id = p.run_id
         JOIN rooms       r  ON r.id  = ir.room_id
        WHERE p.status = ? AND r.workspace_id = ?
        ORDER BY p.created_at DESC
        LIMIT ?`,
    )
      .bind(status, c.var.workspace.id, limit)
      .all();
    const rows = (rs.results ?? []).map((r) => parseProposalRow(r));
    return c.json(apiOk({ proposals: rows.map(serializeProposal) }));
  })

  .get("/proposals/:id", async (c) => {
    const proposal = await loadProposalForWorkspace(c.env, c.var.workspace.id, c.req.param("id"));
    return c.json(apiOk({ proposal: serializeProposal(proposal) }));
  })

  .post("/proposals/:id/merge", async (c) => {
    requireOwner(c);
    const proposal = await loadProposalForWorkspace(c.env, c.var.workspace.id, c.req.param("id"));
    if (proposal.status !== "pending") {
      throw new LoomwikiError(
        ErrorCodes.VALIDATION_FAILED,
        `Proposal is ${proposal.status}, only pending proposals can be merged`,
        { status: 409 },
      );
    }
    // Defense in depth: re-validate the path even though the row was
    // gated at insert time. A future migration that loosened the
    // validator must not retroactively bless old rows.
    if (!validateWikiPath(proposal.page_path)) {
      throw new LoomwikiError(
        ErrorCodes.VALIDATION_FAILED,
        "Proposal page_path is not on the wiki allowlist",
        { status: 400 },
      );
    }

    // Optional client-supplied before_sha lets the merge fail loudly
    // if the wiki page changed since the inbox UI loaded the proposal.
    // When omitted, M4's conflict detection still applies (a present
    // page without before_sha => 409 with the merge dialog payload).
    const body = (await c.req.json().catch(() => null)) as { before_sha?: string } | null;

    const backend = defaultWikiBackend(c.env);
    const writeResult = await writePage(backend, proposal.page_path, {
      raw: proposal.after_content,
      before_sha: body?.before_sha,
    });
    await syncIndexesOnUpsert(c.env, writeResult);

    const nowSec = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `UPDATE proposals SET status = 'merged', reviewed_at = ?, reviewed_by = ?, artifacts_commit = ?
         WHERE id = ? AND status = 'pending'`,
    )
      .bind(nowSec, c.var.user.id, writeResult.sha, proposal.id)
      .run();

    return c.json(apiOk({ merged: true, page_path: writeResult.path, sha: writeResult.sha }));
  })

  .post("/proposals/:id/reject", async (c) => {
    requireOwner(c);
    const proposal = await loadProposalForWorkspace(c.env, c.var.workspace.id, c.req.param("id"));
    if (proposal.status !== "pending") {
      throw new LoomwikiError(
        ErrorCodes.VALIDATION_FAILED,
        `Proposal is ${proposal.status}, only pending proposals can be rejected`,
        { status: 409 },
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `UPDATE proposals SET status = 'rejected', reviewed_at = ?, reviewed_by = ?
         WHERE id = ? AND status = 'pending'`,
    )
      .bind(nowSec, c.var.user.id, proposal.id)
      .run();
    return c.json(apiOk({ rejected: true, proposal_id: proposal.id }));
  });
