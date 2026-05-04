// SPDX-License-Identifier: Apache-2.0

// Operator-facing admin route to invoke the chat-log archival cron
// for an explicit date. Used for backfill, smoke verification, and
// re-archiving after a vault reset. Same code path as scheduled().
//
// POST /api/_admin/cron/archive-day?date=YYYY-MM-DD
//   Owner-only. Returns ApiResult<ArchiveDaySummary>.

import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import { archiveDay, isValidIsoDate } from "../lib/chat-log.js";
import type { AuthEnv } from "../middleware/auth.js";

function requireOwner(c: { var: { user: { id: string }; workspace: { owner_id: string } } }): void {
  if (c.var.workspace.owner_id !== c.var.user.id) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Workspace owner only", { status: 403 });
  }
}

export const adminCronRoute = new Hono<AuthEnv>().post("/_admin/cron/archive-day", async (c) => {
  requireOwner(c);
  const date = c.req.query("date");
  if (!date || !isValidIsoDate(date)) {
    throw new LoomwikiError(
      ErrorCodes.VALIDATION_FAILED,
      "Query param `date` must be a valid YYYY-MM-DD string",
      { status: 400 },
    );
  }
  const summary = await archiveDay({ env: c.env, dateUtc: date });
  return c.json(apiOk(summary));
});
