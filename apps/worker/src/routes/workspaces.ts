// SPDX-License-Identifier: Apache-2.0

import { CreateRoomRequestSchema } from "@loomwiki/schema";
import { parseRoomRow } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, apiOk, id } from "@loomwiki/shared";
import { Hono } from "hono";
import { serializeRoom, serializeWorkspace } from "../lib/serialize.js";
import type { AuthEnv } from "../middleware/auth.js";

function assertWorkspaceMatch(workspaceId: string, paramId: string): void {
  // v0.0.1 is single-tenant — any wid that isn't the bootstrapped workspace
  // is a 404 from this user's perspective.
  if (workspaceId !== paramId) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Workspace not found", { status: 404 });
  }
}

export const workspacesRoute = new Hono<AuthEnv>()
  .get("/:wid", (c) => {
    const wid = c.req.param("wid");
    assertWorkspaceMatch(c.var.workspace.id, wid);
    return c.json(apiOk({ workspace: serializeWorkspace(c.var.workspace) }));
  })
  .get("/:wid/rooms", async (c) => {
    const wid = c.req.param("wid");
    assertWorkspaceMatch(c.var.workspace.id, wid);

    const result = await c.env.DB.prepare(
      `SELECT r.* FROM rooms r
       INNER JOIN room_members m ON m.room_id = r.id
       WHERE m.user_id = ? AND r.workspace_id = ?
       ORDER BY r.created_at DESC`,
    )
      .bind(c.var.user.id, wid)
      .all();

    const rooms = result.results.map(parseRoomRow).map(serializeRoom);
    return c.json(apiOk({ rooms }));
  })
  .post("/:wid/rooms", async (c) => {
    const wid = c.req.param("wid");
    assertWorkspaceMatch(c.var.workspace.id, wid);

    const body = await c.req.json().catch(() => null);
    const parsed = CreateRoomRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid room request body", {
        status: 400,
        details: parsed.error.issues,
      });
    }

    const roomId = id();
    try {
      await c.env.DB.prepare(
        "INSERT INTO rooms (id, workspace_id, slug, name, topic, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(
          roomId,
          wid,
          parsed.data.slug,
          parsed.data.name,
          parsed.data.topic ?? null,
          c.var.user.id,
        )
        .run();
    } catch (cause) {
      if (cause instanceof Error && /UNIQUE/i.test(cause.message)) {
        throw new LoomwikiError(ErrorCodes.CONFLICT, "Room slug already exists in this workspace", {
          status: 409,
          cause,
        });
      }
      throw cause;
    }

    // Auto-add creator as admin (M1 prompt's resolved decision).
    await c.env.DB.prepare(
      "INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, 'admin')",
    )
      .bind(roomId, c.var.user.id)
      .run();

    const row = await c.env.DB.prepare("SELECT * FROM rooms WHERE id = ?").bind(roomId).first();
    if (!row) {
      throw new LoomwikiError(ErrorCodes.INTERNAL_ERROR, "Room creation failed", {
        status: 500,
      });
    }
    return c.json(apiOk({ room: serializeRoom(parseRoomRow(row)) }), 201);
  });
