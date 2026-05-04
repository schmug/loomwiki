// SPDX-License-Identifier: Apache-2.0

// Dev-only debug endpoints. Hard-gated on ALLOW_LOCAL_DEV_AUTH=true; all
// requests return 404 in production deployments where the flag is false (the
// default). No auth requirement because the gate itself is the entire
// security boundary — operators who flip ALLOW_LOCAL_DEV_AUTH to true must
// also keep the deployment off the public internet.

import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import type { Env } from "../env.js";
import { invalidateAccessJwks } from "../lib/auth.js";

function assertDevModeEnabled(env: Env): void {
  if (env.ALLOW_LOCAL_DEV_AUTH !== "true") {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Not found", { status: 404 });
  }
}

export const debugRoute = new Hono<{ Bindings: Env }>().post("/invalidate-jwks", async (c) => {
  assertDevModeEnabled(c.env);
  await invalidateAccessJwks(c.env);
  return c.json(apiOk({ invalidated: true }));
});
