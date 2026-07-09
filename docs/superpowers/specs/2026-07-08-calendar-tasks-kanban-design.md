# Design: Tasks, Events, Kanban & Calendar (v0.1)

**Date:** 2026-07-08
**Status:** approved (brainstorming session with Cory)
**Milestones:** M9 (foundation), M10 (interop), M11 (agent extraction)

## 1. Problem & positioning

Loomwiki's POC deliberately excluded tasks and calendars (SPEC §1 non-goals).
This design reverses that — narrowly. Teams dogfooding loomwiki keep a second
tool open for "who's doing what by when"; that conversation already happens in
loomwiki rooms, so the work items and dates it produces should live here too,
feeding the same chat-is-input / git-backed-output loop.

**In scope:** lightweight native tasks, single-occurrence events, a kanban view,
a calendar view — interoperable with rooms and users, integrated with chat, and
snapshotted into the vault.

**Still out of scope:** sprints, OKRs, Gantt, story points, external calendar
sync (CalDAV/Google), recurrence, reminders/notifications.

**Relationship to issue #30 (spec-kit / GitHub Issues):** native D1 tasks are
the foundation; #30's GitHub-Issues sync is reframed as an optional later layer
on top, not the tracker itself. #30 stays open with a re-scoping comment.

**SPEC.md amendments required (part of M9):**

- §1 non-goals: replace the two exclusion lines with the narrowed exclusion
  above.
- §7/§8: add the new tables and API rows.
- §19: add M9–M11.
- §20: add new deferred questions (see §10 below).

## 2. Decisions log

