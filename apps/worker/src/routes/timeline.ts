// SPDX-License-Identifier: Apache-2.0

// Unified timeline read API (issue #32 / the v0.1 follow-through to
// ADR-0007's deferred audit-log UI).
//
//   GET /api/timeline?since=&until=&sources=&user=&namespace=&limit=&cursor=
//
// Owner-only (reuses the requireOwner pattern from admin-audit.ts).
// Returns a single chronological feed that server-side-unions four data
// origins:
//
//   - `audit_log`        — admin/proposal actions (ADR-0007).
//   - `ingest_runs`      — agent run status timeline.
//   - `scheduled_actions`— user-defined cron/once prompts (issue #33).
//                          NOTE: issue #32's body calls this
//                          `scheduled_prompts`; that name is stale —
//                          #33 shipped the table as `scheduled_actions`.
//   - `issue_threads`    — spec-kit Issue activity (#30, not yet built).
//
// The last two are read through a tolerant table-existence check: if a
// referenced table is absent (it hasn't shipped yet), that source
// contributes zero rows rather than 500ing the whole feed.
//
// Pagination: a single UUIDv7 cursor (the `id` of the last entry of the
// previous page). Each source query selects rows with `id < cursor`,
// ordered `created_at DESC, id DESC`; results are merged in code by
// `(at DESC, id DESC)` and sliced to `limit`. The cross-table
// `id < cursor` comparison is sound because UUIDv7 is time-prefix
// sortable — the same simplification admin-audit.ts already makes
// within one table, extended across the union. Clock skew between
// sources sharing a sub-second window is a pragmatic, documented
// trade-off (no gaps/duplicates at the per-source level; at most a
// re-order within a shared second across sources).
//
// Caveat specific to `scheduled` rows: their render time `at` derives
// from `next_fire_at` (a *future* instant for not-yet-fired schedules)
// or `last_fired_at`, while the cursor is still the row `id` (creation
// time). So a scheduled row can sort high in the feed (far-future
// fire) yet carry a low (old) cursor id. The failure mode is purely
// pagination ordering for scheduled rows that straddle a page boundary
// — never wrong/duplicated data. Acceptable for v0.0.1; a follow-up
// can switch to a composite (at,id) cursor if it bites in practice.
//
// Dedupe note: a `manual_ingest.trigger` audit row and the
// `ingest_runs` row it spawned are intentionally *both* surfaced. They
// are distinct events at distinct times — the human's trigger action
// (audited) vs. the run's lifecycle/outcome. An audit-faithful
// timeline keeps both; collapsing them would lose the "who pressed the
// button, when" forensic signal ADR-0007 exists to preserve.

import {
  AuditResourceKindSchema,
  type IngestRunStatus,
  type ScheduledActionStatus,
  type TimelineEntry,
  type TimelineFilterPill,
  TimelineFilterPillSchema,
  Uuidv7Schema,
} from "@loomwiki/schema";
import {
  parseAuditLogRow,
  parseIngestRunRow,
  parseScheduledActionRow,
} from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AuthEnv } from "../middleware/auth.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200; // Q-tl-4: mirror the audit log (50 / 200).

function requireOwner(c: {
  var: { user: { id: string }; workspace: { owner_id: string } };
}): void {
  if (c.var.workspace.owner_id !== c.var.user.id) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Workspace admin only", { status: 403 });
  }
}

// Audit `resource_kind` → which UI filter pill the row surfaces under.
// `proposal` + `agentsmd` are vault-content edits → the `wiki` pill.
// `ingest` audit rows ride alongside the ingest_runs feed → `ingest`.
// `byok` / `workspace_settings` are admin-only actions that belong to
// no current pill — they stay visible in the unfiltered feed but match
// no pill (so the source filter never hides them silently *and* never
// mislabels them).
//
// TODO(Q-tl-2): there is no `chat`-source producer today (audit_log has
// no chat resource_kind, and per-message streaming is out of scope for
// v0.0.1). The `chat` pill renders an empty state until a producer
// lands. `chat`/`wiki` are derived from audit_log per Q-tl-2's default.
function pillForResourceKind(kind: string): TimelineFilterPill | null {
  switch (kind) {
    case "proposal":
    case "agentsmd":
      return "wiki";
    case "ingest":
      return "ingest";
    default:
      // byok, workspace_settings — no pill.
      return null;
  }
}

