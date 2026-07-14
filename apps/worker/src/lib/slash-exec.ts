// SPDX-License-Identifier: Apache-2.0

// Slash-command execution against D1 (v0.1 M9). Called from the ChatRoom DO
// after `parseSlashCommand` (packages/shared) has produced a typed command.
// This module owns token → row resolution (assignee, /done title match) and
// the INSERT/UPDATE statements; the DO owns persistence of the originating
// chat message and broadcasting the confirmation.
//
// Timed /event input is interpreted as UTC (documented in the confirmation
// text). The web UI creates local-time events; chat needs a deterministic
// zone without a tz database — revisit if it bites (candidate for SPEC §20).

import type { D1Database } from "@cloudflare/workers-types";
import { type SlashCommand, id } from "@loomwiki/shared";

export interface SlashContext {
  db: D1Database;
  workspaceId: string;
  roomId: string;
  userId: string;
  /** Message id of the chat message that carried the command. */
  originMessageId: string;
  nowS: number;
}

export type SlashExecResult = { ok: true; note: string } | { ok: false; error: string };

interface MemberRow {
  id: string;
  display_name: string;
  email: string;
}

async function resolveAssignee(
  db: D1Database,
  roomId: string,
  token: string,
): Promise<MemberRow | { error: string }> {
  const rows = await db
    .prepare(
      `SELECT u.id, u.display_name, u.email
       FROM users u JOIN room_members rm ON rm.user_id = u.id
       WHERE rm.room_id = ?`,
    )
    .bind(roomId)
    .all<MemberRow>();
  const lower = token.toLowerCase();
  const matches = rows.results.filter((r) => {
    const local = (r.email.split("@")[0] ?? "").toLowerCase();
    return local === lower || r.display_name.toLowerCase() === lower;
  });
  const first = matches[0];
  if (matches.length === 1 && first) return first;
  if (matches.length === 0) return { error: `no room member matching @${token}` };
  return { error: `@${token} is ambiguous (${matches.length} members match)` };
}

export async function execSlashCommand(
  ctx: SlashContext,
  cmd: SlashCommand,
): Promise<SlashExecResult> {
  if (cmd.kind === "task") {
    let assignee: MemberRow | null = null;
    if (cmd.assigneeToken !== null) {
      const resolved = await resolveAssignee(ctx.db, ctx.roomId, cmd.assigneeToken);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      assignee = resolved;
    }
    const dueAt =
      cmd.dueDate !== null ? Math.floor(Date.parse(`${cmd.dueDate}T00:00:00Z`) / 1000) : null;
    await ctx.db
      .prepare(
        `INSERT INTO tasks
           (id, workspace_id, room_id, title, body, status, assignee_id, due_at,
            origin_message_id, created_by, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, NULL, 'todo', ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        id(),
        ctx.workspaceId,
        ctx.roomId,
        cmd.title,
        assignee?.id ?? null,
        dueAt,
        ctx.originMessageId,
        ctx.userId,
        ctx.nowS,
        ctx.nowS,
      )
      .run();
    const parts = [`✅ created task "${cmd.title}"`];
    if (assignee) parts.push(`→ ${assignee.display_name}`);
    if (cmd.dueDate !== null) parts.push(`due ${cmd.dueDate}`);
    return { ok: true, note: parts.join(" ") };
  }

  if (cmd.kind === "event") {
    const allDay = cmd.time === null;
    const startsAt = allDay
      ? Math.floor(Date.parse(`${cmd.date}T00:00:00Z`) / 1000)
      : Math.floor(Date.parse(`${cmd.date}T${cmd.time}:00Z`) / 1000);
    const endsAt = cmd.durationMinutes !== null ? startsAt + cmd.durationMinutes * 60 : null;
    await ctx.db
      .prepare(
        `INSERT INTO events
           (id, workspace_id, room_id, title, body, starts_at, ends_at, all_day, rrule,
            origin_message_id, created_by, created_at, updated_at, cancelled_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        id(),
        ctx.workspaceId,
        ctx.roomId,
        cmd.title,
        startsAt,
        endsAt,
        allDay ? 1 : 0,
        ctx.originMessageId,
        ctx.userId,
        ctx.nowS,
        ctx.nowS,
      )
      .run();
    const when = allDay ? `on ${cmd.date}` : `at ${cmd.date} ${cmd.time} UTC`;
    const dur = cmd.durationMinutes !== null ? ` (${cmd.durationMinutes}m)` : "";
    return { ok: true, note: `📅 created event "${cmd.title}" ${when}${dur}` };
  }

  // cmd.kind === "done"
  const rows = await ctx.db
    .prepare(
      `SELECT id, title FROM tasks
       WHERE room_id = ? AND status NOT IN ('done','cancelled') AND lower(title) = lower(?)`,
    )
    .bind(ctx.roomId, cmd.title)
    .all<{ id: string; title: string }>();
  const match = rows.results[0];
  if (rows.results.length === 0 || !match) {
    return { ok: false, error: `no open task in this room titled "${cmd.title}"` };
  }
  if (rows.results.length > 1) {
    return {
      ok: false,
      error: `${rows.results.length} open tasks titled "${cmd.title}" — rename one or use the board`,
    };
  }
  await ctx.db
    .prepare("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?")
    .bind(ctx.nowS, ctx.nowS, match.id)
    .run();
  return { ok: true, note: `✅ marked "${match.title}" done` };
}
