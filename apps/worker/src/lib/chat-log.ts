// SPDX-License-Identifier: Apache-2.0

// Daily chat-log archival (M5). Aggregates the previous day's messages
// per room from D1 and writes one markdown file per room to the vault
// at `/rooms/{slug}/log/{YYYY-MM-DD}.md`.
//
// Why this lives here and not in routes/: the same orchestration is
// invoked from two places — the cron `scheduled()` handler (autopilot)
// and the admin route POST /api/_admin/cron/archive-day (operator
// backfill / verification). Keeping the logic in `lib/` lets both call
// sites share the same code path.
//
// Idempotency model: path-based, not bookkeeping-based. There is no
// `archive_runs` table. A re-run for the same date overwrites the file
// with the same content (UUIDv7 IDs sort stably + deterministic
// formatter ⇒ byte-identical output for unchanged input).
//
// Frontmatter contract (read by the M7 ingest agent on every run):
//   room:            <slug>
//   date:            YYYY-MM-DD
//   message_count:   integer
//   ingest_run_ids:  []      ← M7 appends and re-writes the file
//
// Per-room failure isolation: one room's archival error does NOT block
// the rest. Errors are logged to console and surfaced in the result.

import type { Env } from "../env.js";
import { KvWikiBackend, type WikiBackend, isWriteFilePathAllowed } from "./wiki-backend.js";

// --------------------------------------------------------------------
// Types
// --------------------------------------------------------------------

/** A message row as we read it from D1 for archival. */
export interface ArchivableMessage {
  id: string;
  room_id: string;
  user_id: string;
  body: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export interface ArchiveError {
  room_id: string;
  room_slug?: string;
  message: string;
}

export interface ArchiveDaySummary {
  date: string;
  files_written: number;
  rooms_processed: number;
  errors: ArchiveError[];
}

// --------------------------------------------------------------------
// Path helpers
// --------------------------------------------------------------------

// Slug rules mirror SlugSchema in @loomwiki/schema (kebab-case ASCII,
// 1..60 chars). Date is YYYY-MM-DD with no calendar validation here —
// the caller produces dates from `Date#toISOString` so the shape is
// guaranteed.
const CHAT_LOG_PATH_REGEX = /^\/rooms\/[a-z][a-z0-9-]{0,59}\/log\/\d{4}-\d{2}-\d{2}\.md$/;

export function validateChatLogPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 256) return false;
  if (path.includes("..") || path.includes("//")) return false;
  return CHAT_LOG_PATH_REGEX.test(path);
}

export function formatChatLogPath(roomSlug: string, dateUtc: string): string {
  return `/rooms/${roomSlug}/log/${dateUtc}.md`;
}

