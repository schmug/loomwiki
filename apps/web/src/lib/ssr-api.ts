// SPDX-License-Identifier: Apache-2.0

// SSR-side fetch helpers for Astro pages. The Astro dev server proxies
// /api/* to the worker (8788), but proxy URLs are relative — when SSR
// runs on the dev server, fetch resolves against the request origin,
// which works in Astro because it injects a request-scoped fetch.
//
// Returns the typed payload directly on success, or throws an
// SsrAuthRequiredError on 401 so the caller can redirect to Access. We
// don't import the browser-side api.ts here because it reads
// `document` (login URL meta) which doesn't exist in SSR.

import type { ApiResult } from "@loomwiki/shared";

export class SsrAuthRequiredError extends Error {
  constructor() {
    super("auth required");
    this.name = "SsrAuthRequiredError";
  }
}

export class SsrApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SsrApiError";
    this.status = status;
  }
}

/**
 * SSR fetch. Forwards the incoming request's cookie + dev-email header
 * so Cloudflare Access (or the local-dev bypass) gates this hop the
 * same way the browser would.
 */
export async function ssrApiGet<T>(request: Request, path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const cookie = request.headers.get("Cookie");
  if (cookie) headers.Cookie = cookie;

  // Local-dev: the browser-side fetch adds X-Local-Dev-Email from
  // PUBLIC_LOOMWIKI_DEV_EMAIL, but SSR's first hop has no browser to
  // do that — so we mirror the same env on the SSR side too. The
  // worker still triple-gates (NODE_ENV != prod, ALLOW_LOCAL_DEV_AUTH,
  // localhost CF-Connecting-IP) so this is a no-op in production.
  const passthrough = request.headers.get("X-Local-Dev-Email");
  if (passthrough) {
    headers["X-Local-Dev-Email"] = passthrough;
  } else {
    const ssrDevEmail = import.meta.env.PUBLIC_LOOMWIKI_DEV_EMAIL as string | undefined;
    if (typeof ssrDevEmail === "string" && ssrDevEmail.length > 0) {
      headers["X-Local-Dev-Email"] = ssrDevEmail;
    }
  }
  // Astro's request URL is the page URL; its Vite proxy rewrites /api/*
  // to the worker. Use the same origin so the proxy fires.
  const origin = new URL(request.url).origin;
  const res = await fetch(`${origin}${path}`, {
    method: "GET",
    headers,
  });

  if (res.status === 401) throw new SsrAuthRequiredError();

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SsrApiError(`Non-JSON response (status ${res.status})`, res.status);
  }
  const result = body as ApiResult<T>;
  if (result && typeof result === "object" && "ok" in result) {
    if (result.ok) return result.data;
    throw new SsrApiError(result.error.message, res.status);
  }
  throw new SsrApiError(`Malformed API response (status ${res.status})`, res.status);
}
