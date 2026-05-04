// SPDX-License-Identifier: Apache-2.0

// Web app vitest config. Uses node environment because the client lib
// avoids browser globals beyond the constructor it accepts as a parameter
// (see src/lib/ws.ts) — tests inject a fake WebSocket constructor.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
