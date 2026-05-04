// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrationsPath = path.resolve(__dirname, "../../packages/schema/d1-migrations");

export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        // Point at wrangler.dev.jsonc so the remote-only bindings
        // (Artifacts, AI Search) are absent rather than "declared but
        // unreachable". Tests that need fakes for those bindings inject
        // them via env-override (see __fixtures__/fake-artifacts.ts and
        // __fixtures__/fake-ai-search.ts). Mirrors the M5 precedent.
        wrangler: { configPath: "../../wrangler.dev.jsonc" },
        // Defense-in-depth: even pointing at wrangler.dev.jsonc, force
        // remote bindings off so a future binding addition can't quietly
        // re-introduce remote mode.
        remoteBindings: false,
        miniflare: {
          // Expose the migration array as a binding so tests can call
          // applyD1Migrations(env.DB, env.TEST_MIGRATIONS) in beforeAll.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["src/**/__tests__/**/*.test.ts"],
    },
  };
});
