// SPDX-License-Identifier: Apache-2.0

// Per-request correlation id used by the audit log + Sentry tags.
//
// The id is a UUIDv7 (sortable) generated at the start of each request
// in the audit middleware. Routes that record audit entries pass the
// id through so audit rows + Sentry events for the same request line
// up. Hono carries it via c.var.request_id.

import { id as newId } from "@loomwiki/shared";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env.js";

export interface RequestContextVariables {
  request_id: string;
}

export type RequestContextEnv = {
  Bindings: Env;
  Variables: RequestContextVariables;
};

/**
 * Hono middleware: stamp every request with a UUIDv7 id and echo it
 * back via the X-Request-Id response header so live debugging and the
 * smoke script can correlate. Must run before the audit + sentry
 * middlewares so they can read c.var.request_id.
 */
export const requestContextMiddleware: MiddlewareHandler<RequestContextEnv> = async (c, next) => {
  // Honor an inbound X-Request-Id when present (so a probe can dictate
  // the id and assert it back in the audit log). Validate shape so a
  // hostile caller can't inject newlines into the response header.
  const inbound = c.req.header("X-Request-Id");
  const reqId = inbound && /^[A-Za-z0-9-]{1,64}$/.test(inbound) ? inbound : newId();
  c.set("request_id", reqId);
  await next();
  // Skip header-setting on WebSocket upgrade responses (status 101 with
  // an attached `webSocket`). Workerd freezes headers on 101 responses,
  // so attempting `c.res.headers.set` throws and tears down the
  // upgrade. We don't have a request_id correlation surface for an
  // active socket anyway — the WS handshake is the only round-trip the
  // header could ride, and the audit-log writer reads c.var.request_id
  // directly rather than parsing it back off the response.
  try {
    if (c.res.status !== 101) {
      c.res.headers.set("X-Request-Id", reqId);
    }
  } catch {
    // Defense in depth: ignore "headers immutable" errors so a route
    // that ends in a frozen-headers response can't crash the request.
  }
};
