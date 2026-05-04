// SPDX-License-Identifier: Apache-2.0

// Zod schemas + inferred types for the D1 row shapes declared in
// d1-migrations/0001_init.sql. Routes parse rows through these schemas to
// catch any DB drift loudly (DB_PARSE_ERROR → 500) rather than letting bad
// data trickle into API responses.
//
// Times are stored as unix epoch seconds. Conversion to ISO-8601 happens at
// the route layer (CLAUDE.md "Times: store as unix epoch seconds (integer)").

import { z } from "zod";

// UUIDv7 — sortable. Helper in @loomwiki/shared/id.
export const Uuidv7Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "must be a UUIDv7",
  );

const EpochSeconds = z.number().int().nonnegative();

// Email validation tracks the JWT `email` claim. Length cap matches RFC 5321.
const EmailSchema = z.string().email().max(320);

// Slug: kebab-case, lowercase, ASCII only, ≤ 60 chars (mirrors vault-template
// AGENTS.md slug rules). M1 prompt resolves this default explicitly.
export const SlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,59}$/, "slug must be kebab-case lowercase ASCII");

// ---------- D1 row schemas ----------

export const UserRowSchema = z.object({
  id: Uuidv7Schema,
  email: EmailSchema,
  display_name: z.string().min(1).max(120),
  avatar_url: z.string().url().nullable(),
  created_at: EpochSeconds,
});
export type User = z.infer<typeof UserRowSchema>;

export const WorkspaceRowSchema = z.object({
  id: Uuidv7Schema,
  name: z.string().min(1).max(120),
  owner_id: Uuidv7Schema,
  vault_repo: z.string().min(1),
  ai_search_id: z.string().nullable(),
  created_at: EpochSeconds,
});
export type Workspace = z.infer<typeof WorkspaceRowSchema>;

export const RoomRowSchema = z.object({
  id: Uuidv7Schema,
  workspace_id: Uuidv7Schema,
  slug: SlugSchema,
  name: z.string().min(1).max(120),
  topic: z.string().nullable(),
  created_by: Uuidv7Schema,
  created_at: EpochSeconds,
});
export type Room = z.infer<typeof RoomRowSchema>;

export const RoomMemberRoleSchema = z.enum(["admin", "member", "viewer"]);
export type RoomMemberRole = z.infer<typeof RoomMemberRoleSchema>;

export const RoomMemberRowSchema = z.object({
  room_id: Uuidv7Schema,
  user_id: Uuidv7Schema,
  role: RoomMemberRoleSchema,
  joined_at: EpochSeconds,
});
export type RoomMember = z.infer<typeof RoomMemberRowSchema>;

export const MessageRowSchema = z.object({
  id: Uuidv7Schema,
  room_id: Uuidv7Schema,
  user_id: Uuidv7Schema,
  body: z.string().max(4096),
  parent_id: Uuidv7Schema.nullable(),
  created_at: EpochSeconds,
  edited_at: EpochSeconds.nullable(),
  deleted_at: EpochSeconds.nullable(),
});
export type Message = z.infer<typeof MessageRowSchema>;

// ---------- Request body schemas ----------

export const CreateRoomRequestSchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1).max(120),
  topic: z.string().max(2000).optional(),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;
