// SPDX-License-Identifier: Apache-2.0

// Local-dev escape hatch. The Astro dev server runs at
// http://localhost:4321 and proxies /api/* to the worker at 8788. The
// worker's authMiddleware accepts X-Local-Dev-Email when its triple-gate
// passes (see apps/worker/src/middleware/auth.ts) — running locally,
// `ALLOW_LOCAL_DEV_AUTH=true` in .dev.vars, request from 127.0.0.1.
//
// This module returns the header to attach. Production builds ship with
// PUBLIC_LOOMWIKI_DEV_EMAIL unset, so the function returns {}.

const PUBLIC_DEV_EMAIL = import.meta.env.PUBLIC_LOOMWIKI_DEV_EMAIL as string | undefined;

export function devHeaders(): Record<string, string> {
  if (typeof PUBLIC_DEV_EMAIL === "string" && PUBLIC_DEV_EMAIL.length > 0) {
    return { "X-Local-Dev-Email": PUBLIC_DEV_EMAIL };
  }
  return {};
}

export function devEmailIfSet(): string | null {
  if (typeof PUBLIC_DEV_EMAIL === "string" && PUBLIC_DEV_EMAIL.length > 0) {
    return PUBLIC_DEV_EMAIL;
  }
  return null;
}
