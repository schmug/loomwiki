// SPDX-License-Identifier: Apache-2.0

// Tells `cloudflare:test` (and the `cloudflare:workers` env binding) that
// `Cloudflare.Env` matches our typed Env. Without this, `env` from
// `cloudflare:test` is loosely typed and tests can't access bindings without
// casting.

import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as WorkerEnv } from "./env.js";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      // Test-only binding: list of D1 migrations injected via vitest.config.ts
      // (see vitest.config.ts → miniflare.bindings.TEST_MIGRATIONS).
      TEST_MIGRATIONS?: D1Migration[];
    }
  }
}