/**
 * Returns the subset of `names` that exist as tables in the current
 * D1 database. Used so the union query can skip not-yet-shipped tables
 * (`issue_threads`, and defensively `scheduled_actions`) instead of
 * throwing "no such table".
 */
async function existingTables(env: Env, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const placeholders = names.map(() => "?").join(", ");
  const rs = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
  )
    .bind(...names)
    .all<{ name: string }>();
  return new Set((rs.results ?? []).map((r) => r.name));
}

interface ParsedQuery {
  cursor: string | null;
  since: number | null;
  until: number | null;
  limit: number;
  pills: Set<TimelineFilterPill> | null; // null = all sources
  user: string | null;
  namespace: string | null;
}

function parseQuery(c: { req: { query: (k: string) => string | undefined } }): ParsedQuery {
  const cursorRaw = c.req.query("cursor");
  let cursor: string | null = null;
  if (cursorRaw !== undefined && cursorRaw.length > 0) {
    const parsed = Uuidv7Schema.safeParse(cursorRaw);
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "cursor must be a UUIDv7", {
        status: 400,
      });
    }
    cursor = parsed.data;
  }

  const parseEpoch = (key: string): number | null => {
    const raw = c.req.query(key);
    if (raw === undefined || raw.length === 0) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new LoomwikiError(
        ErrorCodes.VALIDATION_FAILED,
        `${key} must be a non-negative unix-seconds integer`,
        { status: 400 },
      );
    }
    return n;
  };
  const since = parseEpoch("since");
  const until = parseEpoch("until");

  const limitRaw = c.req.query("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "limit must be a positive integer", {
        status: 400,
      });
    }
    limit = Math.min(n, MAX_LIMIT);
  }

  const sourcesRaw = c.req.query("sources");
  let pills: Set<TimelineFilterPill> | null = null;
  if (sourcesRaw !== undefined && sourcesRaw.length > 0) {
    pills = new Set();
    for (const token of sourcesRaw.split(",")) {
      const t = token.trim();
      if (t.length === 0) continue;
      const parsed = TimelineFilterPillSchema.safeParse(t);
      if (!parsed.success) {
        throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, `Unknown source filter: ${t}`, {
          status: 400,
        });
      }
      pills.add(parsed.data);
    }
    if (pills.size === 0) pills = null;
  }

  const userRaw = c.req.query("user");
  let user: string | null = null;
  if (userRaw !== undefined && userRaw.length > 0) {
    const parsed = Uuidv7Schema.safeParse(userRaw);
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "user must be a UUIDv7", {
        status: 400,
      });
    }
    user = parsed.data;
  }

  const namespaceRaw = c.req.query("namespace");
  const namespace = namespaceRaw !== undefined && namespaceRaw.length > 0 ? namespaceRaw : null;

  return { cursor, since, until, limit, pills, user, namespace };
}

// Whether the union should consult a given origin given the active
// pill filter. `audit` backs both `wiki` and `chat` pills (chat is
// empty today — TODO(Q-tl-2)) plus the ingest-audit rows.
function wantsSource(pills: Set<TimelineFilterPill> | null, pill: TimelineFilterPill): boolean {
  return pills === null || pills.has(pill);
}

/**
 * Compare two entries for the merged ordering: newest first, ties
 * broken by descending id (UUIDv7 → stable, monotonic-on-time).
 */
