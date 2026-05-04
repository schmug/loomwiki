// SPDX-License-Identifier: Apache-2.0

// Write-through mirror from ChatRoom DO SQLite → D1 `messages` table.
//
// Idempotent on `id` so the same row can be re-mirrored after a transient
// failure without producing a duplicate or overwriting an authoritative
// edit. The DO is the source of truth for the live state; D1 is the
// queryable store consulted by the historical-scrollback route, ingest
// agent, and (in M5) the daily-log cron.

import type { Env } from "../env.js";

export interface MirrorMessage {
  id: string;
  roomId: string;
  userId: string;
  body: string;
  parentId: string | null;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
}

/**
 * Insert-or-update. We `INSERT … ON CONFLICT(id) DO UPDATE` because edits
 * and deletes also flow through here — the write-through path is symmetric
 * for create / edit / delete.
 *
 * Throws on D1 error so the caller can flip `pending_mirror=1` and retry.
 */
export async function mirrorMessageToD1(env: Env, msg: MirrorMessage): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages
       (id, room_id, user_id, body, parent_id, created_at, edited_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       body       = excluded.body,
       edited_at  = excluded.edited_at,
       deleted_at = excluded.deleted_at`,
  )
    .bind(
      msg.id,
      msg.roomId,
      msg.userId,
      msg.body,
      msg.parentId,
      msg.createdAt,
      msg.editedAt,
      msg.deletedAt,
    )
    .run();
}
