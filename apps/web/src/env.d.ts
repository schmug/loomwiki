/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

// Type augmentation for `Astro.locals.runtime` injected by
// `@astrojs/cloudflare`. The adapter populates this at request time
// with the Pages worker's runtime context (env bindings, cf, ctx).
//
// We only declare the bindings we actually read from SSR — the API
// service binding (Pages → loomwiki-api worker, see
// apps/web/wrangler.jsonc). Other bindings live on the API worker,
// not on the Pages side, so they're intentionally absent here.
declare namespace App {
  interface Locals {
    runtime?: {
      env: {
        API?: { fetch: (request: Request) => Promise<Response> };
      };
      cf?: unknown;
      ctx: { waitUntil: (p: Promise<unknown>) => void };
    };
  }
}