| Decision | Choice | Alternatives rejected |
|---|---|---|
| Task source of truth | Native D1 tables | GitHub-Issues-backed (per #30); chat-derived-only |
| Calendar contents | Events + task due dates + (M11) agent-extracted dates | scheduled_actions overlay (deferred) |
| Kanban model | View over fixed status enum; no board entity | Per-room custom columns; free-standing boards |
| Room scoping | Nullable `room_id`, workspace-first views, room-filtered tabs | Room-required; many-to-many |
| User attachment | Single task assignee; event attendees join table | Multi-assignee; no attendees |
| Vault flow | Daily snapshot via existing 02:00 UTC cron | Per-edit commits; no vault presence; terminal-state-only |
| Chat integration | Slash commands + message↔task links + status broadcasts + agent extraction | — (all selected) |
| Recurrence | Deferred; `rrule` column reserved, always null in v1 | Presets; full RRULE |
| Data model | Two tables (`tasks`, `events`) | Unified `items` table; events-as-timed-tasks |
| Time handling | Epoch seconds UTC in D1; render browser-local | — (repo convention) |

## 3. Data model — migration `0006_tasks_events.sql`

Forward-only, appended to `packages/schema/d1-migrations/`. IDs are UUIDv7.
All times epoch seconds UTC.

```sql
CREATE TABLE tasks (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  room_id            TEXT REFERENCES rooms(id),          -- nullable: room-optional
  title              TEXT NOT NULL,
  body               TEXT,                               -- markdown
  status             TEXT NOT NULL DEFAULT 'todo'
                     CHECK (status IN ('backlog','todo','doing','done','cancelled')),
  assignee_id        TEXT REFERENCES users(id),          -- single assignee
  due_at             INTEGER,
  origin_message_id  TEXT REFERENCES messages(id),       -- chat provenance (used M10)
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at       INTEGER
);
CREATE INDEX idx_tasks_workspace_status ON tasks(workspace_id, status);
CREATE INDEX idx_tasks_room_status      ON tasks(room_id, status);
CREATE INDEX idx_tasks_assignee_status  ON tasks(assignee_id, status);
CREATE INDEX idx_tasks_due              ON tasks(due_at) WHERE due_at IS NOT NULL;

CREATE TABLE task_tags (
  task_id  TEXT NOT NULL REFERENCES tasks(id),
  tag      TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);
CREATE INDEX idx_task_tags_tag ON task_tags(tag);

CREATE TABLE events (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  room_id            TEXT REFERENCES rooms(id),
  title              TEXT NOT NULL,
  body               TEXT,
  starts_at          INTEGER NOT NULL,
  ends_at            INTEGER,                            -- null = point-in-time
  all_day            INTEGER NOT NULL DEFAULT 0,
  rrule              TEXT,                               -- RESERVED: always null in v1
  origin_message_id  TEXT REFERENCES messages(id),
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  cancelled_at       INTEGER
);
CREATE INDEX idx_events_workspace_start ON events(workspace_id, starts_at);
CREATE INDEX idx_events_room_start      ON events(room_id, starts_at);

CREATE TABLE event_attendees (
  event_id  TEXT NOT NULL REFERENCES events(id),
  user_id   TEXT NOT NULL REFERENCES users(id),
  added_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (event_id, user_id)
);
```

Kanban has **no schema**: it is `tasks` grouped by the fixed status enum
(`cancelled` hidden from the board). In-column sort is due date then created —
no manual ordering in v1 (deferred question). Zod schemas + `z.infer` types go
in `packages/schema` and are shared worker↔web, per convention.

## 4. API surface

All routes under `/api`, Access-JWT-gated, returning `ApiResult<T>`, errors via
`LoomwikiError` mapped at the route layer. Members create/edit; `viewer` role
is read-only (403 on writes).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tasks` | List; `?status=&room=&assignee=&tag=&due_before=&due_after=&cursor=&limit=` |
| POST | `/api/tasks` | Create |
| GET | `/api/tasks/:id` | Detail (incl. tags, origin message ref) |
| PATCH | `/api/tasks/:id` | Partial update — status (kanban drag), assignee, due, tags, body |
| DELETE | `/api/tasks/:id` | Delete |
| GET/POST | `/api/events` | List (`?from=&to=&room=`) / create |
| GET/PATCH/DELETE | `/api/events/:id` | Detail / update / delete |
| POST/DELETE | `/api/events/:id/attendees/:uid` | Add / remove attendee |
| GET | `/api/calendar` | `?from=&to=&room=&user=` — union of events + due-dated tasks |

`GET /api/calendar` returns a Zod discriminated union:
`CalendarEntry = { kind: 'event', ... } | { kind: 'task_due', ... }` — one
endpoint so the calendar UI never does client-side joins. Pagination follows
the existing UUIDv7-cursor pattern (see `timeline.ts`).

## 5. Views (`apps/web`, Astro)

- **`/tasks`** — kanban board. Drag-drop is a single interactive island; drag
  fires `PATCH status` with optimistic update + rollback on error. Filters:
  room, assignee (incl. "me"), tag. `cancelled` reachable via a filter, not a
  column.
- **`/calendar`** — month + week views over `GET /api/calendar`. Stored UTC,
  rendered browser-local.
- **`/r/[slug]`** — gains **Tasks** and **Calendar** tabs: same components,
  pre-filtered to the room (M10).
- **My views** — assignee/attendee = me filters on both (M10 polish).
- Live board sync over WS is **deferred**: v1 is fetch-on-load + optimistic
  updates, consistent with presence being deferred (Q18).

## 6. Chat integration

- **Slash commands (M9)** — parsed deterministically (no NLP) in the ChatRoom
  DO before persist/broadcast:
  - `/task <title> [@name] [due:YYYY-MM-DD]`
  - `/event <title> <YYYY-MM-DD[ HH:MM]> [duration]`
  - `/done <exact task title>` — matched case-insensitively against the
    room's non-done tasks; zero or multiple matches → system-message error
    listing candidates (no fuzzy matching in v1)
  The DO writes to D1 directly (it already mirrors messages) and posts a
  system-authored confirmation message. This introduces the system-message
  method issue #30 also needs — built here first, reused there later.
  Unparseable input gets a system-message error, not a silent drop.
- **Message↔task linking (M10)** — "create task from message" in the message
  menu; task stores `origin_message_id`; the message renders a task-chip
  backlink; task detail links back to the chat context.
- **Status broadcasts (M10)** — API-side changes to room-scoped tasks notify
  that room's DO, which posts a system message ("✅ *Fix login bug* → done, by
  cory"). System messages are visually distinct and recorded in the audit log
  (ADR-0007 pattern).

## 7. Vault flow (M10)

Extend the existing 02:00 UTC daily cron (chat-log commit): after logs, write

- **`/tasks/board.md`** — snapshot grouped by status with assignee/due/room,
- **`/calendar/YYYY-MM.md`** — the month's events + task deadlines,

both frontmattered (generated-at, counts) like the daily room logs. Git
history shows board state over time; `git clone` of the vault stays a complete
workspace export; zero per-edit commit churn.

## 8. Agent extraction (M11)

- New table (migration `0007_extraction_proposals.sql`):
  `extraction_proposals(id, run_id → ingest_runs, kind CHECK('task','event'),
  payload TEXT /* JSON, Zod-validated */, rationale, status
  CHECK('pending','merged','rejected','superseded'), created_at, reviewed_at,
  reviewed_by)`. Kept separate from the page-shaped `proposals` table rather
  than nulling half its columns.
- Ingest agent prompt gains extraction instructions: commitments ("I'll fix
  the login bug tomorrow" → task, assignee inferred from speaker) and dates
  ("demo on Friday" → event). Golden fixtures in
  `packages/agents-prompts/__fixtures__/` updated; structural invariants
  asserted, not exact text.
- Proposals surface in the **same inbox UI** as wiki proposals; merge creates
  the real task/event row (+ `origin_message_id` when attributable).
- ⚠️ **Gate:** this milestone must edit `vault-template/AGENTS.md`, a
  do-not-touch surface per CLAUDE.md. Explicit approval required at M11 start.

## 9. Milestones & testing

Per repo rules: every new route gets ≥1 integration test in
`apps/worker/src/routes/__tests__/`; every DO change gets a miniflare-backed
WS-protocol test; prompt changes update golden fixtures.

- **M9 — foundation (one session):** migration 0006, Zod schemas, tasks/
  events/calendar routes + tests, `/tasks` kanban + `/calendar` pages, slash
  commands in DO + tests, SPEC.md amendments (§1, §7, §8, §19, §20).
- **M10 — interop (one session):** message↔task linking, status broadcasts
  (DO system-message method + tests), room tabs + My-views, vault daily
  snapshot (cron test), #30 re-scoping comment.
- **M11 — agent extraction (one session):** migration 0007, prompt +
  `vault-template/AGENTS.md` changes (gated), inbox integration, merge
  handlers, golden fixtures.

Fan-out guidance (per CLAUDE.md): within M9, schema+routes and the two Astro
views are independent once `packages/schema` types are committed — suitable
for parallel subagents.

## 10. Deferred — to be added to SPEC §20

| Q | Question | Suggested default |
|---|---|---|
| Q25 | Event recurrence | deferred; `rrule` column reserved |
| Q26 | In-column manual kanban ordering | deferred; sort by due, then created |
| Q27 | Task priority field | deferred |
| Q28 | Live board sync over WS | deferred (with presence, Q18) |
| Q29 | Attendee RSVP status | deferred |
| Q30 | Event reminders | deferred; natural fit for `scheduled_actions` |
| Q31 | `scheduled_actions` overlay on calendar | deferred |
| Q32 | GitHub Issues sync layer (#30) | after M11; optional layer |

## 11. Security notes

- All new routes behind Access JWT like the rest of §8; no new auth surface.
- Slash-command parsing is deterministic string parsing in the DO — no LLM in
  the M9/M10 path, so no new prompt-injection surface until M11.
- M11 extraction output is human-reviewed before materialization (same trust
  boundary as wiki proposals; see docs/SECURITY.md — chat is untrusted input).
- Vault snapshots render user-supplied titles into markdown — escape/fence
  them the same way daily chat logs already handle message bodies.
