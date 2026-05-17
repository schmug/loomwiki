/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

// @astrojs/cloudflare v13 ships its own `App.Locals` augmentation
// (`{ cfContext: ExecutionContext }`) and removed the old
// `Astro.locals.runtime` object. Cloudflare bindings are now read via
// the module-scoped `import { env } from "cloudflare:workers"` instead.
//
// Neither astro nor the adapter ships ambient types for the virtual
// `cloudflare:workers` module that `astro check` (tsc) can see, and
// `@cloudflare/workers-types` is an API-worker dependency that isn't
// resolvable from this package. So we declare the single thing we use:
// the module-scoped `env` value. In a full Workers project
// `wrangler types` would generate a richer `Cloudflare.Env`; we only
// read the `API` service binding from SSR, so we type just that. Other
// bindings live on the API worker, not the web side.
declare module "cloudflare:workers" {
  export const env: {
    API?: { fetch: (request: Request) => Promise<Response> };
  };
}
