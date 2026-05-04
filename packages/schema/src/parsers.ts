// SPDX-License-Identifier: Apache-2.0

// Typed row parsers for D1 result rows. A failed parse means the DB returned
// a shape we don't expect — that's a 500 with code `DB_PARSE_ERROR`, not a
// 4xx, because the client did nothing wrong.
//
// Routes call these on every read so schema drift surfaces loudly instead of
// causing silent bad data downstream.

import { ErrorCodes, LoomwikiError } from "@loomwiki/shared";
import type { infer as ZodInfer, ZodTypeAny } from "zod";
import {
  MessageRowSchema,
  RoomMemberRowSchema,
  RoomRowSchema,
  UserRowSchema,
  type WikiPageFrontmatter,
  WikiPageFrontmatterSchema,
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

/**
 * Parse a Zod-validated wiki frontmatter object. Caller hands in an
 * already-decoded YAML object (gray-matter handles YAML → JS); this
 * function validates the shape against the strict Zod schema and
 * raises a typed LoomwikiError on failure so the route layer can map
 * to a 400 with `code: VALIDATION_FAILED`.
 */
export function parseWikiFrontmatter(value: unknown): WikiPageFrontmatter {
  const result = WikiPageFrontmatterSchema.safeParse(value);
  if (!result.success) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid wiki page frontmatter", {
      status: 400,
      details: result.error.issues,
    });
  }
  return result.data;
}

export type {
  Message,
  Proposal,
  Room,
  RoomMember,
  RoomMemberRole,
  User,
  WikiPageFrontmatter,
  WikiPageKind,
  WikiPageSource,
  WikiPageStatus,
  WikiPageWriteRequest,
  Workspace,
} from "./index.js";
