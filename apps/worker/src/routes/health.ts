// SPDX-License-Identifier: Apache-2.0

import { apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import type { Env } from "../env.js";

export const VERSION = "0.0.1";

export const healthRoute = new Hono<{ Bindings: Env }>().get("/", (c) => {
  const commit = c.env.CF_VERSION_METADATA?.id ?? c.env.GIT_COMMIT ?? "dev";
  return c.json(
    apiOk({
      status: "ok" as const,
      version: VERSION,
      commit,
    }),
  );
});