function cmpDesc(a: TimelineEntry, b: TimelineEntry): number {
  if (a.at !== b.at) return b.at - a.at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export const timelineRoute = new Hono<AuthEnv>().get("/timeline", async (c) => {
  requireOwner(c);
  const q = parseQuery(c);
  const wsId = c.var.workspace.id;

  // A namespace filter scopes to wiki/ingest/scheduled rows tied to a
  // room slug. Resolve it to a room id once; if it matches nothing the
  // feed is simply empty for room-bound sources.
  // TODO(Q-tl-2): namespace currently maps to a room slug only; wiki
  // path namespaces land when a chat producer exists.
  let namespaceRoomId: string | null = null;
  if (q.namespace !== null) {
    const room = await c.env.DB.prepare("SELECT id FROM rooms WHERE workspace_id = ? AND slug = ?")
      .bind(wsId, q.namespace)
      .first<{ id: string }>();
    namespaceRoomId = room?.id ?? null;
    if (namespaceRoomId === null) {
      // Namespace names a room that doesn't exist — nothing room-bound
      // can match. audit rows aren't room-scoped so we still let those
      // through unfiltered; but a namespace filter is room-intent, so
      // an unresolvable namespace yields an empty page deterministically.
      return c.json(apiOk({ entries: [], next_cursor: null }));
    }
  }

  // Oversample each source at `limit` so the merged top-`limit` is
  // correct regardless of how rows interleave across sources.
  const collected: TimelineEntry[] = [];

  const cursorClause = q.cursor !== null ? " AND id < ?" : "";
  const sinceClause = (col: string) => (q.since !== null ? ` AND ${col} >= ?` : "");
  const untilClause = (col: string) => (q.until !== null ? ` AND ${col} <= ?` : "");

  // ---- audit_log (backs `wiki` + `chat` + ingest-audit rows) ----
  // Pull when any of those pills is active. Filter to pill-bearing rows
  // matching the requested pills (and always include no-pill admin rows
  // when the feed is unfiltered).
  const auditWanted =
    wantsSource(q.pills, "wiki") || wantsSource(q.pills, "chat") || wantsSource(q.pills, "ingest");
  if (auditWanted) {
    const params: unknown[] = [wsId];
    let sql = `SELECT id, workspace_id, actor_user_id, action, resource_kind, resource_id,
              before_json, after_json, request_id, created_at
         FROM audit_log
        WHERE workspace_id = ?`;
    if (q.cursor !== null) {
      sql += cursorClause;
      params.push(q.cursor);
    }
    if (q.since !== null) {
      sql += sinceClause("created_at");
      params.push(q.since);
    }
    if (q.until !== null) {
      sql += untilClause("created_at");
      params.push(q.until);
    }
    if (q.user !== null) {
      sql += " AND actor_user_id = ?";
      params.push(q.user);
    }
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
    params.push(q.limit);
    const rs = await c.env.DB.prepare(sql)
      .bind(...params)
      .all();
    for (const raw of rs.results ?? []) {
      const row = parseAuditLogRow(raw);
      const kindParsed = AuditResourceKindSchema.safeParse(row.resource_kind);
      const pill = kindParsed.success ? pillForResourceKind(kindParsed.data) : null;
      // When a pill filter is active, only emit rows whose derived
      // pill is in the active set. No-pill admin rows are emitted only
      // in the unfiltered feed (matching "stays visible, matches no
      // pill"). namespace filtering does not apply to audit rows.
      if (q.pills !== null) {
        if (pill === null || !q.pills.has(pill)) continue;
      }
      collected.push({
        source: "audit",
        id: row.id,
        at: row.created_at,
        action: row.action,
        resource_kind: row.resource_kind,
        resource_id: row.resource_id,
        actor_user_id: row.actor_user_id,
        pill,
        created_at: row.created_at,
      });
    }
  }

  // ---- ingest_runs (`ingest` pill) ----
  // Q-tl-5: render at the status-change time — finished_at when the run
  // is terminal, else started_at. We order/cursor on `id` (UUIDv7,
  // time-sortable) for stable pagination, and expose both timestamps in
  // the payload so the island can label "started"/"finished".
  if (wantsSource(q.pills, "ingest")) {
    const params: unknown[] = [wsId];
    let sql = `SELECT ir.id AS id, ir.room_id AS room_id, ir.triggered_by AS triggered_by,
              ir.started_at AS started_at, ir.finished_at AS finished_at,
              ir.last_message_id AS last_message_id, ir.status AS status,
              ir.summary AS summary, ir.error AS error
         FROM ingest_runs ir
         JOIN rooms r ON r.id = ir.room_id
        WHERE r.workspace_id = ?`;
    if (q.cursor !== null) {
      sql += " AND ir.id < ?";
      params.push(q.cursor);
    }
    if (namespaceRoomId !== null) {
      sql += " AND ir.room_id = ?";
      params.push(namespaceRoomId);
    }
    // `since`/`until` apply to the render time. started_at is always
    // populated and ≤ finished_at, so range-filter on started_at; the
    // exact render-time is recomputed below.
    if (q.since !== null) {
      sql += " AND ir.started_at >= ?";
      params.push(q.since);
    }
    if (q.until !== null) {
      sql += " AND ir.started_at <= ?";
      params.push(q.until);
    }
    if (q.user !== null) {
      sql += " AND ir.triggered_by = ?";
      params.push(q.user);
    }
    sql += " ORDER BY ir.started_at DESC, ir.id DESC LIMIT ?";
    params.push(q.limit);
    const rs = await c.env.DB.prepare(sql)
      .bind(...params)
      .all();
    for (const raw of rs.results ?? []) {
      const row = parseIngestRunRow(raw);
      const terminal: IngestRunStatus[] = ["succeeded", "failed"];
      const at =
        row.finished_at !== null && terminal.includes(row.status)
          ? row.finished_at
          : row.started_at;
      collected.push({
        source: "ingest",
        id: row.id,
        at,
        room_id: row.room_id,
        status: row.status,
        triggered_by: row.triggered_by,
        summary: row.summary,
        error: row.error,
        started_at: row.started_at,
        finished_at: row.finished_at,
      });
    }
  }

  // ---- scheduled_actions + issue_threads (tolerant) ----
  const optional = await existingTables(c.env, ["scheduled_actions", "issue_threads"]);

  // scheduled_actions (`scheduled` pill). Render at last_fired_at when
  // it has fired, else next_fire_at (the upcoming fire). Q-tl-5-style.
  if (wantsSource(q.pills, "scheduled") && optional.has("scheduled_actions")) {
    const params: unknown[] = [wsId];
    let sql = `SELECT id, workspace_id, room_id, created_by, kind, cron_expr, fire_at,
              prompt, status, failure_count, last_fired_at, next_fire_at,
              created_at, updated_at
         FROM scheduled_actions
        WHERE workspace_id = ?`;
    if (q.cursor !== null) {
      sql += " AND id < ?";
      params.push(q.cursor);
    }
    if (namespaceRoomId !== null) {
      sql += " AND room_id = ?";
      params.push(namespaceRoomId);
    }
    if (q.user !== null) {
      sql += " AND created_by = ?";
      params.push(q.user);
    }
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
    params.push(q.limit);
    const rs = await c.env.DB.prepare(sql)
      .bind(...params)
      .all();
    for (const raw of rs.results ?? []) {
      const row = parseScheduledActionRow(raw);
      const at = row.last_fired_at ?? row.next_fire_at;
      if (q.since !== null && at < q.since) continue;
      if (q.until !== null && at > q.until) continue;
      const status: ScheduledActionStatus = row.status;
      collected.push({
        source: "scheduled",
        id: row.id,
        at,
        room_id: row.room_id,
        kind: row.kind,
        status,
        prompt_preview: row.prompt.slice(0, 280),
        next_fire_at: row.next_fire_at,
        last_fired_at: row.last_fired_at,
        created_at: row.created_at,
      });
    }
  }

  // issue_threads (#30) — table not built yet. Forward-declared shape;
  // when #30 ships the table this block lights up with zero timeline
  // code changes. Until then `optional` won't include it and we skip.
  if (wantsSource(q.pills, "issue") && optional.has("issue_threads")) {
    // TODO(#30): map issue_threads rows → IssueTimelineEntry once the
    // table's exact columns are committed. Intentionally a no-op until
    // then — the tolerant existence check above guarantees we never
    // 500 on the absent table, and the empty `issue` filter renders
    // the "lands with #30" empty state client-side.
  }

  // Merge → newest first → slice to limit. next_cursor is set whenever
  // the page is full (== limit) — the same conservative contract
  // admin-audit.ts uses: a full page *might* have more, so hand back a
  // cursor; the caller's next request returns rows strictly older than
  // the last id and pagination terminates because each page strictly
  // advances the (monotonic) cursor. A final partial page yields null.
  collected.sort(cmpDesc);
  const page = collected.slice(0, q.limit);
  const nextCursor = page.length === q.limit ? (page[page.length - 1]?.id ?? null) : null;

  return c.json(apiOk({ entries: page, next_cursor: nextCursor }));
});
