// SPDX-License-Identifier: Apache-2.0

import { apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import type { Env } from "../env.js";

export const VERSION = "0.0.1";

export const healthRoute = new Hono<{ Bindings: Env }>().get("/", (c) => {
  // Prefer the user-defined tag (set via `wrangler deploy --tag $SHA` in CI)
  // which carries the git SHA. Fall back to the deployment UUID (.id), then
  // to the GIT_COMMIT env var (set in GitHub Actions CI), then "dev".
  const meta = c.env.CF_VERSION_METADATA;
  const commit = (meta?.tag || meta?.id) ?? c.env.GIT_COMMIT ?? "dev";
  return c.json(
    apiOk({
      status: "ok" as const,
      version: VERSION,
      commit,
    }),
  );
});
