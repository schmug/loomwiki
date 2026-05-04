// SPDX-License-Identifier: Apache-2.0

// Astro middleware. Two responsibilities:
//
//   1. Content-Security-Policy header on every HTML response. Strict
//      `script-src 'self'` (no nonce yet — see the M3 PR description for
//      why). Defense-in-depth alongside @loomwiki/shared's
//      rehype-sanitize: even if a chat message somehow injects a script
//      tag past the sanitizer, the browser refuses to execute it.
//
//   2. SSR-fetched Access login URL exposed to client code via
//      <meta name="loomwiki-access-login-url"> — the api.ts client
//      reads it on 401 to redirect.
//
// Both are read-side wiring only; auth itself is enforced by the worker
// (apps/worker/src/middleware/auth.ts), not here. Astro pages should
// never trust a cookie they read — they should call /api/me.

import { defineMiddleware } from "astro:middleware";

// CSP for HTML responses. Strict — no inline scripts. Inline styles
// allowed because Tailwind v4 in dev injects them; tighten in prod when
// we move to Astro 5.9+ experimental.csp with nonce injection.
//
// `connect-src 'self'` covers the worker proxy (/api/* and ws://) since
// the dev server proxies them under the same origin. Dev WebSocket runs
// on the same origin (Vite proxies ws), so `connect-src 'self'` is
// sufficient. In production, the worker domain is same-origin; if
// loomwiki.com and api.loomwiki.com are split, add api.loomwiki.com to
// connect-src.
const CSP_VALUE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();

  // Only apply CSP to HTML responses; API proxy passthroughs and asset
  // responses don't need it.
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.startsWith("text/html")) {
    response.headers.set("Content-Security-Policy", CSP_VALUE);
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    response.headers.set("X-Frame-Options", "DENY");
  }

  return response;
});
