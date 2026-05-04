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
        wrangler: { configPath: "../../wrangler.jsonc" },
        // Run tests fully offline. Without this the AI binding (which only
        // has a remote implementation) forces wrangler into remote mode and
        // CI fails with "You must be logged in to use wrangler dev in remote
        // mode."
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
