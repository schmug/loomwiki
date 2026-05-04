// SPDX-License-Identifier: Apache-2.0

import { parseRoomRow } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import { serializeRoom } from "../lib/serialize.js";
import type { AuthEnv } from "../middleware/auth.js";

export const roomsRoute = new Hono<AuthEnv>().get("/:rid", async (c) => {
  const rid = c.req.param("rid");

  const row = await c.env.DB.prepare("SELECT * FROM rooms WHERE id = ?").bind(rid).first();
  if (!row) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Room not found", { status: 404 });
  }
  const room = parseRoomRow(row);

  // Cross-workspace defense in depth: even if a user knows a room ID outside
  // their workspace, they get a 404 (not a 403, which would confirm existence).
  if (room.workspace_id !== c.var.workspace.id) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Room not found", { status: 404 });
  }

  const member = await c.env.DB.prepare(
    "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1",
  )
    .bind(rid, c.var.user.id)
    .first();
  if (!member) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Not a member of this room", { status: 403 });
  }

  return c.json(apiOk({ room: serializeRoom(room) }));
});