// --------------------------------------------------------------------
// Date helpers
// --------------------------------------------------------------------

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(s: string): boolean {
  if (typeof s !== "string" || !ISO_DATE_REGEX.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

/**
 * Compute the previous-UTC-day from a `scheduledTime` (epoch ms).
 *
 * "Previous day" is *always* the calendar day before the scheduled
 * time's UTC date — independent of *when* during that day the cron
 * fired. We do this by:
 *   1. Slicing the scheduled time's UTC date (today).
 *   2. Subtracting 1 ms from the start of today, which lands at
 *      23:59:59.999 of yesterday in UTC.
 *   3. Slicing that to YYYY-MM-DD.
 *
 * This is equivalent to subtracting 86_400_000 ms when scheduledTime
 * is exactly midnight UTC, but the start-of-today anchor makes the
 * function correct for any time-of-day input — the production cron
 * fires at 02:00 UTC, but the admin route accepts arbitrary dates so
 * we don't want this helper to silently misbehave for off-hour calls.
 * UTC has no DST, so this is also the simplest way to dodge any
 * localtime correctness traps.
 */
export function previousUtcDayFromScheduledTime(scheduledTimeMs: number): string {
  const today = new Date(scheduledTimeMs).toISOString().slice(0, 10);
  const yesterdayMs = Date.parse(`${today}T00:00:00Z`) - 1;
  return new Date(yesterdayMs).toISOString().slice(0, 10);
}

/**
 * Return the [start, end) epoch-second range that covers a given UTC date.
 * `end` is exclusive (next day's 00:00:00Z).
 */
export function dayBoundsUtc(dateUtc: string): { startSec: number; endSec: number } {
  if (!isValidIsoDate(dateUtc)) {
    throw new Error(`dayBoundsUtc: not a valid YYYY-MM-DD string: ${dateUtc}`);
  }
  const startMs = Date.parse(`${dateUtc}T00:00:00Z`);
  const endMs = startMs + 86_400_000;
  return { startSec: Math.floor(startMs / 1000), endSec: Math.floor(endMs / 1000) };
}

// --------------------------------------------------------------------
// Markdown formatting
// --------------------------------------------------------------------

const TOMBSTONE_BODY = "[deleted]";
const DELETED_USER_DISPLAY = "<deleted user>";

interface FormatChatLogContentArgs {
  roomSlug: string;
  dateUtc: string;
  messages: ArchivableMessage[];
  displayNamesById: ReadonlyMap<string, string>;
}

/**
 * Render the full markdown file (frontmatter + body) for one room/day.
 * Returns `null` for an empty message list — the caller skips the
 * write so empty days produce no file (per resolved decision). Throws
 * via `null` rather than via a thrown error so the no-work path is
 * cheap and explicit.
 */
export function formatChatLogContent(args: FormatChatLogContentArgs): string | null {
  if (args.messages.length === 0) return null;

  // Defensive sort. The D1 query already orders by created_at, id —
  // re-sorting here in the formatter means the function is correct
  // regardless of caller and keeps the output byte-stable.
  const sorted = [...args.messages].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const frontmatter = formatFrontmatter({
    roomSlug: args.roomSlug,
    dateUtc: args.dateUtc,
    messageCount: sorted.length,
  });

  const blocks: string[] = [];
  for (const m of sorted) {
    const time = formatTimeUtc(m.created_at);
    const name = args.displayNamesById.get(m.user_id) ?? DELETED_USER_DISPLAY;
    const body = m.deleted_at !== null ? TOMBSTONE_BODY : m.body;
    blocks.push(`## ${time} ${name}\n\n${body}`);
  }

  // Two newlines between blocks; one trailing newline at EOF (POSIX).
  return `${frontmatter}\n${blocks.join("\n\n")}\n`;
}

function formatFrontmatter(args: {
  roomSlug: string;
  dateUtc: string;
  messageCount: number;
}): string {
  // Hand-emitted YAML keeps the output byte-stable across runs and
  // sidesteps gray-matter's habit of round-tripping date scalars
  // through JS Date. The chat-log frontmatter shape is fixed and the
  // values are constrained (slug regex, ISO date regex, integer) so
  // no escape paths can fire.
  return [
    "---",
    `room: ${args.roomSlug}`,
    `date: ${args.dateUtc}`,
    `message_count: ${args.messageCount}`,
    "ingest_run_ids: []",
    "---",
    "",
  ].join("\n");
}

function formatTimeUtc(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mm = d.getUTCMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

// --------------------------------------------------------------------
// Orchestration
// --------------------------------------------------------------------

interface ArchiveDayArgs {
  env: Env;
  dateUtc: string;
  /** Optional injection point for tests. Defaults to KvWikiBackend(env.WIKI_KV). */
  backend?: WikiBackend;
}

/**
 * Aggregate messages for `dateUtc` from D1, group by room, and write
 * one log file per room. Returns a summary of what happened. Never
 * throws on a per-room failure — those land in `summary.errors`.
 *
 * Top-level errors (D1 unreachable, bad date) DO throw, since they
 * indicate the cron/admin call cannot make progress at all.
 */
export async function archiveDay(args: ArchiveDayArgs): Promise<ArchiveDaySummary> {
  if (!isValidIsoDate(args.dateUtc)) {
    throw new Error(`archiveDay: invalid date "${args.dateUtc}" — expected YYYY-MM-DD`);
  }
  const backend = args.backend ?? defaultBackendForArchive(args.env);
  const { startSec, endSec } = dayBoundsUtc(args.dateUtc);

  const messages = await fetchMessages(args.env, startSec, endSec);

  // Group by room_id, preserving the per-room insertion order (which
  // already matches created_at, id from the SQL ORDER BY).
  const byRoom = new Map<string, ArchivableMessage[]>();
  for (const m of messages) {
    let bucket = byRoom.get(m.room_id);
    if (!bucket) {
      bucket = [];
      byRoom.set(m.room_id, bucket);
    }
    bucket.push(m);
  }

  if (byRoom.size === 0) {
    return {
      date: args.dateUtc,
      files_written: 0,
      rooms_processed: 0,
      errors: [],
    };
  }

  const roomIds = [...byRoom.keys()];
  const userIds = uniqueUserIds(messages);

  const [roomSlugs, displayNames] = await Promise.all([
    fetchRoomSlugs(args.env, roomIds),
    fetchDisplayNames(args.env, userIds),
  ]);

  const errors: ArchiveError[] = [];
  let filesWritten = 0;

  for (const [roomId, roomMessages] of byRoom) {
    const slug = roomSlugs.get(roomId);
    if (!slug) {
      errors.push({
        room_id: roomId,
        message: "Room slug not found in D1; room may have been deleted between query and archive",
      });
      continue;
    }
    try {
      const wrote = await archiveRoomDay({
        backend,
        roomSlug: slug,
        dateUtc: args.dateUtc,
        messages: roomMessages,
        displayNamesById: displayNames,
      });
      if (wrote) filesWritten += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error({
        event: "archive_room_failed",
        room_id: roomId,
        room_slug: slug,
        date: args.dateUtc,
        error: message,
      });
      errors.push({ room_id: roomId, room_slug: slug, message });
    }
  }

  return {
    date: args.dateUtc,
    files_written: filesWritten,
    rooms_processed: byRoom.size,
    errors,
  };
}

interface ArchiveRoomDayArgs {
  backend: WikiBackend;
  roomSlug: string;
  dateUtc: string;
  messages: ArchivableMessage[];
  displayNamesById: ReadonlyMap<string, string>;
}

/**
 * Write a single room's log file for the given day. Returns `true` if
 * a file was written, `false` if the formatter produced no output
 * (zero messages — a defensive check; archiveDay only calls this when
 * the per-room bucket is non-empty).
 */
export async function archiveRoomDay(args: ArchiveRoomDayArgs): Promise<boolean> {
  const path = formatChatLogPath(args.roomSlug, args.dateUtc);
  if (!validateChatLogPath(path)) {
    throw new Error(`archiveRoomDay: produced invalid path: ${path}`);
  }
  // Backend has its own union allowlist; this assertion catches any
  // skew between the chat-log validator and the writeFile validator
  // before we reach the network.
  if (!isWriteFilePathAllowed(path)) {
    throw new Error(`archiveRoomDay: path rejected by backend allowlist: ${path}`);
  }
  const content = formatChatLogContent({
    roomSlug: args.roomSlug,
    dateUtc: args.dateUtc,
    messages: args.messages,
    displayNamesById: args.displayNamesById,
  });
  if (content === null) return false;
  await args.backend.writeFile(path, content);
  return true;
}

// --------------------------------------------------------------------
// D1 helpers
// --------------------------------------------------------------------

async function fetchMessages(
  env: Env,
  startSec: number,
  endSec: number,
): Promise<ArchivableMessage[]> {
  // idx_messages_room_created indexes (room_id, created_at). We range
  // over created_at across all rooms; the index still helps because
  // D1 (SQLite) can use a covering scan, and POC scale keeps this
  // well under any practical row budget.
  const rs = await env.DB.prepare(
    `SELECT id, room_id, user_id, body, created_at, edited_at, deleted_at
       FROM messages
      WHERE created_at >= ? AND created_at < ?
      ORDER BY created_at, id`,
  )
    .bind(startSec, endSec)
    .all();
  return (rs.results ?? []) as unknown as ArchivableMessage[];
}

function uniqueUserIds(messages: ArchivableMessage[]): string[] {
  const set = new Set<string>();
  for (const m of messages) set.add(m.user_id);
  return [...set];
}

async function fetchRoomSlugs(env: Env, roomIds: string[]): Promise<Map<string, string>> {
  if (roomIds.length === 0) return new Map();
  const placeholders = roomIds.map(() => "?").join(",");
  const rs = await env.DB.prepare(`SELECT id, slug FROM rooms WHERE id IN (${placeholders})`)
    .bind(...roomIds)
    .all();
  const out = new Map<string, string>();
  const rows = (rs.results ?? []) as unknown as { id: string; slug: string }[];
  for (const row of rows) out.set(row.id, row.slug);
  return out;
}

async function fetchDisplayNames(env: Env, userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const placeholders = userIds.map(() => "?").join(",");
  const rs = await env.DB.prepare(
    `SELECT id, display_name FROM users WHERE id IN (${placeholders})`,
  )
    .bind(...userIds)
    .all();
  const out = new Map<string, string>();
  const rows = (rs.results ?? []) as unknown as { id: string; display_name: string }[];
  for (const row of rows) out.set(row.id, row.display_name);
  return out;
}

function defaultBackendForArchive(env: Env): WikiBackend {
  return new KvWikiBackend(env.WIKI_KV);
}
