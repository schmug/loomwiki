// SPDX-License-Identifier: Apache-2.0

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../../wrangler.jsonc" },
      // Run tests fully offline. Without this the AI binding (which only has a
      // remote implementation) forces wrangler into remote mode and CI fails
      // with "You must be logged in to use wrangler dev in remote mode."
      remoteBindings: false,
    }),
  ],
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
