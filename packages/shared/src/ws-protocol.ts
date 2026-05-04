// SPDX-License-Identifier: Apache-2.0

// WebSocket protocol envelopes for the ChatRoom DO (SPEC §9).
//
// This is the contract between `apps/worker/src/do/ChatRoom.ts` and
// `apps/web/src/lib/ws.ts`. It is committed alone, before either side is
// implemented, so both authors build against the same shape and drift can't
// open up across files.
//
// Wire format conventions:
//   - All timestamps are unix epoch seconds (integer). SPEC §9 specifies this
//     for the WS surface; `apps/worker/src/lib/serialize.ts` (REST) uses ISO
//     strings for users/workspaces/rooms but messages stay numeric end-to-end
//     because that's what §9 mandates and the WS hot path benefits from
//     skipping the conversion.
//   - `kind` is a discriminator. Parse with `ClientMsgSchema.safeParse` /
//     `ServerMsgSchema.safeParse` and switch on `kind`.
//   - The `hello` envelope intentionally has no `userId` field — auth happens
//     before the upgrade and the userId lives in `ws.serializeAttachment(...)`.
//     Including it on the wire would invite a forge-the-userId attack, so we
//     drop it from the schema entirely (deviation from SPEC §9 in service of
//     the M2 resolved-decision "Auth happens before the upgrade … do NOT
//     re-validate per message").
//   - `protocolVersion: 1` is included on `hello` and `welcome` so future
//     protocol changes can switch on it without a hard break.

import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// Message body cap matches SPEC §9 (also enforced by MessageRowSchema in
// @loomwiki/schema). Duplicated here so the WS layer can reject before any
// DB round-trip.
export const MAX_BODY_CHARS = 4096;

// UUIDv7 regex shared with `@loomwiki/schema`. Defined locally to keep
// `@loomwiki/shared` free of a dep on `@loomwiki/schema` (which already
// depends on us — circular otherwise).
const UuidV7 = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "must be a UUIDv7",
  );

const EpochSeconds = z.number().int().nonnegative();

/**
 * The on-wire message shape. Mirrors the D1 `messages` row, with `created_at`
 * and friends as epoch seconds (NOT ISO-8601). Tombstoned messages have
 * `body: ""` and a non-null `deleted_at`; clients render "[deleted]".
 */
export const WireMessageSchema = z.object({
  id: UuidV7,
  room_id: UuidV7,
  user_id: UuidV7,
  body: z.string().max(MAX_BODY_CHARS),
  parent_id: UuidV7.nullable(),
  created_at: EpochSeconds,
  edited_at: EpochSeconds.nullable(),
  deleted_at: EpochSeconds.nullable(),
});
export type WireMessage = z.infer<typeof WireMessageSchema>;

// ---------- Client → Server ----------

const ClientHello = z.object({
  kind: z.literal("hello"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  /** Resume cursor. If omitted, server returns the most-recent N messages. */
  sinceMessageId: UuidV7.optional(),
});

const ClientSend = z.object({
  kind: z.literal("send"),
  /** Client-generated dedup token, echoed back in `ack` for optimistic UI. */
  tempId: z.string().min(1).max(64),
  // Body length is enforced server-side in the DO so the rejection envelope
  // can echo `tempId`; schema-level bound here is just min(1) to keep
  // parsing robust against clients that send slightly oversized payloads.
  body: z.string().min(1),
  parentId: UuidV7.optional(),
});

const ClientEdit = z.object({
  kind: z.literal("edit"),
  messageId: UuidV7,
  body: z.string().min(1),
});

const ClientDelete = z.object({
  kind: z.literal("delete"),
  messageId: UuidV7,
});

const ClientPing = z.object({
  kind: z.literal("ping"),
});

export const ClientMsgSchema = z.discriminatedUnion("kind", [
  ClientHello,
  ClientSend,
  ClientEdit,
  ClientDelete,
  ClientPing,
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;

// ---------- Server → Client ----------

const ServerWelcome = z.object({
  kind: z.literal("welcome"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  roomId: UuidV7,
  /** Messages the client has not yet seen. Capped at 200 to bound payload. */
  recentMessages: z.array(WireMessageSchema),
  /**
   * True if the resume cursor (`hello.sinceMessageId`) was set and there
   * were strictly more than 200 missed messages — the welcome carries the
   * oldest 200 and the client must fetch the gap via the REST scrollback
   * route (`GET /api/rooms/:rid/messages?before=…`). Without this signal,
   * a long-disconnected client would silently lose messages 201+.
   */
  hasMore: z.boolean(),
});

const ServerMessage = z.object({
  kind: z.literal("message"),
  message: WireMessageSchema,
});

const ServerAck = z.object({
  kind: z.literal("ack"),
  tempId: z.string(),
  messageId: UuidV7,
});

const ServerEdited = z.object({
  kind: z.literal("edited"),
  messageId: UuidV7,
  body: z.string(),
  editedAt: EpochSeconds,
});

const ServerDeleted = z.object({
  kind: z.literal("deleted"),
  messageId: UuidV7,
  deletedAt: EpochSeconds,
});

const ServerError = z.object({
  kind: z.literal("error"),
  /** ErrorCodes constant (uppercase wire format). */
  code: z.string(),
  message: z.string(),
  /**
   * Echoed when the offending client envelope carried a tempId, so the
   * client can mark the optimistic UI entry as failed without ambiguity.
   */
  tempId: z.string().optional(),
});

const ServerPong = z.object({
  kind: z.literal("pong"),
});

export const ServerMsgSchema = z.discriminatedUnion("kind", [
  ServerWelcome,
  ServerMessage,
  ServerAck,
  ServerEdited,
  ServerDeleted,
  ServerError,
  ServerPong,
]);
export type ServerMsg = z.infer<typeof ServerMsgSchema>;
