// SPDX-License-Identifier: Apache-2.0

import type { ExportedHandler } from "@cloudflare/workers-types";
import { ErrorCodes, apiErr } from "@loomwiki/shared";
import { Hono } from "hono";
import type { Env } from "./env.js";
import { requestContextMiddleware } from "./lib/request-context.js";
import { sentryMiddleware } from "./lib/sentry.js";
import { type AuthEnv, authMiddleware } from "./middleware/auth.js";
import { registerErrorHandler } from "./middleware/error.js";
import { debugRoute } from "./routes/_debug.js";
import { adminAuditRoute } from "./routes/admin-audit.js";
import { adminCronRoute } from "./routes/admin-cron.js";
import { adminSearchRoute } from "./routes/admin-search.js";
import { askRoute } from "./routes/ask.js";
import { digestRoute } from "./routes/digest.js";
import { healthRoute } from "./routes/health.js";
import { ingestRoute } from "./routes/ingest.js";
import { meRoute } from "./routes/me.js";
import { proposalsRoute } from "./routes/proposals.js";
import { roomsRoute } from "./routes/rooms.js";
import { runsRoute } from "./routes/runs.js";
import { searchRoute } from "./routes/search.js";
import { agentsMdSettingsRoute } from "./routes/settings/agentsmd.js";
import { byokSettingsRoute } from "./routes/settings/byok.js";
import { workspaceSettingsRoute } from "./routes/settings/workspace.js";
import { wikiRoute } from "./routes/wiki.js";
import { workspacesRoute } from "./routes/workspaces.js";
import { scheduled } from "./scheduled.js";

export { ChatRoom } from "./do/ChatRoom.js";

const app = new Hono<AuthEnv>();

// M8 global middleware: stamp every request with a UUIDv7 correlation
// id and install the Sentry onError shim. Both run before auth so they
// see open routes too (request_id makes the smoke script's
// X-Request-Id round-trip work for /api/health; sentry captures
// unhandled errors from anywhere in the pipeline).
app.use("*", requestContextMiddleware);
app.use("*", sentryMiddleware());

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
// M6: search + RAG ask + reindex admin. The cost guard runs inside
// each route, but the auth middleware is the gate that ensures we
// have a workspace + user to charge.
app.use("/api/search", authMiddleware);
app.use("/api/ask", authMiddleware);
app.use("/api/_admin/search/*", authMiddleware);
// M7: ingest + runs + proposals + digest admin.
app.use("/api/proposals", authMiddleware);
app.use("/api/proposals/*", authMiddleware);
app.use("/api/runs/*", authMiddleware);
app.use("/api/_admin/digest/*", authMiddleware);
// M8: settings (BYOK, AGENTS.md, workspace) + audit log read.
app.use("/api/settings/*", authMiddleware);
app.use("/api/_admin/audit", authMiddleware);

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
// M6 search/ask/reindex routes. Mounted at /api so each route file
// declares the absolute path (mirrors the wiki + admin-cron pattern).
app.route("/api", searchRoute);
app.route("/api", askRoute);
app.route("/api", adminSearchRoute);
// M7: ingest + runs + proposals + digest routes. Same /api mount
// pattern; each route file declares its own absolute paths.
app.route("/api", ingestRoute);
app.route("/api", runsRoute);
app.route("/api", proposalsRoute);
app.route("/api", digestRoute);
// M8: settings (BYOK, AGENTS.md, workspace) + audit-log read API.
app.route("/api/settings/byok", byokSettingsRoute);
app.route("/api/settings/agentsmd", agentsMdSettingsRoute);
app.route("/api/settings/workspace", workspaceSettingsRoute);
app.route("/api", adminAuditRoute);

app.notFound((c) =>
  c.json(apiErr(ErrorCodes.NOT_FOUND, `No route for ${c.req.method} ${c.req.path}`), 404),
);

registerErrorHandler(app);

const handler: ExportedHandler<Env> = {
  fetch: app.fetch.bind(app),
  scheduled,
};

export default handler;
