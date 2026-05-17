// SPDX-License-Identifier: Apache-2.0

import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// In dev, the Astro dev server (4321) proxies /api/* to the Hono worker
// (8788) so the browser sees a single origin and Cloudflare Access cookies
// behave as they will in production. In prod, deploy topology is
// documented in DEPLOY.md (the Astro build can either share a worker with
// the API or live on a separate origin behind Access).
const WORKER_DEV_URL = "http://127.0.0.1:8788";

export default defineConfig({
  output: "server",
  adapter: cloudflare({
    // @astrojs/cloudflare v13 removed `platformProxy`: `astro dev` /
    // `astro preview` now run on the real workerd runtime via the
    // Cloudflare Vite plugin. `configPath` points the adapter at this
    // app's Workers config so bindings (the `API` service binding)
    // resolve in dev exactly as in production. Remote-only bindings
    // (AI / Artifacts / AI Search) live on the API worker, not here,
    // so the web config stays binding-light.
    configPath: "./wrangler.jsonc",
  }),
  integrations: [react()],
  server: { port: 4321 },
  vite: {
    plugins: [tailwindcss()],
    server: {
      proxy: {
        "/api": {
          target: WORKER_DEV_URL,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    resolve: {
      // Astro uses Vite, which respects this for both the dev server and
      // the SSR build. Path alias mirrors tsconfig.json compilerOptions.paths.
      alias: {
        "@": new URL("./src", import.meta.url).pathname,
      },
    },
  },
});
