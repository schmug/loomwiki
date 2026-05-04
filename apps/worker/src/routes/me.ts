// SPDX-License-Identifier: Apache-2.0

import { parseRoomRow } from "@loomwiki/schema/parsers";
import { apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import { serializeRoom, serializeUser, serializeWorkspace } from "../lib/serialize.js";
import type { AuthEnv } from "../middleware/auth.js";

export const meRoute = new Hono<AuthEnv>().get("/", async (c) => {
  const user = c.var.user;
  const workspace = c.var.workspace;

  const result = await c.env.DB.prepare(
    `SELECT r.* FROM rooms r
     INNER JOIN room_members m ON m.room_id = r.id
     WHERE m.user_id = ? AND r.workspace_id = ?
     ORDER BY r.created_at DESC`,
  )
    .bind(user.id, workspace.id)
    .all();

  const rooms = result.results.map(parseRoomRow).map(serializeRoom);

  return c.json(
    apiOk({
      user: serializeUser(user),
      workspace: serializeWorkspace(workspace),
      rooms,
    }),
  );
});
