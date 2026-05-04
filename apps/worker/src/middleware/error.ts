// SPDX-License-Identifier: Apache-2.0

// Centralized error → ApiResult mapping. Routes throw LoomwikiError; this
// middleware translates `code` + `status` to the wire format. Unknown errors
// log to console and return INTERNAL_ERROR with `cause` redacted from the
// response.

import { ErrorCodes, apiErr, isLoomwikiError } from "@loomwiki/shared";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../env.js";
import type { AuthEnv } from "./auth.js";

export function registerErrorHandler(app: Hono<AuthEnv> | Hono<{ Bindings: Env }>): void {
  app.onError((err, c) => {
    if (isLoomwikiError(err)) {
      console.warn("[loomwiki] handled error", {
        code: err.code,
        message: err.message,
        status: err.status,
      });
      return c.json(apiErr(err.code, err.message), err.status as ContentfulStatusCode);
    }
    console.error("[loomwiki] unhandled error", err);
    return c.json(apiErr(ErrorCodes.INTERNAL_ERROR, "Internal server error"), 500);
  });
}
