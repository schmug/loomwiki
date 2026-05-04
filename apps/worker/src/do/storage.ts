// SPDX-License-Identifier: Apache-2.0

// DO SQLite schema and helpers for ChatRoom (SPEC §9).
//
// `messages_local` is the room's hot path; D1 `messages` is the queryable
// mirror written through-but-asynchronously. The two diverge only briefly
// when D1 is having a bad minute — `pending_mirror=1` rows reconcile on the
// next message or via the alarm in ChatRoom.ts.
//
// `parent_id` is declared for schema parity with D1 / SPEC §7.1, but
// threading is not exposed on the WS surface in M2 (SPEC §17 — out of scope).
//
// All `sql.exec(...)` calls below use the Cloudflare DO SqlStorage API
// (parameterized statements, NOT a shell). The string-template lookalike
// is unrelated to OS-level command execution.

import type { WireMessage } from "@loomwiki/shared";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages_local (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    body            TEXT NOT NULL,
    parent_id       TEXT,
    created_at      INTEGER NOT NULL,
    edited_at       INTEGER,
    deleted_at      INTEGER,
    pending_mirror  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_messages_local_created
    ON messages_local(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_local_pending
    ON messages_local(pending_mirror) WHERE pending_mirror = 1;
  CREATE TABLE IF NOT EXISTS room_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// Must satisfy `Record<string, SqlStorageValue>` so it can flow through
// `sql.exec<LocalRow>(...)`. SqlStorageValue covers `string | number |
// ArrayBuffer | Uint8Array | null`, which subsumes every column we project.
type LocalRow = {
  id: string;
  user_id: string;
  body: string;
  parent_id: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  pending_mirror: number;
} & Record<string, SqlStorageValue>;

/** Idempotent — call from the DO constructor on every wake. */
export function initStorage(sql: SqlStorage): void {
  sql.exec(SCHEMA);
}

/** Persist roomId so the alarm path can recover it without an open socket. */
export function setRoomId(sql: SqlStorage, roomId: string): void {
  sql.exec(
    "INSERT INTO room_meta (key, value) VALUES ('room_id', ?) ON CONFLICT(key) DO NOTHING",
    roomId,
  );
}

export function getRoomId(sql: SqlStorage): string | null {
  const cursor = sql.exec<{ value: string }>("SELECT value FROM room_meta WHERE key = 'room_id'");
  for (const row of cursor) return row.value;
  return null;
}

function rowToWire(row: LocalRow, roomId: string): WireMessage {
  return {
    id: row.id,
    room_id: roomId,
    user_id: row.user_id,
    body: row.deleted_at !== null ? "" : row.body,
    parent_id: row.parent_id,
    created_at: row.created_at,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at,
  };
}

export interface AppendArgs {
  id: string;
  userId: string;
  body: string;
  parentId: string | null;
  createdAt: number;
  pendingMirror: boolean;
}

export function appendMessage(sql: SqlStorage, args: AppendArgs): void {
  sql.exec(
    `INSERT INTO messages_local
       (id, user_id, body, parent_id, created_at, pending_mirror)
     VALUES (?, ?, ?, ?, ?, ?)`,
    args.id,
    args.userId,
    args.body,
    args.parentId,
    args.createdAt,
    args.pendingMirror ? 1 : 0,
  );
}

export function getMessageById(
  sql: SqlStorage,
  roomId: string,
  messageId: string,
): WireMessage | null {
  const cursor = sql.exec<LocalRow>("SELECT * FROM messages_local WHERE id = ?", messageId);
  for (const row of cursor) return rowToWire(row, roomId);
  return null;
}

/**
 * Most-recent N messages, oldest first. Used when a fresh client (no
 * `sinceMessageId`) connects — the welcome shows the recent backlog.
 */
export function getRecent(sql: SqlStorage, roomId: string, limit: number): WireMessage[] {
  const cursor = sql.exec<LocalRow>("SELECT * FROM messages_local ORDER BY id DESC LIMIT ?", limit);
  const rows: WireMessage[] = [];
  for (const row of cursor) rows.push(rowToWire(row, roomId));
  rows.reverse();
  return rows;
}

/**
 * Messages strictly after `sinceMessageId`. UUIDv7's lexicographic-time-order
 * makes the cursor work without consulting `created_at`.
 */
export function getRecentSince(
  sql: SqlStorage,
  roomId: string,
  sinceMessageId: string,
  limit: number,
): WireMessage[] {
  const cursor = sql.exec<LocalRow>(
    "SELECT * FROM messages_local WHERE id > ? ORDER BY id ASC LIMIT ?",
    sinceMessageId,
    limit,
  );
  const rows: WireMessage[] = [];
  for (const row of cursor) rows.push(rowToWire(row, roomId));
  return rows;
}

export function applyEdit(
  sql: SqlStorage,
  messageId: string,
  newBody: string,
  editedAt: number,
): void {
  sql.exec(
    "UPDATE messages_local SET body = ?, edited_at = ?, pending_mirror = 1 WHERE id = ?",
    newBody,
    editedAt,
    messageId,
  );
}

export function applyDelete(sql: SqlStorage, messageId: string, deletedAt: number): void {
  sql.exec(
    "UPDATE messages_local SET deleted_at = ?, pending_mirror = 1 WHERE id = ?",
    deletedAt,
    messageId,
  );
}

export function markPendingMirror(sql: SqlStorage, messageId: string): void {
  sql.exec("UPDATE messages_local SET pending_mirror = 1 WHERE id = ?", messageId);
}

export function clearPendingMirror(sql: SqlStorage, messageId: string): void {
  sql.exec("UPDATE messages_local SET pending_mirror = 0 WHERE id = ?", messageId);
}

export interface PendingRow {
  id: string;
  user_id: string;
  body: string;
  parent_id: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export function getPendingMirrorRows(sql: SqlStorage, limit: number): PendingRow[] {
  const cursor = sql.exec<LocalRow>(
    "SELECT * FROM messages_local WHERE pending_mirror = 1 ORDER BY id ASC LIMIT ?",
    limit,
  );
  const rows: PendingRow[] = [];
  for (const row of cursor) {
    rows.push({
      id: row.id,
      user_id: row.user_id,
      body: row.body,
      parent_id: row.parent_id,
      created_at: row.created_at,
      edited_at: row.edited_at,
      deleted_at: row.deleted_at,
    });
  }
  return rows;
}

export function hasPendingMirror(sql: SqlStorage): boolean {
  const cursor = sql.exec<{ c: number }>(
    "SELECT COUNT(*) AS c FROM messages_local WHERE pending_mirror = 1",
  );
  for (const row of cursor) return row.c > 0;
  return false;
}
