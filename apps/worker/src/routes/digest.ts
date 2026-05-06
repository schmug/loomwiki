// SPDX-License-Identifier: Apache-2.0

// Admin manual trigger for digest re-rendering. The cron path runs the
// same code via scheduled.ts; this route lets operators backfill or
// re-render a date after a fix.
//
// POST /api/_admin/digest/render?date=YYYY-MM-DD
//   Owner-only. Idempotent: re-runs overwrite cleanly.

import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import { isValidIsoDate } from "../lib/chat-log.js";
import { renderDailyDigest } from "../lib/digest-delivery.js";
import type { AuthEnv } from "../middleware/auth.js";

function requireOwner(c: { var: { user: { id: string }; workspace: { owner_id: string } } }): void {
  if (c.var.workspace.owner_id !== c.var.user.id) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Workspace owner only", { status: 403 });
  }
}

export const digestRoute = new Hono<AuthEnv>().post("/_admin/digest/render", async (c) => {
  requireOwner(c);
  const date = c.req.query("date");
  if (!date || !isValidIsoDate(date)) {
    throw new LoomwikiError(
      ErrorCodes.VALIDATION_FAILED,
      "Query param `date` must be a valid YYYY-MM-DD string",
      { status: 400 },
    );
  }
  const result = await renderDailyDigest({
    env: c.env,
    date,
    workspaceId: c.var.workspace.id,
  });
  return c.json(apiOk(result));
});
