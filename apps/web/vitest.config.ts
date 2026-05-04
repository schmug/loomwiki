// SPDX-License-Identifier: Apache-2.0

// Web app vitest config. happy-dom env for everything — React component
// tests need a DOM, and the existing `ws.test.ts` already injects a
// fake WebSocket constructor so it doesn't depend on globalThis.WebSocket
// (which happy-dom omits). Single env keeps the matrix simple.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    globals: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
