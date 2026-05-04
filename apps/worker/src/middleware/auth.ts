// SPDX-License-Identifier: Apache-2.0

// Hono auth middleware. Validates a Cloudflare Access JWT, JIT-provisions the
// user and the single-tenant workspace, and exposes both via `c.var`.
//
// Local-dev bypass (`X-Local-Dev-Email`) is **triple-gated**:
//   1. process.env.NODE_ENV !== "production"
//   2. env.ALLOW_LOCAL_DEV_AUTH === "true"
//   3. CF-Connecting-IP is absent or 127.0.0.1 / ::1
// All three must hold; fail any one and the bypass header is ignored. The
// IP gate is the load-bearing one (1) is mostly symbolic in Workers since
// process.env.NODE_ENV is undefined in production runtime).
//
// Reference: docs/SECURITY.md §6.

import type { User, Workspace } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError } from "@loomwiki/shared";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env.js";
import { verifyAccessJwt } from "../lib/auth.js";
import { getOrCreateUser } from "../lib/users.js";
import { getOrBootstrapWorkspace } from "../lib/workspace.js";

export type AuthVariables = { user: User; workspace: Workspace };
export type AuthEnv = { Bindings: Env; Variables: AuthVariables };

const LOCALHOST_IPS = new Set(["127.0.0.1", "::1"]);

let warnedLocalDev = false;
function warnLocalDevOnce(): void {
  if (warnedLocalDev) return;
  warnedLocalDev = true;
  console.warn("[loomwiki] LOCAL DEV AUTH ENABLED — ABORT IF YOU SEE THIS IN PRODUCTION.");
}

export function isLocalDevAuthAllowed(env: Env, request: Request): boolean {
  if (env.ALLOW_LOCAL_DEV_AUTH !== "true") return false;

  // Workers expose process.env via nodejs_compat. NODE_ENV is undefined in
  // production runtime, so this gate is mostly symbolic — the IP check is the
  // real defense — but the M1 prompt mandates it.
  const nodeEnv = typeof process !== "undefined" && process.env ? process.env.NODE_ENV : undefined;
  if (nodeEnv === "production") return false;

  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp !== null && !LOCALHOST_IPS.has(cfIp)) return false;

  return true;
}

export const authMiddleware: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const env = c.env;

  let email: string | null = null;

  const localDevHeader = c.req.header("X-Local-Dev-Email");
  if (localDevHeader && isLocalDevAuthAllowed(env, c.req.raw)) {
    warnLocalDevOnce();
    email = localDevHeader.trim().toLowerCase();
    if (!email) {
      throw new LoomwikiError(ErrorCodes.AUTH_REQUIRED, "X-Local-Dev-Email header is empty", {
        status: 401,
      });
    }
  } else {
    const jwt = c.req.header("CF-Access-Jwt-Assertion");
    if (!jwt) {
      throw new LoomwikiError(ErrorCodes.AUTH_REQUIRED, "Missing Access JWT", {
        status: 401,
      });
    }
    const claims = await verifyAccessJwt(env, jwt);
    email = claims.email.toLowerCase();
  }

  const user = await getOrCreateUser(env, email);
  const workspace = await getOrBootstrapWorkspace(env, user.id);

  c.set("user", user);
  c.set("workspace", workspace);
  await next();
};
