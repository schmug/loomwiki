// SPDX-License-Identifier: Apache-2.0

import type { ExportedHandler } from "@cloudflare/workers-types";
import { ErrorCodes, apiErr } from "@loomwiki/shared";
import { Hono } from "hono";
import type { Env } from "./env.js";
import { type AuthEnv, authMiddleware } from "./middleware/auth.js";
import { registerErrorHandler } from "./middleware/error.js";
import { debugRoute } from "./routes/_debug.js";
import { adminCronRoute } from "./routes/admin-cron.js";
import { healthRoute } from "./routes/health.js";
import { meRoute } from "./routes/me.js";
import { roomsRoute } from "./routes/rooms.js";
import { wikiRoute } from "./routes/wiki.js";
import { workspacesRoute } from "./routes/workspaces.js";
import { scheduled } from "./scheduled.js";

export { ChatRoom } from "./do/ChatRoom.js";

const app = new Hono<AuthEnv>();

// Open routes (no auth required).
app.route("/api/health", healthRoute);
app.route("/api/_debug", debugRoute);

// Authenticated routes.
app.use("/api/me/*", authMiddleware);
app.use("/api/me", authMiddleware);
app.use("/api/workspaces/*", authMiddleware);
app.use("/api/rooms/*", authMiddleware);
app.use("/api/wiki/*", authMiddleware);
app.use("/api/wiki-tree", authMiddleware);
app.use("/api/_admin/wiki/*", authMiddleware);
app.use("/api/_admin/cron/*", authMiddleware);

app.route("/api/me", meRoute);
app.route("/api/workspaces", workspacesRoute);
app.route("/api/rooms", roomsRoute);
// Wiki routes share a Hono router so the /wiki-tree, /wiki/*, and
// /_admin/wiki/* paths can be defined in one place. Mounting at the
// root means the route handlers can use the absolute paths above.
app.route("/api", wikiRoute);
// Admin-cron routes (M5: chat-log archival backfill) — workspace-owner
// only, enforced inside the route handler. Mounted at /api so the
// route handler defines the absolute path.
app.route("/api", adminCronRoute);

app.notFound((c) =>
  c.json(apiErr(ErrorCodes.NOT_FOUND, `No route for ${c.req.method} ${c.req.path}`), 404),
);

registerErrorHandler(app);

const handler: ExportedHandler<Env> = {
  fetch: app.fetch.bind(app),
  scheduled,
};

export default handler;
