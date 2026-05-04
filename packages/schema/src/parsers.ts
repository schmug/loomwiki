// SPDX-License-Identifier: Apache-2.0

// Typed row parsers for D1 result rows. A failed parse means the DB returned
// a shape we don't expect — that's a 500 with code `DB_PARSE_ERROR`, not a
// 4xx, because the client did nothing wrong.
//
// Routes call these on every read so schema drift surfaces loudly instead of
// causing silent bad data downstream.

import { LoomwikiError } from "@loomwiki/shared";
import type { infer as ZodInfer, ZodTypeAny } from "zod";
import {
  MessageRowSchema,
  RoomMemberRowSchema,
  RoomRowSchema,
  UserRowSchema,
  WorkspaceRowSchema,
} from "./index.js";

function parseRow<S extends ZodTypeAny>(schema: S, row: unknown, table: string): ZodInfer<S> {
  const result = schema.safeParse(row);
  if (!result.success) {
    throw new LoomwikiError("DB_PARSE_ERROR", `Failed to parse ${table} row`, {
      status: 500,
      details: result.error.issues,
    });
  }
  return result.data;
}

export const parseUserRow = (row: unknown) => parseRow(UserRowSchema, row, "users");
export const parseWorkspaceRow = (row: unknown) => parseRow(WorkspaceRowSchema, row, "workspaces");
export const parseRoomRow = (row: unknown) => parseRow(RoomRowSchema, row, "rooms");
export const parseRoomMemberRow = (row: unknown) =>
  parseRow(RoomMemberRowSchema, row, "room_members");
export const parseMessageRow = (row: unknown) => parseRow(MessageRowSchema, row, "messages");

export type {
  Message,
  Room,
  RoomMember,
  RoomMemberRole,
  User,
  Workspace,
} from "./index.js";
