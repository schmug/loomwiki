// SPDX-License-Identifier: Apache-2.0

import { apiErr } from "@loomwiki/shared";
import { Hono } from "hono";
import type { Env } from "./env.js";
import { healthRoute } from "./routes/health.js";

export { ChatRoom } from "./do/ChatRoom.js";

const app = new Hono<{ Bindings: Env }>();

app.route("/api/health", healthRoute);

app.notFound((c) => c.json(apiErr("not_found", `No route for ${c.req.method} ${c.req.path}`), 404));

app.onError((err, c) => {
  console.error("worker error", err);
  return c.json(apiErr("internal_error", "Internal server error"), 500);
});

export default app;
