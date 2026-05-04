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
import { isLocalDevAuthAllowed } from "../middleware/auth.js";

function assertDevModeEnabled(env: Env, request: Request): void {
  // Defense-in-depth: reuse the full local-dev triple-gate (env flag +
  // non-production runtime + localhost CF-Connecting-IP) rather than just the
  // env flag. If an operator accidentally flips ALLOW_LOCAL_DEV_AUTH=true on
  // a public deployment, the IP gate still keeps these endpoints unreachable
  // from the internet.
  if (!isLocalDevAuthAllowed(env, request)) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Not found", { status: 404 });
  }
}

export const debugRoute = new Hono<{ Bindings: Env }>().post("/invalidate-jwks", async (c) => {
  assertDevModeEnabled(c.env, c.req.raw);
  await invalidateAccessJwks(c.env);
  return c.json(apiOk({ invalidated: true }));
});
