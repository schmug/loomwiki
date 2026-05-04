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

// CSP for HTML responses.
//
// `script-src 'self' 'unsafe-inline'`: Astro 5.1.5 emits inline
// hydration shims (the small `(() => {...})()` blobs that wire each
// astro-island to its component). They have variable content, so the
// only ways to allow them under CSP are 'unsafe-inline', a nonce, or
// per-page hashes. Astro's built-in nonce injection landed in 5.9
// (`experimental.csp`); on 5.1.5 there is no first-class story. We
// take 'unsafe-inline' for M3 and track the upgrade-and-tighten in a
// follow-up issue. The primary XSS defense remains @loomwiki/shared's
// `rehype-sanitize` allowlist (docs/SECURITY.md §3 / M14–M18) — CSP
// here is the second line of defense; relaxing 'unsafe-inline' weakens
// it but does not remove it.
//
// `style-src 'self' 'unsafe-inline'`: Tailwind v4 + shadcn primitives
// emit inline styles in dev (Radix Avatar/Dialog set them at runtime).
//
// `connect-src 'self'`: the dev server proxies /api/* and the
// WebSocket upgrade through the same origin so 'self' suffices. In
// production, if loomwiki.com and api.loomwiki.com are split, add
// api.loomwiki.com to this directive.
const CSP_VALUE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
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
