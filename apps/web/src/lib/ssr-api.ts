// SPDX-License-Identifier: Apache-2.0

// SSR-side fetch helpers for Astro pages. Two transport paths:
//
//   1. Service binding (preferred in production). On Cloudflare Pages,
//      a same-host fetch from SSR back to `loomwiki.cortech.online/api/*`
//      gets short-circuited to the Pages runtime — Worker routes on
//      the same hostname are NOT consulted, so the API worker never
//      sees the request and Pages returns 404. The documented fix is
//      a Pages → Worker service binding (declared in
//      `apps/web/wrangler.jsonc` as
//      `services: [{ binding: "API", service: "loomwiki-api" }]`).
//      When the binding is present, `env.API.fetch(...)` bypasses
//      DNS/edge entirely and lands directly in the worker.
//
//   2. Plain fetch (dev fallback). The Astro dev server (4321) proxies
//      `/api/*` to the worker on 8788 via Vite's HTTP proxy, so a
//      relative-resolving fetch against the request origin works.
//      Same shape used as a fallback in any prod environment without
//      the service binding configured.
//
// Callers pass `Astro.locals.runtime?.env` so the helper can pick the
// right path. Dev pages can omit it; only the production deploy has a
// runtime with bindings.

import type { ApiResult } from "@loomwiki/shared";

/**
 * Shape of the relevant subset of `Astro.locals.runtime.env` in
 * production. Only the `API` service binding matters here; bindings
 * we don't reference (D1, KV, etc.) are owned by the API worker, not
 * the Pages worker.
 */
export interface SsrRuntimeEnv {
  API?: { fetch: (request: Request) => Promise<Response> };
}

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
export async function ssrApiGet<T>(
  request: Request,
  path: string,
  env?: SsrRuntimeEnv,
): Promise<T> {
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

  // Build the absolute URL. Service-binding fetches still require a
  // valid URL even though routing skips DNS — the worker reads
  // `request.url` and Hono routes off the path.
  const origin = new URL(request.url).origin;
  const fetchUrl = `${origin}${path}`;
  const fetchRequest = new Request(fetchUrl, { method: "GET", headers });

  // Service binding short-circuit. When Pages declares the API binding,
  // the call goes worker-to-worker without traversing the public edge —
  // bypasses the same-host loopback gotcha that returns 404 from Pages
  // for `/api/*` paths.
  const res = env?.API ? await env.API.fetch(fetchRequest) : await fetch(fetchRequest);

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
