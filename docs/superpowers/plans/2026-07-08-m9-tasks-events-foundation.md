# M9 — Tasks, Events, Kanban & Calendar Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native D1 tasks + single-occurrence events with a kanban board (`/tasks`), a calendar (`/calendar`), REST APIs, and deterministic chat slash commands (`/task`, `/event`, `/done`) in the ChatRoom DO.

**Architecture:** Two new D1 tables (`tasks`, `events`) + two join tables (`task_tags`, `event_attendees`) via forward-only migration `0006`. Zod row/request schemas in `packages/schema` shared worker↔web. Three new Hono route files mounted at `/api` (existing pattern). Kanban is a client-side grouping of `tasks` by a fixed status enum — no board entity. Calendar is a query-time union endpoint. Slash commands: pure parser in `packages/shared`, executed against D1 from the ChatRoom DO, confirmation posted via the existing system-message machinery.

**Tech Stack:** TypeScript strict (`noUncheckedIndexedAccess` — never index arrays without a guard), Hono, Cloudflare Workers + DO (Hibernation API only), D1, Zod, vitest + `@cloudflare/vitest-pool-workers`, Astro + React 19 islands, Tailwind 4, biome.

**Spec:** `docs/superpowers/specs/2026-07-08-calendar-tasks-kanban-design.md` (approved 2026-07-08).

## Global Constraints

- Every new file starts with `// SPDX-License-Identifier: Apache-2.0` (or `-- SPDX...` in SQL).
- All API routes return `ApiResult<T>` (`apiOk`/`apiErr` from `@loomwiki/shared`); routes throw `LoomwikiError` with a code from `ErrorCodes`; the error middleware maps to HTTP.
- IDs: UUIDv7 via `id()` from `@loomwiki/shared`. Times: unix epoch **seconds** (integer) everywhere on the wire and in D1.
- Date-only values (task `due_at`, all-day events) are stored as epoch at **00:00:00 UTC** of the calendar date and rendered by **UTC date**. Timed events are instants rendered **browser-local**.
- D1 migrations are forward-only; never edit `0001`–`0005`. D1 enforces foreign keys — delete `task_tags` rows before their task.
- DO code: Hibernation API only (`ctx.acceptWebSocket` + class-method handlers); `ctx.storage.sql`; never `ws.addEventListener`; never iterate an instance-field socket map.
- Worker tests live flat in `apps/worker/src/__tests__/` (NOT `routes/__tests__/` — the repo diverged from CLAUDE.md; follow reality). Schema tests in `packages/schema/src/__tests__/`, shared tests in `packages/shared/src/__tests__/`, web tests colocated `*.test.ts(x)`.
- Public exports from `packages/*` need explicit return types.
- File names: `kebab-case.ts`; React components `PascalCase.tsx`.
- Run from repo root. Full gates: `pnpm test && pnpm typecheck && pnpm lint`. Format with `pnpm format` before each commit if biome complains.
- Branch: `m9-tasks-events-foundation` (repo convention `m{N}-{desc}`). Imperative conventional commits (`feat:`, `docs:`); one logical change per commit, tests in the same commit.
- Wire shapes for tasks/events return D1 row fields directly with epoch numbers (the `scheduled_actions` precedent) — no ISO conversion.
- Do NOT touch `vault-template/`, `LICENSE`, `NOTICE`, existing migrations, existing ADRs, or the `wrangler.jsonc` `migrations` array (no new DO classes in M9 — the array doesn't change).

---

### Task 1: Migration `0006_tasks_events.sql`

**Files:**
- Create: `packages/schema/d1-migrations/0006_tasks_events.sql`

**Interfaces:**
- Produces: tables `tasks`, `task_tags`, `events`, `event_attendees` exactly as below — every later task's SQL depends on these column names.

- [ ] **Step 1: Write the migration**

```sql
-- SPDX-License-Identifier: Apache-2.0
--
-- Tasks + events (v0.1 M9). Native task tracker and calendar entities.
-- Kanban is a VIEW over tasks.status — deliberately no board/column tables.
-- Forward-only. See docs/superpowers/specs/2026-07-08-calendar-tasks-kanban-design.md.

CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY,             -- UUIDv7
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  room_id            TEXT REFERENCES rooms(id),    -- nullable: room-optional
  title              TEXT NOT NULL,
  body               TEXT,                         -- markdown
  status             TEXT NOT NULL DEFAULT 'todo'
                     CHECK (status IN ('backlog','todo','doing','done','cancelled')),
  assignee_id        TEXT REFERENCES users(id),    -- single assignee
  due_at             INTEGER,                      -- epoch s; date-only convention: 00:00:00 UTC
  origin_message_id  TEXT REFERENCES messages(id), -- chat provenance
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status ON tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_room_status      ON tasks(room_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status  ON tasks(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due              ON tasks(due_at) WHERE due_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_tags (
  task_id  TEXT NOT NULL REFERENCES tasks(id),
  tag      TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag);

CREATE TABLE IF NOT EXISTS events (
  id                 TEXT PRIMARY KEY,             -- UUIDv7
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  room_id            TEXT REFERENCES rooms(id),    -- nullable: room-optional
  title              TEXT NOT NULL,
  body               TEXT,                         -- markdown
  starts_at          INTEGER NOT NULL,             -- epoch s
  ends_at            INTEGER,                      -- null = point-in-time
  all_day            INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
  rrule              TEXT,                         -- RESERVED: always NULL in v1 (recurrence deferred, SPEC Q25)
  origin_message_id  TEXT REFERENCES messages(id),
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  cancelled_at       INTEGER                       -- soft-cancel; DELETE /api/events/:id sets this
);

CREATE INDEX IF NOT EXISTS idx_events_workspace_start ON events(workspace_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_events_room_start      ON events(room_id, starts_at);

CREATE TABLE IF NOT EXISTS event_attendees (
  event_id  TEXT NOT NULL REFERENCES events(id),
  user_id   TEXT NOT NULL REFERENCES users(id),
  added_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (event_id, user_id)
);
```

- [ ] **Step 2: Verify migrations still apply cleanly**

The worker test harness applies every file in `packages/schema/d1-migrations/` in `beforeAll` (see `apps/worker/vitest.config.ts` + `__fixtures__/db.js`), so any existing test exercises the new migration.

Run: `pnpm --filter @loomwiki/worker exec vitest run src/__tests__/health.test.ts`
Expected: PASS (if the SQL has a syntax error, `applyMigrations()` throws here).

- [ ] **Step 3: Commit**

```bash
git add packages/schema/d1-migrations/0006_tasks_events.sql
git commit -m "feat(schema): add tasks+events migration 0006"
```

---

### Task 2: Zod schemas + parsers in `packages/schema`

**Files:**
- Modify: `packages/schema/src/index.ts` (append at end)
- Modify: `packages/schema/src/parsers.ts` (add two parsers + type re-exports)
- Test: `packages/schema/src/__tests__/tasks-events.test.ts`

**Interfaces:**
- Consumes: `Uuidv7Schema`, `EpochSeconds` (module-local const, already defined near the top of index.ts).
- Produces (exact names later tasks import from `@loomwiki/schema`):
  `TaskStatusSchema`, `TaskStatus`, `TASK_BOARD_STATUSES`, `TagSchema`, `TaskRowSchema`, `TaskRow`, `TaskSchema`, `Task`, `CreateTaskRequestSchema`, `CreateTaskRequest`, `PatchTaskRequestSchema`, `PatchTaskRequest`, `EventRowSchema`, `EventRow`, `EventWithAttendeesSchema`, `EventWithAttendees`, `CreateEventRequestSchema`, `CreateEventRequest`, `PatchEventRequestSchema`, `PatchEventRequest`, `CalendarEventEntrySchema`, `CalendarTaskEntrySchema`, `CalendarEntrySchema`, `CalendarEntry`, `CalendarResponseSchema`, `CalendarResponse`, `MemberSummarySchema`, `MemberSummary`.
  From `@loomwiki/schema/parsers`: `parseTaskRow`, `parseEventRow`.

- [ ] **Step 1: Write the failing test**

Create `packages/schema/src/__tests__/tasks-events.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CalendarEntrySchema,
  CreateEventRequestSchema,
  CreateTaskRequestSchema,
  EventRowSchema,
  PatchTaskRequestSchema,
  TASK_BOARD_STATUSES,
  TaskRowSchema,
} from "../index.js";

const UID = "0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa";

const taskRow = {
  id: UID,
  workspace_id: UID,
  room_id: null,
  title: "Fix login bug",
  body: null,
  status: "todo",
  assignee_id: null,
  due_at: null,
  origin_message_id: null,
  created_by: UID,
  created_at: 1751971200,
  updated_at: 1751971200,
  completed_at: null,
};

const eventRow = {
  id: UID,
  workspace_id: UID,
  room_id: null,
  title: "Standup",
  body: null,
  starts_at: 1751971200,
  ends_at: null,
  all_day: 1,
  rrule: null,
  origin_message_id: null,
  created_by: UID,
  created_at: 1751971200,
  updated_at: 1751971200,
  cancelled_at: null,
};

describe("TaskRowSchema", () => {
  it("parses a valid row", () => {
    expect(TaskRowSchema.parse(taskRow)).toEqual(taskRow);
  });

  it("rejects an unknown status", () => {
    expect(TaskRowSchema.safeParse({ ...taskRow, status: "blocked" }).success).toBe(false);
  });

  it("board statuses exclude cancelled", () => {
    expect(TASK_BOARD_STATUSES).toEqual(["backlog", "todo", "doing", "done"]);
  });
});

describe("EventRowSchema", () => {
  it("parses a valid row", () => {
    expect(EventRowSchema.parse(eventRow)).toEqual(eventRow);
  });

  it("rejects a non-null rrule (reserved in v1)", () => {
    expect(EventRowSchema.safeParse({ ...eventRow, rrule: "FREQ=WEEKLY" }).success).toBe(false);
  });
});

describe("request schemas", () => {
  it("CreateTaskRequest accepts minimal shape and rejects extras", () => {
    expect(CreateTaskRequestSchema.safeParse({ title: "x" }).success).toBe(true);
    expect(CreateTaskRequestSchema.safeParse({ title: "x", nope: 1 }).success).toBe(false);
  });

  it("PatchTaskRequest rejects empty patch", () => {
    expect(PatchTaskRequestSchema.safeParse({}).success).toBe(false);
    expect(PatchTaskRequestSchema.safeParse({ status: "done" }).success).toBe(true);
  });

  it("CreateEventRequest rejects ends_at before starts_at", () => {
    const bad = { title: "x", starts_at: 100, ends_at: 50 };
    expect(CreateEventRequestSchema.safeParse(bad).success).toBe(false);
    expect(CreateEventRequestSchema.safeParse({ title: "x", starts_at: 100 }).success).toBe(true);
  });
});

describe("CalendarEntrySchema", () => {
  it("discriminates on kind", () => {
    const taskEntry = {
      kind: "task_due",
      id: UID,
      title: "t",
      status: "todo",
      room_id: null,
      assignee_id: null,
      due_at: 1751971200,
    };
    const eventEntry = {
      kind: "event",
      id: UID,
      title: "e",
      room_id: null,
      starts_at: 1751971200,
      ends_at: null,
      all_day: 0,
    };
    expect(CalendarEntrySchema.safeParse(taskEntry).success).toBe(true);
    expect(CalendarEntrySchema.safeParse(eventEntry).success).toBe(true);
    expect(CalendarEntrySchema.safeParse({ ...eventEntry, kind: "task_due" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @loomwiki/schema exec vitest run src/__tests__/tasks-events.test.ts`
Expected: FAIL — `TaskRowSchema` etc. are not exported.

- [ ] **Step 3: Append the schemas to `packages/schema/src/index.ts`**

Append at end of file:

```ts
// ---------- Tasks & events (v0.1 M9) ----------
//
// Native task tracker + calendar entities (migration 0006). Kanban is a
// view over `tasks.status` — fixed enum, no board tables. Date-only
// values (task due_at, all-day events) are epoch at 00:00:00 UTC of the
// calendar date and render by UTC date; timed events are instants and
// render browser-local. See docs/superpowers/specs/
// 2026-07-08-calendar-tasks-kanban-design.md.

export const TaskStatusSchema = z.enum(["backlog", "todo", "doing", "done", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// The kanban columns, in board order. `cancelled` is reachable only via
// the status filter — it never renders as a column.
export const TASK_BOARD_STATUSES = ["backlog", "todo", "doing", "done"] as const;

export const TagSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "tag must be kebab-case lowercase ASCII");

export const TaskRowSchema = z.object({
  id: Uuidv7Schema,
  workspace_id: Uuidv7Schema,
  room_id: Uuidv7Schema.nullable(),
  title: z.string().min(1).max(200),
  body: z.string().max(4096).nullable(),
  status: TaskStatusSchema,
  assignee_id: Uuidv7Schema.nullable(),
  due_at: EpochSeconds.nullable(),
  origin_message_id: Uuidv7Schema.nullable(),
  created_by: Uuidv7Schema,
  created_at: EpochSeconds,
  updated_at: EpochSeconds,
  completed_at: EpochSeconds.nullable(),
});
export type TaskRow = z.infer<typeof TaskRowSchema>;

// API shape: row + tags (joined from task_tags at the route layer).
export const TaskSchema = TaskRowSchema.extend({
  tags: z.array(TagSchema).max(20),
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskRequestSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(4096).optional(),
    status: TaskStatusSchema.optional(), // default 'todo'
    room_id: Uuidv7Schema.nullable().optional(),
    assignee_id: Uuidv7Schema.nullable().optional(),
    due_at: EpochSeconds.nullable().optional(),
    tags: z.array(TagSchema).max(20).optional(),
  })
  .strict();
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const PatchTaskRequestSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(4096).nullable().optional(),
    status: TaskStatusSchema.optional(),
    room_id: Uuidv7Schema.nullable().optional(),
    assignee_id: Uuidv7Schema.nullable().optional(),
    due_at: EpochSeconds.nullable().optional(),
    tags: z.array(TagSchema).max(20).optional(),
  })
  .strict()
  .refine((o) => Object.values(o).some((v) => v !== undefined), {
    message: "at least one field required",
  });
export type PatchTaskRequest = z.infer<typeof PatchTaskRequestSchema>;

// `rrule` is z.null() on purpose: recurrence is deferred (SPEC Q25) and the
// column is reserved. A non-null value in D1 is drift and should 500 loudly.
export const EventRowSchema = z.object({
  id: Uuidv7Schema,
  workspace_id: Uuidv7Schema,
  room_id: Uuidv7Schema.nullable(),
  title: z.string().min(1).max(200),
  body: z.string().max(4096).nullable(),
  starts_at: EpochSeconds,
  ends_at: EpochSeconds.nullable(),
  all_day: z.union([z.literal(0), z.literal(1)]),
  rrule: z.null(),
  origin_message_id: Uuidv7Schema.nullable(),
  created_by: Uuidv7Schema,
  created_at: EpochSeconds,
  updated_at: EpochSeconds,
  cancelled_at: EpochSeconds.nullable(),
});
export type EventRow = z.infer<typeof EventRowSchema>;

// API shape: row + attendee ids (joined from event_attendees).
// Named EventWithAttendees (not Event) to avoid shadowing the DOM Event type
// in web code.
export const EventWithAttendeesSchema = EventRowSchema.extend({
  attendee_ids: z.array(Uuidv7Schema),
});
export type EventWithAttendees = z.infer<typeof EventWithAttendeesSchema>;

export const CreateEventRequestSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(4096).optional(),
    room_id: Uuidv7Schema.nullable().optional(),
    starts_at: EpochSeconds,
    ends_at: EpochSeconds.nullable().optional(),
    all_day: z.boolean().optional(), // default false
    attendee_ids: z.array(Uuidv7Schema).max(50).optional(),
  })
  .strict()
  .refine((o) => o.ends_at == null || o.ends_at >= o.starts_at, {
    message: "ends_at must be >= starts_at",
  });
export type CreateEventRequest = z.infer<typeof CreateEventRequestSchema>;

export const PatchEventRequestSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(4096).nullable().optional(),
    room_id: Uuidv7Schema.nullable().optional(),
    starts_at: EpochSeconds.optional(),
    ends_at: EpochSeconds.nullable().optional(),
    all_day: z.boolean().optional(),
  })
  .strict()
  .refine((o) => Object.values(o).some((v) => v !== undefined), {
    message: "at least one field required",
  });
export type PatchEventRequest = z.infer<typeof PatchEventRequestSchema>;

// ---------- Calendar union (GET /api/calendar) ----------

export const CalendarEventEntrySchema = z.object({
  kind: z.literal("event"),
  id: Uuidv7Schema,
  title: z.string().min(1).max(200),
  room_id: Uuidv7Schema.nullable(),
  starts_at: EpochSeconds,
  ends_at: EpochSeconds.nullable(),
  all_day: z.union([z.literal(0), z.literal(1)]),
});
export type CalendarEventEntry = z.infer<typeof CalendarEventEntrySchema>;

export const CalendarTaskEntrySchema = z.object({
  kind: z.literal("task_due"),
  id: Uuidv7Schema,
  title: z.string().min(1).max(200),
  status: TaskStatusSchema,
  room_id: Uuidv7Schema.nullable(),
  assignee_id: Uuidv7Schema.nullable(),
  due_at: EpochSeconds,
});
export type CalendarTaskEntry = z.infer<typeof CalendarTaskEntrySchema>;

export const CalendarEntrySchema = z.discriminatedUnion("kind", [
  CalendarEventEntrySchema,
  CalendarTaskEntrySchema,
]);
export type CalendarEntry = z.infer<typeof CalendarEntrySchema>;

export const CalendarResponseSchema = z.object({
  entries: z.array(CalendarEntrySchema),
  from: EpochSeconds,
  to: EpochSeconds,
});
export type CalendarResponse = z.infer<typeof CalendarResponseSchema>;

// ---------- Workspace members (GET /api/workspaces/:wid/members) ----------

export const MemberSummarySchema = z.object({
  id: Uuidv7Schema,
  display_name: z.string().min(1).max(120),
  email: z.string().email().max(320),
});
export type MemberSummary = z.infer<typeof MemberSummarySchema>;
```

- [ ] **Step 4: Add parsers to `packages/schema/src/parsers.ts`**

In the import block from `"./index.js"`, add `TaskRowSchema` and `EventRowSchema`. After the `parseScheduledActionRow` export, add:

```ts
export const parseTaskRow = (row: unknown) => parseRow(TaskRowSchema, row, "tasks");
export const parseEventRow = (row: unknown) => parseRow(EventRowSchema, row, "events");
```

In the `export type { ... }` block at the bottom, add: `Task`, `TaskRow`, `TaskStatus`, `EventRow`, `EventWithAttendees`, `CalendarEntry`, `CalendarResponse`, `CreateTaskRequest`, `PatchTaskRequest`, `CreateEventRequest`, `PatchEventRequest`, `MemberSummary`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @loomwiki/schema test`
Expected: PASS (all schema package tests, including the new file).

- [ ] **Step 6: Commit**

```bash
git add packages/schema/src/index.ts packages/schema/src/parsers.ts packages/schema/src/__tests__/tasks-events.test.ts
git commit -m "feat(schema): add task/event zod schemas, parsers, calendar union"
```

---

### Task 3: Slash-command parser in `packages/shared`

**Files:**
- Create: `packages/shared/src/slash-commands.ts`
- Modify: `packages/shared/src/index.ts` (add export line)
- Test: `packages/shared/src/__tests__/slash-commands.test.ts`

**Interfaces:**
- Produces (imported by Task 8's DO code from `@loomwiki/shared`):

```ts
type SlashCommand =
  | { kind: "task"; title: string; assigneeToken: string | null; dueDate: string | null }
  | { kind: "event"; title: string; date: string; time: string | null; durationMinutes: number | null }
  | { kind: "done"; title: string };
type SlashParseResult =
  | { matched: false }
  | { matched: true; ok: true; command: SlashCommand }
  | { matched: true; ok: false; error: string };
function parseSlashCommand(body: string): SlashParseResult;
```

Grammar (deterministic, no NLP):
- `/task <title…> [@token] [due:YYYY-MM-DD]` — `@` and `due:` tokens may appear anywhere after `/task`; the remaining tokens joined by a single space are the title.
- `/event <title…> <YYYY-MM-DD> [HH:MM] [+Nm|+Nh]` — first date-shaped token ends the title; time/duration optional; duration requires time.
- `/done <exact task title>` — matched later (Task 8) case-insensitively against the room's open tasks.
- A body starting with `/` that is not exactly `/task`, `/event`, or `/done` as its first whitespace-delimited token → `{ matched: false }` (treated as a normal chat message — `/ask` and future commands stay unaffected).

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/__tests__/slash-commands.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "../slash-commands.js";

describe("parseSlashCommand — non-commands", () => {
  it("ignores plain messages and unknown slash commands", () => {
    expect(parseSlashCommand("hello world")).toEqual({ matched: false });
    expect(parseSlashCommand("/ask what did we decide")).toEqual({ matched: false });
    expect(parseSlashCommand("/tasked wrong")).toEqual({ matched: false });
  });
});

describe("/task", () => {
  it("parses title only", () => {
    expect(parseSlashCommand("/task Fix login bug")).toEqual({
      matched: true,
      ok: true,
      command: { kind: "task", title: "Fix login bug", assigneeToken: null, dueDate: null },
    });
  });

  it("parses assignee and due anywhere", () => {
    expect(parseSlashCommand("/task @cory Fix login bug due:2026-07-20")).toEqual({
      matched: true,
      ok: true,
      command: { kind: "task", title: "Fix login bug", assigneeToken: "cory", dueDate: "2026-07-20" },
    });
  });

  it("rejects empty title", () => {
    const r = parseSlashCommand("/task @cory due:2026-07-20");
    expect(r).toMatchObject({ matched: true, ok: false });
  });

  it("rejects invalid calendar dates", () => {
    expect(parseSlashCommand("/task x due:2026-02-31")).toMatchObject({ matched: true, ok: false });
    expect(parseSlashCommand("/task x due:2026-13-01")).toMatchObject({ matched: true, ok: false });
  });

  it("rejects two assignee tokens", () => {
    expect(parseSlashCommand("/task x @a @b")).toMatchObject({ matched: true, ok: false });
  });
});

describe("/event", () => {
  it("parses all-day event (date only)", () => {
    expect(parseSlashCommand("/event Team offsite 2026-07-20")).toEqual({
      matched: true,
      ok: true,
      command: { kind: "event", title: "Team offsite", date: "2026-07-20", time: null, durationMinutes: null },
    });
  });

  it("parses timed event with duration", () => {
    expect(parseSlashCommand("/event Standup 2026-07-20 09:30 +30m")).toEqual({
      matched: true,
      ok: true,
      command: { kind: "event", title: "Standup", date: "2026-07-20", time: "09:30", durationMinutes: 30 },
    });
    expect(parseSlashCommand("/event Review 2026-07-20 14:00 +2h")).toMatchObject({
      matched: true,
      ok: true,
      command: { durationMinutes: 120 },
    });
  });

  it("rejects missing date, bad time, duration without time, trailing junk", () => {
    expect(parseSlashCommand("/event Standup tomorrow")).toMatchObject({ matched: true, ok: false });
    expect(parseSlashCommand("/event S 2026-07-20 25:00")).toMatchObject({ matched: true, ok: false });
    expect(parseSlashCommand("/event S 2026-07-20 +30m")).toMatchObject({ matched: true, ok: false });
    expect(parseSlashCommand("/event S 2026-07-20 09:00 +30m extra")).toMatchObject({ matched: true, ok: false });
  });
});

describe("/done", () => {
  it("parses the title", () => {
    expect(parseSlashCommand("/done Fix login bug")).toEqual({
      matched: true,
      ok: true,
      command: { kind: "done", title: "Fix login bug" },
    });
  });

  it("rejects empty title", () => {
    expect(parseSlashCommand("/done")).toMatchObject({ matched: true, ok: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @loomwiki/shared exec vitest run src/__tests__/slash-commands.test.ts`
Expected: FAIL — module `../slash-commands.js` not found.

- [ ] **Step 3: Implement the parser**

Create `packages/shared/src/slash-commands.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

// Deterministic slash-command parser for the ChatRoom DO (v0.1 M9).
// Pure string parsing — no NLP, no Date.now(), no DB. The DO resolves
// tokens (assignee → user, title → task) against D1; this module only
// decides shape. `{ matched: false }` means "not ours — treat as a
// normal chat message", which keeps /ask and future commands unaffected.

export type SlashCommand =
  | { kind: "task"; title: string; assigneeToken: string | null; dueDate: string | null }
  | { kind: "event"; title: string; date: string; time: string | null; durationMinutes: number | null }
  | { kind: "done"; title: string };

export type SlashParseResult =
  | { matched: false }
  | { matched: true; ok: true; command: SlashCommand }
  | { matched: true; ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DURATION_RE = /^\+(\d{1,3})([mh])$/;
const MAX_TITLE = 200;

const TASK_USAGE = "usage: /task <title> [@assignee] [due:YYYY-MM-DD]";
const EVENT_USAGE = "usage: /event <title> <YYYY-MM-DD> [HH:MM] [+30m|+2h]";
const DONE_USAGE = "usage: /done <exact task title>";

/** True if `date` (YYYY-MM-DD) is a real UTC calendar date. */
export function isValidUtcDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function err(error: string): SlashParseResult {
  return { matched: true, ok: false, error };
}

function checkTitle(title: string, usage: string): SlashParseResult | null {
  if (title.length === 0) return err(usage);
  if (title.length > MAX_TITLE) return err(`title exceeds ${MAX_TITLE} characters`);
  return null;
}

export function parseSlashCommand(body: string): SlashParseResult {
  const trimmed = body.trim();
  if (!trimmed.startsWith("/")) return { matched: false };
  const tokens = trimmed.split(/\s+/);
  const head = tokens[0];
  if (head !== "/task" && head !== "/event" && head !== "/done") return { matched: false };
  const rest = tokens.slice(1);

  if (head === "/done") {
    const title = rest.join(" ");
    const bad = checkTitle(title, DONE_USAGE);
    if (bad) return bad;
    return { matched: true, ok: true, command: { kind: "done", title } };
  }

  if (head === "/task") {
    let assigneeToken: string | null = null;
    let dueDate: string | null = null;
    const titleTokens: string[] = [];
    for (const tok of rest) {
      if (tok.startsWith("@") && tok.length > 1) {
        if (assigneeToken !== null) return err("only one @assignee allowed");
        assigneeToken = tok.slice(1);
      } else if (tok.startsWith("due:")) {
        if (dueDate !== null) return err("only one due: allowed");
        const date = tok.slice(4);
        if (!isValidUtcDate(date)) return err("due: must be a valid YYYY-MM-DD date");
        dueDate = date;
      } else {
        titleTokens.push(tok);
      }
    }
    const title = titleTokens.join(" ");
    const bad = checkTitle(title, TASK_USAGE);
    if (bad) return bad;
    return { matched: true, ok: true, command: { kind: "task", title, assigneeToken, dueDate } };
  }

  // head === "/event"
  const dateIdx = rest.findIndex((tok) => DATE_RE.test(tok));
  if (dateIdx === -1) return err(EVENT_USAGE);
  const date = rest[dateIdx];
  if (date === undefined || !isValidUtcDate(date)) {
    return err("event date must be a valid YYYY-MM-DD date");
  }
  const title = rest.slice(0, dateIdx).join(" ");
  const bad = checkTitle(title, EVENT_USAGE);
  if (bad) return bad;

  let time: string | null = null;
  let durationMinutes: number | null = null;
  const tail = rest.slice(dateIdx + 1);
  let i = 0;
  const maybeTime = tail[i];
  if (maybeTime !== undefined && TIME_RE.test(maybeTime)) {
    time = maybeTime;
    i += 1;
  }
  const maybeDuration = tail[i];
  if (maybeDuration !== undefined) {
    const m = DURATION_RE.exec(maybeDuration);
    if (m === null) {
      return err(time === null ? "expected HH:MM time or nothing after the date" : EVENT_USAGE);
    }
    if (time === null) return err("duration requires a HH:MM time");
    const n = Number.parseInt(m[1] ?? "0", 10);
    durationMinutes = m[2] === "h" ? n * 60 : n;
    i += 1;
  }
  if (i < tail.length) return err(EVENT_USAGE);

  return { matched: true, ok: true, command: { kind: "event", title, date, time, durationMinutes } };
}
```

Add to `packages/shared/src/index.ts`:

```ts
export {
  parseSlashCommand,
  isValidUtcDate,
  type SlashCommand,
  type SlashParseResult,
} from "./slash-commands.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @loomwiki/shared test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/slash-commands.ts packages/shared/src/index.ts packages/shared/src/__tests__/slash-commands.test.ts
git commit -m "feat(shared): add deterministic slash-command parser"
```

---

### Task 4: Workspace members endpoint

The kanban/calendar UIs need workspace users for assignee display and filters; no such API exists (`/api/me` returns only self + rooms).

**Files:**
- Modify: `apps/worker/src/routes/workspaces.ts` (add one route)
- Test: `apps/worker/src/__tests__/routes-workspace-members.test.ts`

**Interfaces:**
- Consumes: `MemberSummarySchema` (Task 2).
- Produces: `GET /api/workspaces/:wid/members` → `ApiResult<{ members: MemberSummary[] }>`. Single-workspace deploy: every `users` row is a member.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/__tests__/routes-workspace-members.test.ts` (harness identical to `routes-scheduled-actions.test.ts` — `applyMigrations`/`resetDb`/`makeJwtFixture`/`authedFetch`; copy those ~40 setup lines verbatim from that file):

```ts
// SPDX-License-Identifier: Apache-2.0

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";
import { type JwtFixture, makeJwtFixture } from "./__fixtures__/jwt.js";

let fixture: JwtFixture;

beforeAll(async () => {
  await applyMigrations();
  fixture = await makeJwtFixture();
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

beforeEach(async () => {
  await resetDb();
});

async function authedFetch(jwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("CF-Access-Jwt-Assertion", jwt);
  return SELF.fetch(`https://api.local${path}`, { ...init, headers });
}

describe("GET /api/workspaces/:wid/members", () => {
  it("returns 401 without JWT", async () => {
    const res = await SELF.fetch("https://api.local/api/workspaces/x/members");
    expect(res.status).toBe(401);
  });

  it("lists every workspace user", async () => {
    const ownerJwt = await fixture.mint({ email: "owner@example.com" });
    const me = await authedFetch(ownerJwt, "/api/me");
    const meBody = (await me.json()) as { data: { workspace: { id: string } } };
    const wid = meBody.data.workspace.id;

    const secondJwt = await fixture.mint({ email: "bob@example.com" });
    await authedFetch(secondJwt, "/api/me"); // JIT-provision bob

    const res = await authedFetch(ownerJwt, `/api/workspaces/${wid}/members`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { members: Array<{ id: string; email: string; display_name: string }> };
    };
    const emails = body.data.members.map((m) => m.email).sort();
    expect(emails).toEqual(["bob@example.com", "owner@example.com"]);
  });

  it("404s for a foreign workspace id", async () => {
    const ownerJwt = await fixture.mint({ email: "owner@example.com" });
    await authedFetch(ownerJwt, "/api/me");
    const res = await authedFetch(
      ownerJwt,
      "/api/workspaces/0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa/members",
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @loomwiki/worker exec vitest run src/__tests__/routes-workspace-members.test.ts`
Expected: FAIL — the members route 404s (route body assertion fails on the happy-path test with `ok: false`).

- [ ] **Step 3: Add the route**

In `apps/worker/src/routes/workspaces.ts`, add imports for `MemberSummarySchema` (from `@loomwiki/schema`) and append a `.get("/:wid/members", ...)` handler to the existing `workspacesRoute` Hono chain, following the existing `:wid` handlers' workspace check:

```ts
.get("/:wid/members", async (c) => {
  const wid = c.req.param("wid");
  if (wid !== c.var.workspace.id) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Workspace not found", { status: 404 });
  }
  const rows = await c.env.DB.prepare(
    "SELECT id, display_name, email FROM users ORDER BY display_name, id",
  ).all();
  const members = rows.results.map((r) => {
    const parsed = MemberSummarySchema.safeParse(r);
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.DB_PARSE_ERROR, "Failed to parse users row", {
        status: 500,
        details: parsed.error.issues,
      });
    }
    return parsed.data;
  });
  return c.json(apiOk({ members }));
})
```

(If `LoomwikiError`/`ErrorCodes`/`apiOk` are not already imported in that file, add them from `@loomwiki/shared`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @loomwiki/worker exec vitest run src/__tests__/routes-workspace-members.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/routes/workspaces.ts apps/worker/src/__tests__/routes-workspace-members.test.ts
git commit -m "feat(api): add workspace members endpoint"
```

---

### Task 5: Tasks routes (`/api/tasks`)

**Files:**
- Create: `apps/worker/src/routes/tasks.ts`
- Modify: `apps/worker/src/index.ts` (auth middleware + mount)
- Test: `apps/worker/src/__tests__/routes-tasks.test.ts`

**Interfaces:**
- Consumes: Task 2 schemas/parsers; `requireWriteAccess` semantics below are reused verbatim in Task 6.
- Produces:
  - `GET /api/tasks?status=&room=&assignee=&tag=&due_before=&due_after=&before=&limit=` → `{ tasks: Task[], hasMore: boolean }` (pages newest-first internally, returned oldest-first within the page — the repo's cursor convention; cursor param is `before`, matching `rooms.ts`/`scheduled-actions.ts` rather than the design doc's cosmetic `cursor=` name).
  - `POST /api/tasks` → 201 `{ task: Task }`
  - `GET /api/tasks/:id` → `{ task: Task }`
  - `PATCH /api/tasks/:id` → `{ task: Task }`
  - `DELETE /api/tasks/:id` → `{ deleted: true }`

Access model: any workspace member reads all; writes to a room-scoped task require room membership with role ≠ `viewer`; roomless tasks writable by any member.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/__tests__/routes-tasks.test.ts`. Reuse the exact harness from `routes-scheduled-actions.test.ts`: same `beforeAll`/`beforeEach`, same `authedFetch`, same `bootstrapOwnerAndRoom()` helper (copy it verbatim — it mints an owner, calls `/api/me`, creates a room, returns `{ ownerJwt, ownerId, workspaceId, roomId }`), plus:

```ts
async function bootstrapSecondUser(email: string): Promise<{ jwt: string; userId: string }> {
  const jwt = await fixture.mint({ email });
  const me = await authedFetch(jwt, "/api/me");
  const meBody = (await me.json()) as { data: { user: { id: string } } };
  return { jwt, userId: meBody.data.user.id };
}
```

Then the test bodies:

```ts
interface TaskShape {
  id: string;
  title: string;
  status: string;
  room_id: string | null;
  assignee_id: string | null;
  due_at: number | null;
  completed_at: number | null;
  tags: string[];
}

async function createTask(jwt: string, body: unknown): Promise<{ res: Response; task: TaskShape }> {
  const res = await authedFetch(jwt, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as { ok: boolean; data?: { task: TaskShape } };
  return { res, task: parsed.data?.task as TaskShape };
}

describe("POST /api/tasks", () => {
  it("returns 401 without JWT", async () => {
    const res = await SELF.fetch("https://api.local/api/tasks", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("creates a minimal roomless task defaulting to todo", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { res, task } = await createTask(ownerJwt, { title: "Fix login bug" });
    expect(res.status).toBe(201);
    expect(task.status).toBe("todo");
    expect(task.room_id).toBeNull();
    expect(task.tags).toEqual([]);
  });

  it("creates a room-scoped task with tags, assignee, due date", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const bob = await bootstrapSecondUser("bob@example.com");
    const due = 1789344000; // 2026-09-14T00:00:00Z
    const { res, task } = await createTask(ownerJwt, {
      title: "Ship M9",
      room_id: roomId,
      assignee_id: bob.userId,
      due_at: due,
      tags: ["m9", "backend"],
    });
    expect(res.status).toBe(201);
    expect(task.room_id).toBe(roomId);
    expect(task.assignee_id).toBe(bob.userId);
    expect(task.due_at).toBe(due);
    expect(task.tags).toEqual(["backend", "m9"]);
  });

  it("404s an unknown room", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { res } = await createTask(ownerJwt, { title: "x", room_id: id() });
    expect(res.status).toBe(404);
  });

  it("403s a viewer writing a room-scoped task", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const eve = await bootstrapSecondUser("eve@example.com");
    await env.DB.prepare(
      "INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, 'viewer')",
    )
      .bind(roomId, eve.userId)
      .run();
    const { res } = await createTask(eve.jwt, { title: "x", room_id: roomId });
    expect(res.status).toBe(403);
  });

  it("400s an unknown assignee", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { res } = await createTask(ownerJwt, { title: "x", assignee_id: id() });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/tasks — filters + pagination", () => {
  it("filters by status, tag, and assignee", async () => {
    const { ownerJwt, ownerId } = await bootstrapOwnerAndRoom();
    await createTask(ownerJwt, { title: "a", status: "done" });
    await createTask(ownerJwt, { title: "b", tags: ["bug"] });
    await createTask(ownerJwt, { title: "c", assignee_id: ownerId });

    const byStatus = await authedFetch(ownerJwt, "/api/tasks?status=done");
    const s = (await byStatus.json()) as { data: { tasks: TaskShape[] } };
    expect(s.data.tasks.map((t) => t.title)).toEqual(["a"]);

    const byTag = await authedFetch(ownerJwt, "/api/tasks?tag=bug");
    const g = (await byTag.json()) as { data: { tasks: TaskShape[] } };
    expect(g.data.tasks.map((t) => t.title)).toEqual(["b"]);

    const byAssignee = await authedFetch(ownerJwt, `/api/tasks?assignee=${ownerId}`);
    const a = (await byAssignee.json()) as { data: { tasks: TaskShape[] } };
    expect(a.data.tasks.map((t) => t.title)).toEqual(["c"]);
  });

  it("paginates with before-cursor", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    await createTask(ownerJwt, { title: "t1" });
    await createTask(ownerJwt, { title: "t2" });
    await createTask(ownerJwt, { title: "t3" });

    const page1 = await authedFetch(ownerJwt, "/api/tasks?limit=2");
    const p1 = (await page1.json()) as { data: { tasks: TaskShape[]; hasMore: boolean } };
    expect(p1.data.hasMore).toBe(true);
    expect(p1.data.tasks.map((t) => t.title)).toEqual(["t2", "t3"]); // oldest-first within page
    const oldestOnPage = p1.data.tasks[0];
    if (!oldestOnPage) throw new Error("unreachable");

    const page2 = await authedFetch(ownerJwt, `/api/tasks?limit=2&before=${oldestOnPage.id}`);
    const p2 = (await page2.json()) as { data: { tasks: TaskShape[]; hasMore: boolean } };
    expect(p2.data.hasMore).toBe(false);
    expect(p2.data.tasks.map((t) => t.title)).toEqual(["t1"]);
  });
});

describe("PATCH /api/tasks/:id", () => {
  it("status→done stamps completed_at; leaving done clears it", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { task } = await createTask(ownerJwt, { title: "x" });

    const done = await authedFetch(ownerJwt, `/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    const d = (await done.json()) as { data: { task: TaskShape } };
    expect(d.data.task.status).toBe("done");
    expect(d.data.task.completed_at).not.toBeNull();

    const reopen = await authedFetch(ownerJwt, `/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "doing" }),
    });
    const r = (await reopen.json()) as { data: { task: TaskShape } };
    expect(r.data.task.status).toBe("doing");
    expect(r.data.task.completed_at).toBeNull();
  });

  it("replaces tags", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { task } = await createTask(ownerJwt, { title: "x", tags: ["old"] });
    const res = await authedFetch(ownerJwt, `/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["new-a", "new-b"] }),
    });
    const b = (await res.json()) as { data: { task: TaskShape } };
    expect(b.data.task.tags).toEqual(["new-a", "new-b"]);
  });

  it("400s an empty patch", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { task } = await createTask(ownerJwt, { title: "x" });
    const res = await authedFetch(ownerJwt, `/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/tasks/:id", () => {
  it("hard-deletes the task and its tags", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { task } = await createTask(ownerJwt, { title: "x", tags: ["a"] });
    const res = await authedFetch(ownerJwt, `/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const gone = await authedFetch(ownerJwt, `/api/tasks/${task.id}`);
    expect(gone.status).toBe(404);
    const tagRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM task_tags WHERE task_id = ?")
      .bind(task.id)
      .first<{ n: number }>();
    expect(tagRows?.n).toBe(0);
  });
});
```

(`id` here is the UUIDv7 helper — import `{ id } from "@loomwiki/shared"` in the test file, as `routes-scheduled-actions.test.ts` does.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @loomwiki/worker exec vitest run src/__tests__/routes-tasks.test.ts`
Expected: FAIL — all non-401 tests hit `NOT_FOUND` (no `/api/tasks` route yet). The two bare-401 tests pass already (auth middleware isn't registered either, so they 404 — if so, that assertion failure is also "expected fail"; both go green after Step 3).

- [ ] **Step 3: Implement the route**

Create `apps/worker/src/routes/tasks.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

// Task routes (v0.1 M9). Mounted at /api (absolute paths declared here):
//   GET    /api/tasks       — workspace list w/ filters + before-cursor
//   POST   /api/tasks       — create
//   GET    /api/tasks/:id   — detail (with tags)
//   PATCH  /api/tasks/:id   — partial update (kanban drag = status patch)
//   DELETE /api/tasks/:id   — hard delete (task_tags first; D1 enforces FKs)
//
// Access: any workspace member reads everything (rooms are organizational,
// not ACLs — design doc §2). Writes on a room-scoped task require room
// membership with role != 'viewer'; roomless tasks are writable by any
// workspace member.

import {
  CreateTaskRequestSchema,
  PatchTaskRequestSchema,
  type Task,
  type TaskRow,
  TaskStatusSchema,
} from "@loomwiki/schema";
import { parseTaskRow } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, apiOk, id } from "@loomwiki/shared";
import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AuthEnv } from "../middleware/auth.js";

const LIST_PAGE_SIZE = 50;
const LIST_MAX_PAGE_SIZE = 200;

async function requireRoomInWorkspace(env: Env, workspaceId: string, roomId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT workspace_id FROM rooms WHERE id = ?")
    .bind(roomId)
    .first<{ workspace_id: string }>();
  if (!row || row.workspace_id !== workspaceId) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Room not found", { status: 404 });
  }
}

/**
 * Room-scoped writes require membership with role != 'viewer'.
 * Roomless (room_id null) writes are open to any workspace member.
 * Exported for reuse by routes/events.ts.
 */
export async function requireWriteAccess(
  env: Env,
  userId: string,
  roomId: string | null,
): Promise<void> {
  if (roomId === null) return;
  const member = await env.DB.prepare(
    "SELECT role FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1",
  )
    .bind(roomId, userId)
    .first<{ role: string }>();
  if (!member) {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Not a member of this room", { status: 403 });
  }
  if (member.role === "viewer") {
    throw new LoomwikiError(ErrorCodes.FORBIDDEN, "Viewers cannot modify items", { status: 403 });
  }
}

async function requireUserExists(env: Env, userId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT 1 FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first();
  if (!row) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "assignee_id is not a workspace user", {
      status: 400,
    });
  }
}

async function fetchTagsFor(env: Env, taskIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (taskIds.length === 0) return map;
  const placeholders = taskIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT task_id, tag FROM task_tags WHERE task_id IN (${placeholders}) ORDER BY tag`,
  )
    .bind(...taskIds)
    .all<{ task_id: string; tag: string }>();
  for (const r of rows.results) {
    const list = map.get(r.task_id) ?? [];
    list.push(r.tag);
    map.set(r.task_id, list);
  }
  return map;
}

async function replaceTags(env: Env, taskId: string, tags: string[]): Promise<void> {
  const stmts = [env.DB.prepare("DELETE FROM task_tags WHERE task_id = ?").bind(taskId)];
  for (const tag of tags) {
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES (?, ?)").bind(
        taskId,
        tag,
      ),
    );
  }
  await env.DB.batch(stmts);
}

async function loadTaskRow(env: Env, workspaceId: string, taskId: string): Promise<TaskRow> {
  const row = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
  if (!row) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Task not found", { status: 404 });
  }
  const task = parseTaskRow(row);
  if (task.workspace_id !== workspaceId) {
    // Cross-workspace defense in depth: 404, not 403.
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Task not found", { status: 404 });
  }
  return task;
}

async function withTags(env: Env, row: TaskRow): Promise<Task> {
  const tags = (await fetchTagsFor(env, [row.id])).get(row.id) ?? [];
  return { ...row, tags };
}

async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Request body must be JSON", {
      status: 400,
    });
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return LIST_PAGE_SIZE;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "limit must be a positive integer", {
      status: 400,
    });
  }
  return Math.min(n, LIST_MAX_PAGE_SIZE);
}

function parseEpochQuery(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, `${name} must be epoch seconds`, {
      status: 400,
    });
  }
  return n;
}

export const tasksRoute = new Hono<AuthEnv>()
  // ---------- GET /tasks — list ----------
  .get("/tasks", async (c) => {
    const conditions = ["workspace_id = ?"];
    const binds: unknown[] = [c.var.workspace.id];

    const status = c.req.query("status");
    if (status !== undefined) {
      if (!TaskStatusSchema.safeParse(status).success) {
        throw new LoomwikiError(
          ErrorCodes.VALIDATION_FAILED,
          "status must be one of: backlog, todo, doing, done, cancelled",
          { status: 400 },
        );
      }
      conditions.push("status = ?");
      binds.push(status);
    }
    const room = c.req.query("room");
    if (room !== undefined) {
      conditions.push("room_id = ?");
      binds.push(room);
    }
    const assignee = c.req.query("assignee");
    if (assignee !== undefined) {
      conditions.push("assignee_id = ?");
      binds.push(assignee);
    }
    const tag = c.req.query("tag");
    if (tag !== undefined) {
      conditions.push("EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = tasks.id AND tt.tag = ?)");
      binds.push(tag);
    }
    const dueBefore = parseEpochQuery(c.req.query("due_before"), "due_before");
    if (dueBefore !== undefined) {
      conditions.push("due_at IS NOT NULL AND due_at < ?");
      binds.push(dueBefore);
    }
    const dueAfter = parseEpochQuery(c.req.query("due_after"), "due_after");
    if (dueAfter !== undefined) {
      conditions.push("due_at IS NOT NULL AND due_at >= ?");
      binds.push(dueAfter);
    }
    const before = c.req.query("before");
    if (before !== undefined) {
      conditions.push("id < ?");
      binds.push(before);
    }

    const limit = parseLimit(c.req.query("limit"));
    const fetched = limit + 1;
    binds.push(fetched);

    const rows = await c.env.DB.prepare(
      `SELECT * FROM tasks WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`,
    )
      .bind(...binds)
      .all();

    const parsed = rows.results.map(parseTaskRow);
    const hasMore = parsed.length > limit;
    const trimmed = hasMore ? parsed.slice(0, limit) : parsed;
    trimmed.reverse(); // oldest-first within the page (repo cursor convention)

    const tagMap = await fetchTagsFor(
      c.env,
      trimmed.map((t) => t.id),
    );
    const tasks: Task[] = trimmed.map((t) => ({ ...t, tags: tagMap.get(t.id) ?? [] }));

    return c.json(apiOk({ tasks, hasMore }));
  })

  // ---------- POST /tasks — create ----------
  .post("/tasks", async (c) => {
    const parsed = CreateTaskRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid request body", {
        status: 400,
        details: parsed.error.issues,
      });
    }
    const req = parsed.data;
    const roomId = req.room_id ?? null;
    if (roomId !== null) {
      await requireRoomInWorkspace(c.env, c.var.workspace.id, roomId);
    }
    await requireWriteAccess(c.env, c.var.user.id, roomId);
    const assigneeId = req.assignee_id ?? null;
    if (assigneeId !== null) {
      await requireUserExists(c.env, assigneeId);
    }

    const taskId = id();
    const nowS = Math.floor(Date.now() / 1000);
    const status = req.status ?? "todo";

    await c.env.DB.prepare(
      `INSERT INTO tasks
         (id, workspace_id, room_id, title, body, status, assignee_id, due_at,
          origin_message_id, created_by, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
      .bind(
        taskId,
        c.var.workspace.id,
        roomId,
        req.title,
        req.body ?? null,
        status,
        assigneeId,
        req.due_at ?? null,
        c.var.user.id,
        nowS,
        nowS,
        status === "done" ? nowS : null,
      )
      .run();

    if (req.tags !== undefined && req.tags.length > 0) {
      await replaceTags(c.env, taskId, req.tags);
    }

    const task = await withTags(c.env, await loadTaskRow(c.env, c.var.workspace.id, taskId));
    return c.json(apiOk({ task }), 201);
  })

  // ---------- GET /tasks/:id ----------
  .get("/tasks/:id", async (c) => {
    const task = await withTags(
      c.env,
      await loadTaskRow(c.env, c.var.workspace.id, c.req.param("id")),
    );
    return c.json(apiOk({ task }));
  })

  // ---------- PATCH /tasks/:id ----------
  .patch("/tasks/:id", async (c) => {
    const existing = await loadTaskRow(c.env, c.var.workspace.id, c.req.param("id"));
    await requireWriteAccess(c.env, c.var.user.id, existing.room_id);

    const parsed = PatchTaskRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid request body", {
        status: 400,
        details: parsed.error.issues,
      });
    }
    const patch = parsed.data;

    const newRoomId = patch.room_id !== undefined ? patch.room_id : existing.room_id;
    if (patch.room_id !== undefined && patch.room_id !== null) {
      await requireRoomInWorkspace(c.env, c.var.workspace.id, patch.room_id);
      await requireWriteAccess(c.env, c.var.user.id, patch.room_id);
    }
    const newAssignee = patch.assignee_id !== undefined ? patch.assignee_id : existing.assignee_id;
    if (patch.assignee_id !== undefined && patch.assignee_id !== null) {
      await requireUserExists(c.env, patch.assignee_id);
    }

    const nowS = Math.floor(Date.now() / 1000);
    const newStatus = patch.status ?? existing.status;
    let completedAt = existing.completed_at;
    if (patch.status !== undefined && patch.status !== existing.status) {
      completedAt = patch.status === "done" ? nowS : null;
    }

    await c.env.DB.prepare(
      `UPDATE tasks
       SET title = ?, body = ?, status = ?, room_id = ?, assignee_id = ?, due_at = ?,
           updated_at = ?, completed_at = ?
       WHERE id = ?`,
    )
      .bind(
        patch.title ?? existing.title,
        patch.body !== undefined ? patch.body : existing.body,
        newStatus,
        newRoomId,
        newAssignee,
        patch.due_at !== undefined ? patch.due_at : existing.due_at,
        nowS,
        completedAt,
        existing.id,
      )
      .run();

    if (patch.tags !== undefined) {
      await replaceTags(c.env, existing.id, patch.tags);
    }

    const task = await withTags(c.env, await loadTaskRow(c.env, c.var.workspace.id, existing.id));
    return c.json(apiOk({ task }));
  })

  // ---------- DELETE /tasks/:id ----------
  .delete("/tasks/:id", async (c) => {
    const existing = await loadTaskRow(c.env, c.var.workspace.id, c.req.param("id"));
    await requireWriteAccess(c.env, c.var.user.id, existing.room_id);
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM task_tags WHERE task_id = ?").bind(existing.id),
      c.env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(existing.id),
    ]);
    return c.json(apiOk({ deleted: true }));
  });
```

- [ ] **Step 4: Register the route in `apps/worker/src/index.ts`**

Add the import (alphabetical with the others): `import { tasksRoute } from "./routes/tasks.js";`
In the auth-middleware block, after the timeline line, add:

```ts
// v0.1 M9: tasks + events + calendar.
app.use("/api/tasks", authMiddleware);
app.use("/api/tasks/*", authMiddleware);
```

In the mount block, after the timeline mount: `app.route("/api", tasksRoute);`

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @loomwiki/worker exec vitest run src/__tests__/routes-tasks.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/routes/tasks.ts apps/worker/src/index.ts apps/worker/src/__tests__/routes-tasks.test.ts
git commit -m "feat(api): add task CRUD routes with filters and tags"
```

---

### Task 6: Events routes (`/api/events` + attendees)

**Files:**
- Create: `apps/worker/src/routes/events.ts`
- Modify: `apps/worker/src/index.ts` (auth middleware + mount)
- Test: `apps/worker/src/__tests__/routes-events.test.ts`

**Interfaces:**
- Consumes: Task 2 schemas; `requireWriteAccess` exported from `routes/tasks.js` (Task 5).
- Produces:
  - `GET /api/events?from=&to=&room=` → `{ events: EventWithAttendees[], hasMore: boolean }` — `from`/`to` required epoch seconds, `to > from`, range ≤ 92 days; overlap semantics `starts_at < to AND COALESCE(ends_at, starts_at) >= from`; excludes cancelled; ordered `starts_at ASC`; LIMIT 500.
  - `POST /api/events` → 201 `{ event: EventWithAttendees }`
  - `GET /api/events/:id` → `{ event }` (cancelled still readable)
  - `PATCH /api/events/:id` → `{ event }` (must keep `ends_at >= starts_at` across the merged result)
  - `DELETE /api/events/:id` → `{ event }` — **soft-cancel**: sets `cancelled_at`, idempotent
  - `POST /api/events/:id/attendees/:uid` → `{ event }` (idempotent add; 400 unknown user)
  - `DELETE /api/events/:id/attendees/:uid` → `{ event }` (idempotent remove)

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/__tests__/routes-events.test.ts` — same harness block as Task 5 (copy `beforeAll`/`beforeEach`/`authedFetch`/`bootstrapOwnerAndRoom`/`bootstrapSecondUser`). Test bodies:

```ts
interface EventShape {
  id: string;
  title: string;
  room_id: string | null;
  starts_at: number;
  ends_at: number | null;
  all_day: 0 | 1;
  cancelled_at: number | null;
  attendee_ids: string[];
}

const T0 = 1789344000; // 2026-09-14T00:00:00Z
const DAY = 86400;

async function createEvent(jwt: string, body: unknown): Promise<{ res: Response; event: EventShape }> {
  const res = await authedFetch(jwt, "/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as { ok: boolean; data?: { event: EventShape } };
  return { res, event: parsed.data?.event as EventShape };
}

describe("POST /api/events", () => {
  it("returns 401 without JWT", async () => {
    const res = await SELF.fetch("https://api.local/api/events", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("creates a timed event with attendees", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const bob = await bootstrapSecondUser("bob@example.com");
    const { res, event } = await createEvent(ownerJwt, {
      title: "Standup",
      starts_at: T0 + 9 * 3600,
      ends_at: T0 + 9 * 3600 + 1800,
      attendee_ids: [bob.userId],
    });
    expect(res.status).toBe(201);
    expect(event.all_day).toBe(0);
    expect(event.attendee_ids).toEqual([bob.userId]);
  });

  it("400s ends_at before starts_at and unknown attendees", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const bad1 = await createEvent(ownerJwt, { title: "x", starts_at: T0, ends_at: T0 - 1 });
    expect(bad1.res.status).toBe(400);
    const bad2 = await createEvent(ownerJwt, { title: "x", starts_at: T0, attendee_ids: [id()] });
    expect(bad2.res.status).toBe(400);
  });
});

describe("GET /api/events — range list", () => {
  it("requires from/to and rejects oversize ranges", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    expect((await authedFetch(ownerJwt, "/api/events")).status).toBe(400);
    const tooBig = await authedFetch(ownerJwt, `/api/events?from=${T0}&to=${T0 + 100 * DAY}`);
    expect(tooBig.status).toBe(400);
  });

  it("returns overlapping events only, excluding cancelled", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    await createEvent(ownerJwt, { title: "inside", starts_at: T0 + DAY });
    await createEvent(ownerJwt, {
      title: "straddles-start",
      starts_at: T0 - 3600,
      ends_at: T0 + 3600,
    });
    await createEvent(ownerJwt, { title: "outside", starts_at: T0 + 30 * DAY });
    const { event: cancelled } = await createEvent(ownerJwt, { title: "gone", starts_at: T0 + DAY });
    await authedFetch(ownerJwt, `/api/events/${cancelled.id}`, { method: "DELETE" });

    const res = await authedFetch(ownerJwt, `/api/events?from=${T0}&to=${T0 + 7 * DAY}`);
    const body = (await res.json()) as { data: { events: EventShape[] } };
    expect(body.data.events.map((e) => e.title)).toEqual(["straddles-start", "inside"]);
  });
});

describe("PATCH + DELETE + attendees", () => {
  it("soft-cancels on DELETE, idempotently; detail stays readable", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { event } = await createEvent(ownerJwt, { title: "x", starts_at: T0 });
    const del1 = await authedFetch(ownerJwt, `/api/events/${event.id}`, { method: "DELETE" });
    expect(del1.status).toBe(200);
    const del2 = await authedFetch(ownerJwt, `/api/events/${event.id}`, { method: "DELETE" });
    expect(del2.status).toBe(200);
    const detail = await authedFetch(ownerJwt, `/api/events/${event.id}`);
    const d = (await detail.json()) as { data: { event: EventShape } };
    expect(d.data.event.cancelled_at).not.toBeNull();
  });

  it("PATCH rejects a merged ends_at < starts_at", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const { event } = await createEvent(ownerJwt, { title: "x", starts_at: T0, ends_at: T0 + 3600 });
    const res = await authedFetch(ownerJwt, `/api/events/${event.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starts_at: T0 + 7200 }),
    });
    expect(res.status).toBe(400);
  });

  it("adds and removes attendees idempotently", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    const bob = await bootstrapSecondUser("bob@example.com");
    const { event } = await createEvent(ownerJwt, { title: "x", starts_at: T0 });

    const add = await authedFetch(ownerJwt, `/api/events/${event.id}/attendees/${bob.userId}`, {
      method: "POST",
    });
    expect(add.status).toBe(200);
    const addAgain = await authedFetch(ownerJwt, `/api/events/${event.id}/attendees/${bob.userId}`, {
      method: "POST",
    });
    const a = (await addAgain.json()) as { data: { event: EventShape } };
    expect(a.data.event.attendee_ids).toEqual([bob.userId]);

    const rm = await authedFetch(ownerJwt, `/api/events/${event.id}/attendees/${bob.userId}`, {
      method: "DELETE",
    });
    const r = (await rm.json()) as { data: { event: EventShape } };
    expect(r.data.event.attendee_ids).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @loomwiki/worker exec vitest run src/__tests__/routes-events.test.ts`
Expected: FAIL — no `/api/events` route.

- [ ] **Step 3: Implement the route**

Create `apps/worker/src/routes/events.ts`. Same structural skeleton as Task 5's `tasks.ts` — `readJsonBody` is duplicated locally (10 lines; route files in this repo are self-contained), and this file defines its own `requireEpochQuery` (from/to are mandatory here, unlike the optional epoch filters in tasks):

```ts
// SPDX-License-Identifier: Apache-2.0

// Event routes (v0.1 M9). Mounted at /api:
//   GET    /api/events                       — range list (from/to required)
//   POST   /api/events                       — create
//   GET    /api/events/:id                   — detail (cancelled readable)
//   PATCH  /api/events/:id                   — partial update
//   DELETE /api/events/:id                   — SOFT-cancel (sets cancelled_at)
//   POST   /api/events/:id/attendees/:uid    — add attendee (idempotent)
//   DELETE /api/events/:id/attendees/:uid    — remove attendee (idempotent)
//
// Access mirrors routes/tasks.ts: reads open to workspace members; writes on
// room-scoped events require membership with role != 'viewer'.

import {
  CreateEventRequestSchema,
  type EventRow,
  type EventWithAttendees,
  PatchEventRequestSchema,
} from "@loomwiki/schema";
import { parseEventRow } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, apiOk, id } from "@loomwiki/shared";
import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AuthEnv } from "../middleware/auth.js";
import { requireWriteAccess } from "./tasks.js";

const RANGE_MAX_S = 92 * 86400;
const LIST_LIMIT = 500;

async function requireRoomInWorkspace(env: Env, workspaceId: string, roomId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT workspace_id FROM rooms WHERE id = ?")
    .bind(roomId)
    .first<{ workspace_id: string }>();
  if (!row || row.workspace_id !== workspaceId) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Room not found", { status: 404 });
  }
}

async function requireUsersExist(env: Env, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const placeholders = userIds.map(() => "?").join(",");
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE id IN (${placeholders})`,
  )
    .bind(...userIds)
    .first<{ n: number }>();
  if ((row?.n ?? 0) !== new Set(userIds).size) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "attendee is not a workspace user", {
      status: 400,
    });
  }
}

async function fetchAttendees(env: Env, eventId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT user_id FROM event_attendees WHERE event_id = ? ORDER BY user_id",
  )
    .bind(eventId)
    .all<{ user_id: string }>();
  return rows.results.map((r) => r.user_id);
}

async function loadEventRow(env: Env, workspaceId: string, eventId: string): Promise<EventRow> {
  const row = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first();
  if (!row) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Event not found", { status: 404 });
  }
  const event = parseEventRow(row);
  if (event.workspace_id !== workspaceId) {
    throw new LoomwikiError(ErrorCodes.NOT_FOUND, "Event not found", { status: 404 });
  }
  return event;
}

async function withAttendees(env: Env, row: EventRow): Promise<EventWithAttendees> {
  return { ...row, attendee_ids: await fetchAttendees(env, row.id) };
}

async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Request body must be JSON", {
      status: 400,
    });
  }
}

function requireEpochQuery(raw: string | undefined, name: string): number {
  if (raw === undefined) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, `${name} is required (epoch seconds)`, {
      status: 400,
    });
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, `${name} must be epoch seconds`, {
      status: 400,
    });
  }
  return n;
}

export function validateRange(from: number, to: number): void {
  if (to <= from) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "to must be greater than from", {
      status: 400,
    });
  }
  if (to - from > RANGE_MAX_S) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "range must be 92 days or less", {
      status: 400,
    });
  }
}

export const eventsRoute = new Hono<AuthEnv>()
  // ---------- GET /events — range list ----------
  .get("/events", async (c) => {
    const from = requireEpochQuery(c.req.query("from"), "from");
    const to = requireEpochQuery(c.req.query("to"), "to");
    validateRange(from, to);

    const conditions = [
      "workspace_id = ?",
      "cancelled_at IS NULL",
      "starts_at < ?",
      "COALESCE(ends_at, starts_at) >= ?",
    ];
    const binds: unknown[] = [c.var.workspace.id, to, from];
    const room = c.req.query("room");
    if (room !== undefined) {
      conditions.push("room_id = ?");
      binds.push(room);
    }
    binds.push(LIST_LIMIT + 1);

    const rows = await c.env.DB.prepare(
      `SELECT * FROM events WHERE ${conditions.join(" AND ")} ORDER BY starts_at ASC, id ASC LIMIT ?`,
    )
      .bind(...binds)
      .all();
    const parsed = rows.results.map(parseEventRow);
    const hasMore = parsed.length > LIST_LIMIT;
    const trimmed = hasMore ? parsed.slice(0, LIST_LIMIT) : parsed;

    const events: EventWithAttendees[] = [];
    for (const row of trimmed) {
      events.push(await withAttendees(c.env, row));
    }
    return c.json(apiOk({ events, hasMore }));
  })

  // ---------- POST /events — create ----------
  .post("/events", async (c) => {
    const parsed = CreateEventRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid request body", {
        status: 400,
        details: parsed.error.issues,
      });
    }
    const req = parsed.data;
    const roomId = req.room_id ?? null;
    if (roomId !== null) {
      await requireRoomInWorkspace(c.env, c.var.workspace.id, roomId);
    }
    await requireWriteAccess(c.env, c.var.user.id, roomId);
    const attendees = req.attendee_ids ?? [];
    await requireUsersExist(c.env, attendees);

    const eventId = id();
    const nowS = Math.floor(Date.now() / 1000);

    await c.env.DB.prepare(
      `INSERT INTO events
         (id, workspace_id, room_id, title, body, starts_at, ends_at, all_day, rrule,
          origin_message_id, created_by, created_at, updated_at, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
    )
      .bind(
        eventId,
        c.var.workspace.id,
        roomId,
        req.title,
        req.body ?? null,
        req.starts_at,
        req.ends_at ?? null,
        req.all_day === true ? 1 : 0,
        c.var.user.id,
        nowS,
        nowS,
      )
      .run();

    if (attendees.length > 0) {
      await c.env.DB.batch(
        attendees.map((uid) =>
          c.env.DB.prepare(
            "INSERT OR IGNORE INTO event_attendees (event_id, user_id) VALUES (?, ?)",
          ).bind(eventId, uid),
        ),
      );
    }

    const event = await withAttendees(c.env, await loadEventRow(c.env, c.var.workspace.id, eventId));
    return c.json(apiOk({ event }), 201);
  })

  // ---------- GET /events/:id ----------
  .get("/events/:id", async (c) => {
    const event = await withAttendees(
      c.env,
      await loadEventRow(c.env, c.var.workspace.id, c.req.param("id")),
    );
    return c.json(apiOk({ event }));
  })

  // ---------- PATCH /events/:id ----------
  .patch("/events/:id", async (c) => {
    const existing = await loadEventRow(c.env, c.var.workspace.id, c.req.param("id"));
    await requireWriteAccess(c.env, c.var.user.id, existing.room_id);

    const parsed = PatchEventRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid request body", {
        status: 400,
        details: parsed.error.issues,
      });
    }
    const patch = parsed.data;

    const newRoomId = patch.room_id !== undefined ? patch.room_id : existing.room_id;
    if (patch.room_id !== undefined && patch.room_id !== null) {
      await requireRoomInWorkspace(c.env, c.var.workspace.id, patch.room_id);
      await requireWriteAccess(c.env, c.var.user.id, patch.room_id);
    }

    const newStarts = patch.starts_at ?? existing.starts_at;
    const newEnds = patch.ends_at !== undefined ? patch.ends_at : existing.ends_at;
    if (newEnds !== null && newEnds < newStarts) {
      throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "ends_at must be >= starts_at", {
        status: 400,
      });
    }

    const nowS = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `UPDATE events
       SET title = ?, body = ?, room_id = ?, starts_at = ?, ends_at = ?, all_day = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        patch.title ?? existing.title,
        patch.body !== undefined ? patch.body : existing.body,
        newRoomId,
        newStarts,
        newEnds,
        patch.all_day !== undefined ? (patch.all_day ? 1 : 0) : existing.all_day,
        nowS,
        existing.id,
      )
      .run();

    const event = await withAttendees(c.env, await loadEventRow(c.env, c.var.workspace.id, existing.id));
    return c.json(apiOk({ event }));
  })

  // ---------- DELETE /events/:id — soft-cancel ----------
  .delete("/events/:id", async (c) => {
    const existing = await loadEventRow(c.env, c.var.workspace.id, c.req.param("id"));
    await requireWriteAccess(c.env, c.var.user.id, existing.room_id);
    if (existing.cancelled_at === null) {
      const nowS = Math.floor(Date.now() / 1000);
      await c.env.DB.prepare("UPDATE events SET cancelled_at = ?, updated_at = ? WHERE id = ?")
        .bind(nowS, nowS, existing.id)
        .run();
    }
    const event = await withAttendees(c.env, await loadEventRow(c.env, c.var.workspace.id, existing.id));
    return c.json(apiOk({ event }));
  })

  // ---------- POST /events/:id/attendees/:uid ----------
  .post("/events/:id/attendees/:uid", async (c) => {
    const existing = await loadEventRow(c.env, c.var.workspace.id, c.req.param("id"));
    await requireWriteAccess(c.env, c.var.user.id, existing.room_id);
    const uid = c.req.param("uid");
    await requireUsersExist(c.env, [uid]);
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO event_attendees (event_id, user_id) VALUES (?, ?)",
    )
      .bind(existing.id, uid)
      .run();
    const event = await withAttendees(c.env, existing);
    return c.json(apiOk({ event }));
  })

  // ---------- DELETE /events/:id/attendees/:uid ----------
  .delete("/events/:id/attendees/:uid", async (c) => {
    const existing = await loadEventRow(c.env, c.var.workspace.id, c.req.param("id"));
    await requireWriteAccess(c.env, c.var.user.id, existing.room_id);
    await c.env.DB.prepare("DELETE FROM event_attendees WHERE event_id = ? AND user_id = ?")
      .bind(existing.id, c.req.param("uid"))
      .run();
    const event = await withAttendees(c.env, existing);
    return c.json(apiOk({ event }));
  });
```

- [ ] **Step 4: Register in `apps/worker/src/index.ts`**

Import `eventsRoute`, add `app.use("/api/events", authMiddleware); app.use("/api/events/*", authMiddleware);` next to the tasks lines, and `app.route("/api", eventsRoute);` next to the tasks mount.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @loomwiki/worker exec vitest run src/__tests__/routes-events.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/routes/events.ts apps/worker/src/index.ts apps/worker/src/__tests__/routes-events.test.ts
git commit -m "feat(api): add event CRUD + attendee routes with soft-cancel"
```

---

### Task 7: Calendar union route (`GET /api/calendar`)

**Files:**
- Create: `apps/worker/src/routes/calendar.ts`
- Modify: `apps/worker/src/index.ts`
- Test: `apps/worker/src/__tests__/routes-calendar.test.ts`

**Interfaces:**
- Consumes: `CalendarEntry`/`CalendarEventEntry`/`CalendarTaskEntry` types (Task 2), `validateRange` from `routes/events.js` (Task 6).
- Produces: `GET /api/calendar?from=&to=&room=&user=` → `ApiResult<CalendarResponse>` (`{ entries, from, to }`). Entries sorted ascending by instant (event `starts_at` / task `due_at`), ties by `id`. Tasks appear regardless of status (the entry carries `status` for styling); cancelled events excluded; `user=` filters to items the user is assigned to / attending / created.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/__tests__/routes-calendar.test.ts` — same harness + `createTask`/`createEvent` helpers from Tasks 5/6 (copy them in; each test file is self-contained by repo convention):

```ts
const T0 = 1789344000; // 2026-09-14T00:00:00Z
const DAY = 86400;

describe("GET /api/calendar", () => {
  it("returns 401 without JWT and 400 without range", async () => {
    expect((await SELF.fetch("https://api.local/api/calendar")).status).toBe(401);
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    expect((await authedFetch(ownerJwt, "/api/calendar")).status).toBe(400);
  });

  it("unions events and due tasks sorted by instant", async () => {
    const { ownerJwt } = await bootstrapOwnerAndRoom();
    await createEvent(ownerJwt, { title: "release", starts_at: T0 + 2 * DAY });
    await createTask(ownerJwt, { title: "prep notes", due_at: T0 + 1 * DAY });
    await createTask(ownerJwt, { title: "no due date" });

    const res = await authedFetch(ownerJwt, `/api/calendar?from=${T0}&to=${T0 + 7 * DAY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ kind: string; title: string }> };
    };
    expect(body.data.entries.map((e) => `${e.kind}:${e.title}`)).toEqual([
      "task_due:prep notes",
      "event:release",
    ]);
  });

  it("filters by room and by user", async () => {
    const { ownerJwt, roomId } = await bootstrapOwnerAndRoom();
    const bob = await bootstrapSecondUser("bob@example.com");
    await createTask(ownerJwt, { title: "room task", room_id: roomId, due_at: T0 + DAY });
    await createTask(ownerJwt, { title: "bob task", assignee_id: bob.userId, due_at: T0 + DAY });
    await createEvent(ownerJwt, {
      title: "bob event",
      starts_at: T0 + DAY,
      attendee_ids: [bob.userId],
    });

    const byRoom = await authedFetch(
      ownerJwt,
      `/api/calendar?from=${T0}&to=${T0 + 7 * DAY}&room=${roomId}`,
    );
    const r = (await byRoom.json()) as { data: { entries: Array<{ title: string }> } };
    expect(r.data.entries.map((e) => e.title)).toEqual(["room task"]);

    const byUser = await authedFetch(
      ownerJwt,
      `/api/calendar?from=${T0}&to=${T0 + 7 * DAY}&user=${bob.userId}`,
    );
    const u = (await byUser.json()) as { data: { entries: Array<{ title: string }> } };
    expect(u.data.entries.map((e) => e.title).sort()).toEqual(["bob event", "bob task"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @loomwiki/worker exec vitest run src/__tests__/routes-calendar.test.ts`
Expected: FAIL — no route.

- [ ] **Step 3: Implement the route**

Create `apps/worker/src/routes/calendar.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

// Calendar union route (v0.1 M9). Mounted at /api:
//   GET /api/calendar?from=&to=&room=&user=
//
// Query-time union of non-cancelled events overlapping [from, to) and tasks
// with due_at in [from, to) — tasks of every status (the entry carries
// `status` so the UI can style done/cancelled). No pagination: the range cap
// (92 days) bounds the result set; the calendar UI always queries one grid.

import type { CalendarEntry } from "@loomwiki/schema";
import { parseEventRow, parseTaskRow } from "@loomwiki/schema/parsers";
import { LoomwikiError, ErrorCodes, apiOk } from "@loomwiki/shared";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";
import { validateRange } from "./events.js";

function requireEpochQuery(raw: string | undefined, name: string): number {
  if (raw === undefined) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, `${name} is required (epoch seconds)`, {
      status: 400,
    });
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, `${name} must be epoch seconds`, {
      status: 400,
    });
  }
  return n;
}

function entryInstant(e: CalendarEntry): number {
  return e.kind === "event" ? e.starts_at : e.due_at;
}

export const calendarRoute = new Hono<AuthEnv>().get("/calendar", async (c) => {
  const from = requireEpochQuery(c.req.query("from"), "from");
  const to = requireEpochQuery(c.req.query("to"), "to");
  validateRange(from, to);
  const room = c.req.query("room");
  const user = c.req.query("user");

  // Events overlapping the window.
  const eventConds = [
    "workspace_id = ?",
    "cancelled_at IS NULL",
    "starts_at < ?",
    "COALESCE(ends_at, starts_at) >= ?",
  ];
  const eventBinds: unknown[] = [c.var.workspace.id, to, from];
  if (room !== undefined) {
    eventConds.push("room_id = ?");
    eventBinds.push(room);
  }
  if (user !== undefined) {
    eventConds.push(
      "(created_by = ? OR EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_id = events.id AND ea.user_id = ?))",
    );
    eventBinds.push(user, user);
  }
  const eventRows = await c.env.DB.prepare(
    `SELECT * FROM events WHERE ${eventConds.join(" AND ")} ORDER BY starts_at ASC`,
  )
    .bind(...eventBinds)
    .all();

  // Tasks with a due date inside the window.
  const taskConds = ["workspace_id = ?", "due_at IS NOT NULL", "due_at >= ?", "due_at < ?"];
  const taskBinds: unknown[] = [c.var.workspace.id, from, to];
  if (room !== undefined) {
    taskConds.push("room_id = ?");
    taskBinds.push(room);
  }
  if (user !== undefined) {
    taskConds.push("(assignee_id = ? OR created_by = ?)");
    taskBinds.push(user, user);
  }
  const taskRows = await c.env.DB.prepare(
    `SELECT * FROM tasks WHERE ${taskConds.join(" AND ")} ORDER BY due_at ASC`,
  )
    .bind(...taskBinds)
    .all();

  const entries: CalendarEntry[] = [
    ...eventRows.results.map(parseEventRow).map(
      (e): CalendarEntry => ({
        kind: "event",
        id: e.id,
        title: e.title,
        room_id: e.room_id,
        starts_at: e.starts_at,
        ends_at: e.ends_at,
        all_day: e.all_day,
      }),
    ),
    ...taskRows.results.map(parseTaskRow).map(
      (t): CalendarEntry => ({
        kind: "task_due",
        id: t.id,
        title: t.title,
        status: t.status,
        room_id: t.room_id,
        assignee_id: t.assignee_id,
        // due_at is non-null by the WHERE clause; assert for the type system.
        due_at: t.due_at ?? 0,
      }),
    ),
  ];
  entries.sort((a, b) => entryInstant(a) - entryInstant(b) || (a.id < b.id ? -1 : 1));

  return c.json(apiOk({ entries, from, to }));
});
```

- [ ] **Step 4: Register in `apps/worker/src/index.ts`**

Import `calendarRoute`, add `app.use("/api/calendar", authMiddleware);` and `app.route("/api", calendarRoute);` alongside the tasks/events lines.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @loomwiki/worker exec vitest run src/__tests__/routes-calendar.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/routes/calendar.ts apps/worker/src/index.ts apps/worker/src/__tests__/routes-calendar.test.ts
git commit -m "feat(api): add calendar union route over events and due tasks"
```

---

### Task 8: ChatRoom DO slash commands (`/task`, `/event`, `/done`)

**Files:**
- Create: `apps/worker/src/lib/slash-exec.ts`
- Modify: `apps/worker/src/do/ChatRoom.ts`
- Test: `apps/worker/src/__tests__/chat-room-slash.test.ts`

**Interfaces:**
- Consumes: `parseSlashCommand`/`SlashCommand`/`SlashParseResult` (Task 3, from `@loomwiki/shared`); tables from Task 1.
- Produces: chat behavior — a `send` whose body parses as a known command is persisted as a normal message (it becomes the task/event's `origin_message_id`), then the command executes against D1, then a confirmation message is broadcast to the whole room via the existing system-message machinery. Failures are sent to the sender only as WS `error` envelopes (deliberate delta from the design doc's "system-message error" — sender-only errors avoid room noise and are still not a silent drop).

Flow inside the DO (`handleSend`): length check → rate limit → `parseSlashCommand`. `{ matched: false }` (including `/ask` and unknown `/foo`) falls through to the normal message path unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/__tests__/chat-room-slash.test.ts`. Copy the harness from `chat-room.test.ts` verbatim: the imports (`SELF, env, runInDurableObject` from `cloudflare:test`, `PROTOCOL_VERSION` from `@loomwiki/shared`, the `db`/`jwt`/`ws` fixtures), `beforeAll`/`beforeEach`, the `openSessions`/`track` cleanup block, and the `bootstrapMember` + `joinAsMember` helpers. Then add:

```ts
import type { ServerMsg } from "@loomwiki/shared";

async function connect(roomId: string, jwt: string): Promise<WsSession> {
  const ws = await track(await openWs(roomId, jwt));
  ws.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION });
  const welcome = await ws.next();
  expect(welcome.kind).toBe("welcome");
  return ws;
}

/** Send a slash command and consume the happy-path frame pair (ack, note). */
async function sendAndSettle(
  ws: WsSession,
  tempId: string,
  body: string,
): Promise<{ ack: ServerMsg; note: ServerMsg }> {
  ws.send({ kind: "send", tempId, body });
  const ack = await ws.next();
  const note = await ws.next();
  return { ack, note };
}

describe("ChatRoom slash commands", () => {
  it("/task creates a D1 task with chat provenance and confirms in-room", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await connect(alice.roomId, alice.jwt);

    const { ack, note } = await sendAndSettle(ws, "t1", "/task Fix login bug due:2026-07-20");
    expect(ack.kind).toBe("ack");
    if (ack.kind !== "ack") throw new Error("unreachable");
    expect(note.kind).toBe("message");
    if (note.kind !== "message") throw new Error("unreachable");
    expect(note.message.body).toContain('created task "Fix login bug"');

    const row = await env.DB.prepare("SELECT * FROM tasks").first<{
      title: string;
      status: string;
      room_id: string;
      due_at: number;
      origin_message_id: string;
      created_by: string;
    }>();
    expect(row?.title).toBe("Fix login bug");
    expect(row?.status).toBe("todo");
    expect(row?.room_id).toBe(alice.roomId);
    expect(row?.due_at).toBe(Date.parse("2026-07-20T00:00:00Z") / 1000);
    expect(row?.origin_message_id).toBe(ack.messageId);
    expect(row?.created_by).toBe(alice.userId);
  });

  it("resolves @assignee by email local-part among room members", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const bobJwt = await fixture.mint({ email: "bob@example.com" });
    const bobId = await joinAsMember(bobJwt, alice.roomId);
    const ws = await connect(alice.roomId, alice.jwt);

    const { note } = await sendAndSettle(ws, "t1", "/task Review PR @bob");
    expect(note.kind).toBe("message");
    const row = await env.DB.prepare("SELECT assignee_id FROM tasks").first<{
      assignee_id: string;
    }>();
    expect(row?.assignee_id).toBe(bobId);
  });

  it("unknown @assignee → sender-only error, no task, no message persisted", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await connect(alice.roomId, alice.jwt);

    ws.send({ kind: "send", tempId: "t1", body: "/task x @nobody" });
    const ack = await ws.next();
    expect(ack.kind).toBe("ack"); // command message itself persists (provenance)
    const err = await ws.next();
    expect(err.kind).toBe("error");

    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("bad syntax → error envelope with tempId, nothing persisted at all", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await connect(alice.roomId, alice.jwt);

    ws.send({ kind: "send", tempId: "t9", body: "/task" });
    const err = await ws.next();
    expect(err.kind).toBe("error");
    if (err.kind !== "error") throw new Error("unreachable");
    expect(err.tempId).toBe("t9");

    const stubId = env.CHAT_ROOM.idFromName(alice.roomId);
    const stub = env.CHAT_ROOM.get(stubId);
    const count = await runInDurableObject(stub, (instance: ChatRoom) =>
      instance.localMessageCount(),
    );
    expect(count).toBe(0);
  });

  it("/event creates an all-day event; timed variant sets ends via duration", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await connect(alice.roomId, alice.jwt);

    await sendAndSettle(ws, "t1", "/event Team offsite 2026-07-24");
    await sendAndSettle(ws, "t2", "/event Standup 2026-07-24 09:30 +30m");

    const rows = await env.DB.prepare("SELECT title, starts_at, ends_at, all_day FROM events ORDER BY starts_at").all<{
      title: string;
      starts_at: number;
      ends_at: number | null;
      all_day: number;
    }>();
    const offsite = rows.results[0];
    const standup = rows.results[1];
    expect(offsite?.title).toBe("Team offsite");
    expect(offsite?.all_day).toBe(1);
    expect(offsite?.starts_at).toBe(Date.parse("2026-07-24T00:00:00Z") / 1000);
    expect(standup?.all_day).toBe(0);
    expect(standup?.starts_at).toBe(Date.parse("2026-07-24T09:30:00Z") / 1000);
    expect(standup?.ends_at).toBe(Date.parse("2026-07-24T10:00:00Z") / 1000);
  });

  it("/done closes the unique open title match; ambiguity errors", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await connect(alice.roomId, alice.jwt);

    await sendAndSettle(ws, "t1", "/task Unique thing");
    const { note } = await sendAndSettle(ws, "t2", "/done unique THING");
    expect(note.kind).toBe("message");
    if (note.kind !== "message") throw new Error("unreachable");
    expect(note.message.body).toContain("done");
    const row = await env.DB.prepare(
      "SELECT status, completed_at FROM tasks WHERE title = 'Unique thing'",
    ).first<{ status: string; completed_at: number | null }>();
    expect(row?.status).toBe("done");
    expect(row?.completed_at).not.toBeNull();

    await sendAndSettle(ws, "t3", "/task Dup");
    await sendAndSettle(ws, "t4", "/task Dup");
    ws.send({ kind: "send", tempId: "t5", body: "/done Dup" });
    await ws.next(); // ack for the command message
    const err = await ws.next();
    expect(err.kind).toBe("error");
  });

  it("unknown slash commands pass through as normal messages", async () => {
    const alice = await bootstrapMember("alice@example.com", "general");
    const ws = await connect(alice.roomId, alice.jwt);

    ws.send({ kind: "send", tempId: "t1", body: "/ask what did we decide?" });
    const ack = await ws.next();
    expect(ack.kind).toBe("ack");

    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @loomwiki/worker exec vitest run src/__tests__/chat-room-slash.test.ts`
Expected: FAIL — `/task …` is treated as a normal message, so the "note" frame never arrives (test times out or the tasks-table assertion finds 0 rows).

- [ ] **Step 3: Implement `apps/worker/src/lib/slash-exec.ts`**

```ts
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
    const endsAt =
      cmd.durationMinutes !== null ? startsAt + cmd.durationMinutes * 60 : null;
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
```

- [ ] **Step 4: Wire the DO (`apps/worker/src/do/ChatRoom.ts`)**

Three edits, all shown in full:

**(a)** Extend the imports:

```ts
import {
  type ClientMsg,
  ClientMsgSchema,
  ErrorCodes,
  MAX_BODY_CHARS,
  PROTOCOL_VERSION,
  type ServerMsg,
  type SlashParseResult,
  type WireMessage,
  id,
  parseSlashCommand,
} from "@loomwiki/shared";
import { type SlashContext, execSlashCommand } from "../lib/slash-exec.js";
```

**(b)** Refactor `handleSend` so the persist+ack+broadcast+mirror block is reusable, and gate on the parser. Replace the current `handleSend` with:

```ts
  private async handleSend(
    ws: WebSocket,
    attachment: WsAttachment,
    env: { tempId: string; body: string; parentId?: string },
  ): Promise<void> {
    if (env.body.length > MAX_BODY_CHARS) {
      sendError(ws, ErrorCodes.VALIDATION_FAILED, "body exceeds 4096 chars", env.tempId);
      return;
    }
    if (!this.limiter.tryAcquire((this._nowFn ?? Date.now.bind(Date))())) {
      sendError(ws, ErrorCodes.RATE_LIMITED, "100 msg/sec/room cap reached", env.tempId);
      return;
    }

    // v0.1 M9: deterministic slash commands. { matched: false } (including
    // /ask and unknown /foo) falls through to the normal message path.
    const slash = parseSlashCommand(env.body);
    if (slash.matched) {
      await this.handleSlash(ws, attachment, env, slash);
      return;
    }

    await this.persistUserMessage(ws, attachment, env);
  }

  /**
   * Durable-write + ack + broadcast + mirror for a user-authored message.
   * Extracted from handleSend so slash commands can persist their invoking
   * message (it becomes tasks/events.origin_message_id). Returns the new
   * message id.
   */
  private async persistUserMessage(
    ws: WebSocket,
    attachment: WsAttachment,
    env: { tempId: string; body: string; parentId?: string },
  ): Promise<string> {
    const messageId = id();
    const createdAt = Math.floor(Date.now() / 1000);
    const parentId = env.parentId ?? null;

    let wireMessage: WireMessage | null = null;

    // Insert + ack must be atomic. blockConcurrencyWhile prevents a
    // checkpoint from landing between durable write and ack — SPEC §9
    // acceptance criterion ("crashing the DO mid-write does not lose
    // acknowledged messages").
    await this.ctx.blockConcurrencyWhile(async () => {
      appendMessage(this.sql, {
        id: messageId,
        userId: attachment.userId,
        body: env.body,
        parentId,
        createdAt,
        pendingMirror: true,
      });
      sendServer(ws, { kind: "ack", tempId: env.tempId, messageId });
      wireMessage = {
        id: messageId,
        room_id: attachment.roomId,
        user_id: attachment.userId,
        body: env.body,
        parent_id: parentId,
        created_at: createdAt,
        edited_at: null,
        deleted_at: null,
      };
    });

    if (wireMessage) {
      this.broadcastExcept(ws, { kind: "message", message: wireMessage });
      // D1 mirror: best-effort, off the ack critical path.
      this.scheduleMirror({
        id: messageId,
        roomId: attachment.roomId,
        userId: attachment.userId,
        body: env.body,
        parentId,
        createdAt,
        editedAt: null,
        deletedAt: null,
      });
    }

    return messageId;
  }

  private async handleSlash(
    ws: WebSocket,
    attachment: WsAttachment,
    env: { tempId: string; body: string; parentId?: string },
    slash: SlashParseResult & { matched: true },
  ): Promise<void> {
    if (!slash.ok) {
      // Sender-only feedback; the malformed command is never persisted.
      sendError(ws, ErrorCodes.VALIDATION_FAILED, slash.error, env.tempId);
      return;
    }

    // The invoking message persists first — it is the provenance record
    // (tasks/events.origin_message_id) and the room sees what was typed.
    const originMessageId = await this.persistUserMessage(ws, attachment, env);

    const wsRow = await this.env.DB.prepare("SELECT workspace_id FROM rooms WHERE id = ?")
      .bind(attachment.roomId)
      .first<{ workspace_id: string }>();
    if (!wsRow) {
      // The route layer validated the room before the upgrade; a miss here
      // means D1 drift. Fail loudly to the sender, keep the room quiet.
      sendError(ws, ErrorCodes.INTERNAL_ERROR, "room not found in D1");
      return;
    }

    const ctx: SlashContext = {
      db: this.env.DB,
      workspaceId: wsRow.workspace_id,
      roomId: attachment.roomId,
      userId: attachment.userId,
      originMessageId,
      nowS: Math.floor(Date.now() / 1000),
    };
    const result = await execSlashCommand(ctx, slash.command);
    if (result.ok) {
      await this.injectMessage(attachment.userId, attachment.roomId, result.note);
    } else {
      // No tempId — the invoking message was already acked.
      sendError(ws, ErrorCodes.VALIDATION_FAILED, result.error);
    }
  }
```

**(c)** Extract the persistence core of `handleSysPost` into a reusable method, and have both callers use it. Add this method and shrink `handleSysPost`'s body to validation + a call to it:

```ts
  /**
   * Append + broadcast(ALL) + mirror a message authored on someone's behalf
   * (scheduled-actions tick, slash-command confirmations). Extracted from
   * handleSysPost so in-DO callers skip the internal HTTP hop.
   */
  private async injectMessage(userId: string, roomId: string, body: string): Promise<void> {
    const messageId = id();
    const createdAt = Math.floor(Date.now() / 1000);

    setRoomId(this.sql, roomId);

    let wireMessage: WireMessage | null = null;
    await this.ctx.blockConcurrencyWhile(async () => {
      appendMessage(this.sql, {
        id: messageId,
        userId,
        body,
        parentId: null,
        createdAt,
        pendingMirror: true,
      });
      wireMessage = {
        id: messageId,
        room_id: roomId,
        user_id: userId,
        body,
        parent_id: null,
        created_at: createdAt,
        edited_at: null,
        deleted_at: null,
      };
    });

    if (wireMessage) {
      this.broadcastAll({ kind: "message", message: wireMessage });
      this.scheduleMirror({
        id: messageId,
        roomId,
        userId,
        body,
        parentId: null,
        createdAt,
        editedAt: null,
        deletedAt: null,
      });
    }
  }
```

Then replace everything in `handleSysPost` from `const messageId = id();` down to (but not including) `return Response.json({ ok: true });` with:

```ts
    await this.injectMessage(payload.userId, payload.roomId, payload.body);
```

(Note: `injectMessage` does not honor `parentId` — the only existing sys-post caller, the scheduled-actions tick, always sends top-level messages. If `chat-room-sys-message.test.ts` exercises `parentId`, keep a `parentId: string | null = null` parameter on `injectMessage` and thread it through instead.)

- [ ] **Step 5: Run the new tests + both existing DO suites**

Run: `pnpm --filter @loomwiki/worker exec vitest run src/__tests__/chat-room-slash.test.ts src/__tests__/chat-room.test.ts src/__tests__/chat-room-sys-message.test.ts src/__tests__/chat-room-atomicity.test.ts`
Expected: PASS — new suite green, zero regressions in the refactored paths.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/lib/slash-exec.ts apps/worker/src/do/ChatRoom.ts apps/worker/src/__tests__/chat-room-slash.test.ts
git commit -m "feat(do): add /task /event /done slash commands to ChatRoom"
```

---

### Task 9: Web API client modules

**Files:**
- Modify: `apps/web/src/lib/api.ts` (add `apiPatch`)
- Create: `apps/web/src/lib/api-tasks.ts`, `apps/web/src/lib/api-calendar.ts`
- Test: `apps/web/src/lib/api-tasks.test.ts`, `apps/web/src/lib/api-calendar.test.ts`

**Interfaces:**
- Consumes: `request`/`apiGet`/`apiPost`/`apiDelete` (existing), Task 2 types.
- Produces (used by Tasks 10–11): `listTasks(filters)`, `createTask(body)`, `patchTask(id, body)`, `deleteTask(id)`, `TasksListPayload`, `TaskPayload`, `TaskFilters`; `getCalendar(from, to, opts)`, `createEvent(body)`, `patchEvent(id, body)`, `cancelEvent(id)`, `addAttendee(eventId, userId)`, `removeAttendee(eventId, userId)`, `listMembers(workspaceId)`.

- [ ] **Step 1: Write the failing tests**

Before writing them, open one existing sibling (`apps/web/src/lib/api-wiki.test.ts`) and mirror its fetch-stubbing setup exactly (vitest env + how it fakes `fetch`). The tests below assume a plain `vi.stubGlobal`; adjust mechanics to match the sibling if it differs — assertions stay the same.

`apps/web/src/lib/api-tasks.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTasksQuery, createTask, listTasks, patchTask } from "./api-tasks";

function stubFetch(data: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => Response.json({ ok: true, data }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildTasksQuery", () => {
  it("serializes only the provided filters", () => {
    expect(buildTasksQuery({})).toBe("");
    expect(buildTasksQuery({ status: "done", tag: "bug", limit: 200 })).toBe(
      "?status=done&tag=bug&limit=200",
    );
  });
});

describe("api-tasks", () => {
  it("listTasks GETs /api/tasks with filters", async () => {
    const mock = stubFetch({ tasks: [], hasMore: false });
    await listTasks({ status: "doing" });
    expect(mock).toHaveBeenCalledWith("/api/tasks?status=doing", expect.objectContaining({ method: "GET" }));
  });

  it("createTask POSTs and patchTask PATCHes", async () => {
    const mock = stubFetch({ task: { id: "x" } });
    await createTask({ title: "t" });
    expect(mock).toHaveBeenCalledWith("/api/tasks", expect.objectContaining({ method: "POST" }));
    await patchTask("abc", { status: "done" });
    expect(mock).toHaveBeenCalledWith("/api/tasks/abc", expect.objectContaining({ method: "PATCH" }));
  });
});
```

`apps/web/src/lib/api-calendar.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelEvent, getCalendar } from "./api-calendar";

function stubFetch(data: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => Response.json({ ok: true, data }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api-calendar", () => {
  it("getCalendar GETs the range with optional filters", async () => {
    const mock = stubFetch({ entries: [], from: 1, to: 2 });
    await getCalendar(1, 2, { room: "r1" });
    expect(mock).toHaveBeenCalledWith(
      "/api/calendar?from=1&to=2&room=r1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("cancelEvent DELETEs the event", async () => {
    const mock = stubFetch({ event: { id: "e1" } });
    await cancelEvent("e1");
    expect(mock).toHaveBeenCalledWith("/api/events/e1", expect.objectContaining({ method: "DELETE" }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @loomwiki/web exec vitest run src/lib/api-tasks.test.ts src/lib/api-calendar.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Add to `apps/web/src/lib/api.ts` (next to `apiPost`):

```ts
export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body });
}
```

Create `apps/web/src/lib/api-tasks.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

// Typed client for /api/tasks (v0.1 M9). Payload shapes mirror the worker's
// route responses; types come from @loomwiki/schema so worker and web can't
// drift.

import type { CreateTaskRequest, PatchTaskRequest, Task, TaskStatus } from "@loomwiki/schema";
import { apiDelete, apiGet, apiPatch, apiPost } from "./api";

export interface TasksListPayload {
  tasks: Task[];
  hasMore: boolean;
}

export interface TaskPayload {
  task: Task;
}

export interface TaskFilters {
  status?: TaskStatus;
  room?: string;
  assignee?: string;
  tag?: string;
  before?: string;
  limit?: number;
}

export function buildTasksQuery(f: TaskFilters): string {
  const p = new URLSearchParams();
  if (f.status !== undefined) p.set("status", f.status);
  if (f.room !== undefined) p.set("room", f.room);
  if (f.assignee !== undefined) p.set("assignee", f.assignee);
  if (f.tag !== undefined) p.set("tag", f.tag);
  if (f.before !== undefined) p.set("before", f.before);
  if (f.limit !== undefined) p.set("limit", String(f.limit));
  const s = p.toString();
  return s.length > 0 ? `?${s}` : "";
}

export function listTasks(f: TaskFilters = {}): Promise<TasksListPayload> {
  return apiGet(`/api/tasks${buildTasksQuery(f)}`);
}

export function createTask(body: CreateTaskRequest): Promise<TaskPayload> {
  return apiPost("/api/tasks", body);
}

export function patchTask(taskId: string, body: PatchTaskRequest): Promise<TaskPayload> {
  return apiPatch(`/api/tasks/${taskId}`, body);
}

export function deleteTask(taskId: string): Promise<{ deleted: true }> {
  return apiDelete(`/api/tasks/${taskId}`);
}
```

Create `apps/web/src/lib/api-calendar.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

// Typed client for /api/calendar, /api/events, and the workspace members
// list (v0.1 M9).

import type {
  CalendarResponse,
  CreateEventRequest,
  EventWithAttendees,
  MemberSummary,
  PatchEventRequest,
} from "@loomwiki/schema";
import { apiDelete, apiGet, apiPatch, apiPost } from "./api";

export interface EventPayload {
  event: EventWithAttendees;
}

export interface MembersPayload {
  members: MemberSummary[];
}

export function getCalendar(
  from: number,
  to: number,
  opts: { room?: string; user?: string } = {},
): Promise<CalendarResponse> {
  const p = new URLSearchParams({ from: String(from), to: String(to) });
  if (opts.room !== undefined) p.set("room", opts.room);
  if (opts.user !== undefined) p.set("user", opts.user);
  return apiGet(`/api/calendar?${p.toString()}`);
}

export function createEvent(body: CreateEventRequest): Promise<EventPayload> {
  return apiPost("/api/events", body);
}

export function patchEvent(eventId: string, body: PatchEventRequest): Promise<EventPayload> {
  return apiPatch(`/api/events/${eventId}`, body);
}

/** DELETE /api/events/:id is a soft-cancel (sets cancelled_at). */
export function cancelEvent(eventId: string): Promise<EventPayload> {
  return apiDelete(`/api/events/${eventId}`);
}

export function addAttendee(eventId: string, userId: string): Promise<EventPayload> {
  return apiPost(`/api/events/${eventId}/attendees/${userId}`);
}

export function removeAttendee(eventId: string, userId: string): Promise<EventPayload> {
  return apiDelete(`/api/events/${eventId}/attendees/${userId}`);
}

export function listMembers(workspaceId: string): Promise<MembersPayload> {
  return apiGet(`/api/workspaces/${workspaceId}/members`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @loomwiki/web exec vitest run src/lib/api-tasks.test.ts src/lib/api-calendar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/api-tasks.ts apps/web/src/lib/api-calendar.ts apps/web/src/lib/api-tasks.test.ts apps/web/src/lib/api-calendar.test.ts
git commit -m "feat(web): add tasks + calendar api clients and apiPatch"
```

---

### Task 10: Date helpers + kanban board page (`/tasks`)

**Files:**
- Create: `apps/web/src/lib/calendar-dates.ts`
- Create: `apps/web/src/components/tasks/KanbanBoard.tsx`, `apps/web/src/components/tasks/TaskCard.tsx`
- Create: `apps/web/src/pages/tasks.astro`
- Test: `apps/web/src/lib/calendar-dates.test.ts`, `apps/web/src/components/tasks/KanbanBoard.test.tsx`

**Interfaces:**
- Consumes: Task 9 clients; `TASK_BOARD_STATUSES`, `Task`, `MemberSummary` from `@loomwiki/schema`; `ssrApiGet` + `AppShell`/`Layout` (mirror `timeline.astro`).
- Produces: `utcDateIso`, `localDateIso`, `entryDayIso`, `localTimeLabel`, `monthGrid`, `addMonths`, `gridRangeEpochs`, `monthLabel`, `formStartsAt` (all consumed by Task 11); `<KanbanBoard initialTasks members rooms currentUserId />`.

- [ ] **Step 1: Write the failing date-helper test**

Create `apps/web/src/lib/calendar-dates.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { addMonths, entryDayIso, gridRangeEpochs, monthGrid, utcDateIso } from "./calendar-dates";

describe("monthGrid", () => {
  it("builds a Monday-start grid for July 2026", () => {
    const grid = monthGrid(2026, 7);
    // 2026-07-01 is a Wednesday → the grid leads with Mon Jun 29.
    expect(grid[0]?.[0]?.iso).toBe("2026-06-29");
    expect(grid[0]?.[0]?.inMonth).toBe(false);
    expect(grid[0]?.[2]?.iso).toBe("2026-07-01");
    expect(grid[0]?.[2]?.inMonth).toBe(true);
    expect(grid.length).toBe(5);
    for (const week of grid) expect(week.length).toBe(7);
    const last = grid[4]?.[6];
    expect(last?.iso).toBe("2026-08-02");
  });
});

describe("addMonths", () => {
  it("wraps across year boundaries", () => {
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });
});

describe("entryDayIso", () => {
  const due = Date.parse("2026-07-20T00:00:00Z") / 1000;
  it("buckets date-only values by UTC date", () => {
    expect(utcDateIso(due)).toBe("2026-07-20");
    expect(
      entryDayIso({
        kind: "task_due",
        id: "0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa",
        title: "t",
        status: "todo",
        room_id: null,
        assignee_id: null,
        due_at: due,
      }),
    ).toBe("2026-07-20");
    expect(
      entryDayIso({
        kind: "event",
        id: "0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa",
        title: "e",
        room_id: null,
        starts_at: due,
        ends_at: null,
        all_day: 1,
      }),
    ).toBe("2026-07-20");
  });
});

describe("gridRangeEpochs", () => {
  it("covers the grid with a one-day margin on each side", () => {
    const grid = monthGrid(2026, 7);
    const { from, to } = gridRangeEpochs(grid);
    expect(from).toBe(Date.parse("2026-06-28T00:00:00Z") / 1000);
    expect(to).toBe(Date.parse("2026-08-04T00:00:00Z") / 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @loomwiki/web exec vitest run src/lib/calendar-dates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/web/src/lib/calendar-dates.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

// Date helpers for the tasks/calendar UI (v0.1 M9). Rendering convention
// (design doc §2): date-only values (task due_at, all-day events) are epoch
// at 00:00:00 UTC and bucket by UTC date; timed events are instants and
// bucket by browser-local date.

import type { CalendarEntry } from "@loomwiki/schema";

export interface CalDay {
  iso: string; // YYYY-MM-DD (UTC)
  dayOfMonth: number;
  inMonth: boolean;
}

export function utcDateIso(epochS: number): string {
  return new Date(epochS * 1000).toISOString().slice(0, 10);
}

export function localDateIso(epochS: number): string {
  const d = new Date(epochS * 1000);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function entryDayIso(e: CalendarEntry): string {
  if (e.kind === "task_due") return utcDateIso(e.due_at);
  return e.all_day === 1 ? utcDateIso(e.starts_at) : localDateIso(e.starts_at);
}

export function localTimeLabel(epochS: number): string {
  return new Date(epochS * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Monday-start grid of full weeks covering `year`-`month` (month is 1–12). */
export function monthGrid(year: number, month: number): CalDay[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // 0=Mon … 6=Sun
  const start = Date.UTC(year, month - 1, 1 - lead);
  const total = Math.ceil((lead + daysInMonth) / 7) * 7;
  const cells: CalDay[] = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(start + i * 86_400_000);
    cells.push({
      iso: d.toISOString().slice(0, 10),
      dayOfMonth: d.getUTCDate(),
      inMonth: d.getUTCMonth() === month - 1,
    });
  }
  const weeks: CalDay[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function addMonths(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: ((idx % 12) + 12) % 12 + 1 };
}

/** Fetch window for a grid: one day of slop each side for local-tz bucketing. */
export function gridRangeEpochs(grid: CalDay[][]): { from: number; to: number } {
  const firstDay = grid[0]?.[0];
  const lastWeek = grid[grid.length - 1];
  const lastDay = lastWeek?.[lastWeek.length - 1];
  if (!firstDay || !lastDay) throw new Error("empty calendar grid");
  return {
    from: Date.parse(`${firstDay.iso}T00:00:00Z`) / 1000 - 86_400,
    to: Date.parse(`${lastDay.iso}T00:00:00Z`) / 1000 + 2 * 86_400,
  };
}

export function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Event-creation form → starts_at. A time means a browser-local instant;
 * no time means an all-day UTC calendar date. (Chat's /event uses UTC for
 * times instead — documented in its confirmation text.)
 */
export function formStartsAt(date: string, time: string | null): { startsAt: number; allDay: boolean } {
  if (time === null || time === "") {
    return { startsAt: Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000), allDay: true };
  }
  return { startsAt: Math.floor(new Date(`${date}T${time}:00`).getTime() / 1000), allDay: false };
}
```

Run: `pnpm --filter @loomwiki/web exec vitest run src/lib/calendar-dates.test.ts` — expected PASS.

- [ ] **Step 4: Write the failing board test**

Create `apps/web/src/components/tasks/KanbanBoard.test.tsx` (mirror the render-test setup of an existing component test, e.g. `apps/web/src/components/chat/MessageBubble.test.tsx`, for imports/environment):

```tsx
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@loomwiki/schema";
import { KanbanBoard } from "./KanbanBoard";

vi.mock("@/lib/api-tasks", () => ({
  createTask: vi.fn(),
  patchTask: vi.fn(),
}));

const UID = "0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa";

function task(overrides: Partial<Task>): Task {
  return {
    id: UID,
    workspace_id: UID,
    room_id: null,
    title: "t",
    body: null,
    status: "todo",
    assignee_id: null,
    due_at: null,
    origin_message_id: null,
    created_by: UID,
    created_at: 1,
    updated_at: 1,
    completed_at: null,
    tags: [],
    ...overrides,
  };
}

describe("KanbanBoard", () => {
  it("renders four columns and buckets tasks by status, hiding cancelled", () => {
    const tasks = [
      task({ id: `${UID.slice(0, -1)}1`, title: "in todo", status: "todo" }),
      task({ id: `${UID.slice(0, -1)}2`, title: "in doing", status: "doing" }),
      task({ id: `${UID.slice(0, -1)}3`, title: "hidden", status: "cancelled" }),
    ];
    render(
      <KanbanBoard initialTasks={tasks} members={[]} rooms={[]} currentUserId={UID} />,
    );
    expect(screen.getByRole("region", { name: "Backlog" })).toBeDefined();
    expect(screen.getByRole("region", { name: "To do" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Doing" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Done" })).toBeDefined();
    expect(screen.getByText("in todo")).toBeDefined();
    expect(screen.getByText("in doing")).toBeDefined();
    expect(screen.queryByText("hidden")).toBeNull();
  });
});
```

Run: `pnpm --filter @loomwiki/web exec vitest run src/components/tasks/KanbanBoard.test.tsx`
Expected: FAIL — component doesn't exist.

- [ ] **Step 5: Implement the components**

Create `apps/web/src/components/tasks/TaskCard.tsx`:

```tsx
// SPDX-License-Identifier: Apache-2.0

import type { Task } from "@loomwiki/schema";
import { utcDateIso } from "@/lib/calendar-dates";

export interface TaskCardProps {
  task: Task;
  assigneeName: string | null;
}

export function TaskCard({ task, assigneeName }: TaskCardProps) {
  return (
    <article
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/task-id", task.id)}
      className="cursor-grab rounded-md border border-border bg-background p-2 shadow-sm"
    >
      <p className="text-sm">{task.title}</p>
      <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
        {assigneeName !== null && <span>{assigneeName}</span>}
        {task.due_at !== null && <span>due {utcDateIso(task.due_at)}</span>}
        {task.tags.map((tag) => (
          <span key={tag} className="rounded bg-muted px-1">
            #{tag}
          </span>
        ))}
      </div>
    </article>
  );
}
```

Create `apps/web/src/components/tasks/KanbanBoard.tsx`:

```tsx
// SPDX-License-Identifier: Apache-2.0

// Kanban board (v0.1 M9). The board is a client-side grouping of tasks by
// the fixed status enum — dragging a card between columns is a PATCH with
// optimistic update + rollback. No board entity, no manual in-column
// ordering (SPEC Q26): columns sort by due date, then created.

import { type MemberSummary, TASK_BOARD_STATUSES, type Task, type TaskStatus } from "@loomwiki/schema";
import { useMemo, useState } from "react";
import { createTask, patchTask } from "@/lib/api-tasks";
import { TaskCard } from "./TaskCard";

export interface KanbanBoardProps {
  initialTasks: Task[];
  members: MemberSummary[];
  rooms: Array<{ id: string; slug: string }>;
  currentUserId: string;
}

const COLUMN_LABELS: Record<(typeof TASK_BOARD_STATUSES)[number], string> = {
  backlog: "Backlog",
  todo: "To do",
  doing: "Doing",
  done: "Done",
};

export function KanbanBoard({ initialTasks, members, rooms, currentUserId }: KanbanBoardProps) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [roomFilter, setRoomFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.status !== "cancelled" &&
          (roomFilter === "" || t.room_id === roomFilter) &&
          (assigneeFilter === "" || t.assignee_id === assigneeFilter),
      ),
    [tasks, roomFilter, assigneeFilter],
  );

  const memberName = (uid: string | null): string | null =>
    uid === null ? null : (members.find((m) => m.id === uid)?.display_name ?? null);

  async function moveTask(taskId: string, status: TaskStatus): Promise<void> {
    const prev = tasks;
    setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, status } : t)));
    try {
      const { task } = await patchTask(taskId, { status });
      setTasks((ts) => ts.map((t) => (t.id === taskId ? task : t)));
      setError(null);
    } catch (err) {
      setTasks(prev);
      setError(err instanceof Error ? err.message : "failed to move task");
    }
  }

  async function addTask(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const title = newTitle.trim();
    if (title.length === 0) return;
    setNewTitle("");
    try {
      const { task } = await createTask({ title });
      setTasks((ts) => [...ts, task]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create task");
    }
  }

  function columnTasks(status: TaskStatus): Task[] {
    return visible
      .filter((t) => t.status === status)
      .sort(
        (a, b) =>
          (a.due_at ?? Number.MAX_SAFE_INTEGER) - (b.due_at ?? Number.MAX_SAFE_INTEGER) ||
          a.created_at - b.created_at,
      );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={addTask} className="flex gap-2">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="New task title…"
            aria-label="New task title"
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          />
          <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm">
            Add
          </button>
        </form>
        <select
          value={roomFilter}
          onChange={(e) => setRoomFilter(e.target.value)}
          aria-label="Filter by room"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">All rooms</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              #{r.slug}
            </option>
          ))}
        </select>
        <select
          value={assigneeFilter}
          onChange={(e) => setAssigneeFilter(e.target.value)}
          aria-label="Filter by assignee"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Everyone</option>
          <option value={currentUserId}>My tasks</option>
          {members
            .filter((m) => m.id !== currentUserId)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name}
              </option>
            ))}
        </select>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        {TASK_BOARD_STATUSES.map((status) => (
          <section
            key={status}
            role="region"
            aria-label={COLUMN_LABELS[status]}
            className="rounded-lg border border-border bg-muted/30 p-2"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const taskId = e.dataTransfer.getData("text/task-id");
              if (taskId !== "") void moveTask(taskId, status);
            }}
          >
            <h2 className="mb-2 px-1 text-sm font-semibold">
              {COLUMN_LABELS[status]}{" "}
              <span className="font-normal text-muted-foreground">
                {columnTasks(status).length}
              </span>
            </h2>
            <div className="flex min-h-8 flex-col gap-2">
              {columnTasks(status).map((t) => (
                <TaskCard key={t.id} task={t} assigneeName={memberName(t.assignee_id)} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
```

Run: `pnpm --filter @loomwiki/web exec vitest run src/components/tasks/KanbanBoard.test.tsx` — expected PASS.

- [ ] **Step 6: Create the page**

Create `apps/web/src/pages/tasks.astro`, mirroring `timeline.astro`'s structure (SSR `/api/me` → login redirect; graceful-empty on API errors) but member-accessible (no owner gate):

```astro
---
// SPDX-License-Identifier: Apache-2.0
// Kanban board (v0.1 M9) — /tasks. SSR-fetches the newest 200 tasks +
// workspace members; the React island owns filters, drag-drop, creation.

import AppShell from "@/components/AppShell.astro";
import { KanbanBoard } from "@/components/tasks/KanbanBoard";
import Layout from "@/layouts/Layout.astro";
import { SsrApiError, SsrAuthRequiredError, ssrApiGet } from "@/lib/ssr-api";
import type { CurrentUserPayload } from "@/lib/types";
import type { MemberSummary, Task } from "@loomwiki/schema";

let me: CurrentUserPayload;
try {
  me = await ssrApiGet<CurrentUserPayload>(Astro.request, "/api/me");
} catch (err) {
  if (err instanceof SsrAuthRequiredError) return Astro.redirect("/login");
  throw err;
}

let tasksPage: { tasks: Task[]; hasMore: boolean } = { tasks: [], hasMore: false };
let members: MemberSummary[] = [];
try {
  [tasksPage, { members }] = await Promise.all([
    ssrApiGet<{ tasks: Task[]; hasMore: boolean }>(Astro.request, "/api/tasks?limit=200"),
    ssrApiGet<{ members: MemberSummary[] }>(
      Astro.request,
      `/api/workspaces/${me.workspace.id}/members`,
    ),
  ]);
} catch (err) {
  if (err instanceof SsrAuthRequiredError) return Astro.redirect("/login");
  if (!(err instanceof SsrApiError)) throw err;
}

const rooms = me.rooms.map((r) => ({ id: r.id, slug: r.slug }));
---

<Layout title={`Tasks — ${me.workspace.name}`}>
  <AppShell
    workspaceName={me.workspace.name}
    userDisplayName={me.user.display_name}
    isOwner={me.workspace.owner_id === me.user.id}
  >
    <div class="p-4">
      {tasksPage.hasMore && (
        <p class="mb-2 text-sm text-muted-foreground">Showing the newest 200 tasks.</p>
      )}
      <KanbanBoard
        client:load
        initialTasks={tasksPage.tasks}
        members={members}
        rooms={rooms}
        currentUserId={me.user.id}
      />
    </div>
  </AppShell>
</Layout>
```

Before committing, open `timeline.astro` and confirm the `<AppShell>` prop names and the slot structure match what it actually passes — mirror exactly (the snippet above matches `timeline.astro` as of this writing).

- [ ] **Step 7: Run the web test suite + typecheck**

Run: `pnpm --filter @loomwiki/web test && pnpm --filter @loomwiki/web typecheck`
Expected: PASS / no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/calendar-dates.ts apps/web/src/lib/calendar-dates.test.ts apps/web/src/components/tasks/ apps/web/src/pages/tasks.astro
git commit -m "feat(web): add kanban board page with drag-drop status moves"
```

---

### Task 11: Calendar page (`/calendar`) + nav links

**Files:**
- Create: `apps/web/src/components/calendar/CalendarView.tsx`
- Create: `apps/web/src/pages/calendar.astro`
- Modify: `apps/web/src/components/AppShell.astro` (two nav links)
- Test: `apps/web/src/components/calendar/CalendarView.test.tsx`

**Interfaces:**
- Consumes: Task 9 `getCalendar`/`createEvent`; Task 10 date helpers; `CalendarEntry` from `@loomwiki/schema`.
- Produces: `<CalendarView initialEntries initialYear initialMonth rooms currentUserId />` — month grid (Monday-start) with a week strip toggle, prev/today/next nav, room + "mine" filters, inline all-day/timed event creation.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/calendar/CalendarView.test.tsx`:

```tsx
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CalendarEntry } from "@loomwiki/schema";
import { CalendarView } from "./CalendarView";

vi.mock("@/lib/api-calendar", () => ({
  getCalendar: vi.fn(),
  createEvent: vi.fn(),
}));

const UID = "0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa";

describe("CalendarView", () => {
  it("renders the month label and buckets entries onto their UTC day", () => {
    const entries: CalendarEntry[] = [
      {
        kind: "event",
        id: UID,
        title: "Offsite",
        room_id: null,
        starts_at: Date.parse("2026-07-20T00:00:00Z") / 1000,
        ends_at: null,
        all_day: 1,
      },
      {
        kind: "task_due",
        id: `${UID.slice(0, -1)}1`,
        title: "Ship M9",
        status: "done",
        room_id: null,
        assignee_id: null,
        due_at: Date.parse("2026-07-21T00:00:00Z") / 1000,
      },
    ];
    render(
      <CalendarView
        initialEntries={entries}
        initialYear={2026}
        initialMonth={7}
        rooms={[]}
        currentUserId={UID}
      />,
    );
    expect(screen.getByText("July 2026")).toBeDefined();
    expect(screen.getByText("Offsite")).toBeDefined();
    expect(screen.getByText("Ship M9")).toBeDefined();
  });
});
```

Run: `pnpm --filter @loomwiki/web exec vitest run src/components/calendar/CalendarView.test.tsx`
Expected: FAIL — component doesn't exist.

- [ ] **Step 2: Implement `apps/web/src/components/calendar/CalendarView.tsx`**

```tsx
// SPDX-License-Identifier: Apache-2.0

// Calendar (v0.1 M9): month grid + week strip over GET /api/calendar.
// Bucketing rule lives in lib/calendar-dates.entryDayIso — date-only values
// by UTC date, timed events by browser-local date. Month changes refetch;
// filters refetch server-side (room/user are query params, not client
// filtering, so the range cap stays meaningful).

import type { CalendarEntry } from "@loomwiki/schema";
import { useMemo, useState } from "react";
import { createEvent, getCalendar } from "@/lib/api-calendar";
import {
  addMonths,
  entryDayIso,
  formStartsAt,
  gridRangeEpochs,
  localDateIso,
  localTimeLabel,
  monthGrid,
  monthLabel,
} from "@/lib/calendar-dates";

export interface CalendarViewProps {
  initialEntries: CalendarEntry[];
  initialYear: number;
  initialMonth: number; // 1-12
  rooms: Array<{ id: string; slug: string }>;
  currentUserId: string;
}

export function CalendarView({
  initialEntries,
  initialYear,
  initialMonth,
  rooms,
  currentUserId,
}: CalendarViewProps) {
  const [pos, setPos] = useState({ year: initialYear, month: initialMonth });
  const [entries, setEntries] = useState<CalendarEntry[]>(initialEntries);
  const [roomFilter, setRoomFilter] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [view, setView] = useState<"month" | "week">("month");
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", date: "", time: "" });

  const grid = useMemo(() => monthGrid(pos.year, pos.month), [pos]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const e of entries) {
      const key = entryDayIso(e);
      const list = map.get(key) ?? [];
      list.push(e);
      map.set(key, list);
    }
    return map;
  }, [entries]);

  async function load(
    year: number,
    month: number,
    room: string,
    mine: boolean,
  ): Promise<void> {
    const { from, to } = gridRangeEpochs(monthGrid(year, month));
    try {
      const resp = await getCalendar(from, to, {
        ...(room !== "" ? { room } : {}),
        ...(mine ? { user: currentUserId } : {}),
      });
      setEntries(resp.entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load calendar");
    }
  }

  function nav(delta: number): void {
    const next = delta === 0
      ? { year: new Date().getFullYear(), month: new Date().getMonth() + 1 }
      : addMonths(pos.year, pos.month, delta);
    setPos(next);
    void load(next.year, next.month, roomFilter, mineOnly);
  }

  async function addEvent(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const title = form.title.trim();
    if (title === "" || form.date === "") return;
    const { startsAt, allDay } = formStartsAt(form.date, form.time === "" ? null : form.time);
    try {
      await createEvent({ title, starts_at: startsAt, all_day: allDay });
      setForm({ title: "", date: "", time: "" });
      await load(pos.year, pos.month, roomFilter, mineOnly);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create event");
    }
  }

  const todayIso = localDateIso(Math.floor(Date.now() / 1000));
  const weeks =
    view === "month"
      ? grid
      : [grid.find((w) => w.some((d) => d.iso === todayIso)) ?? grid[0] ?? []];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => nav(-1)} aria-label="Previous month" className="rounded-md border border-border px-2 py-1 text-sm">‹</button>
        <button type="button" onClick={() => nav(0)} className="rounded-md border border-border px-2 py-1 text-sm">Today</button>
        <button type="button" onClick={() => nav(1)} aria-label="Next month" className="rounded-md border border-border px-2 py-1 text-sm">›</button>
        <h2 className="px-1 text-sm font-semibold">{monthLabel(pos.year, pos.month)}</h2>
        <button
          type="button"
          onClick={() => setView(view === "month" ? "week" : "month")}
          className="rounded-md border border-border px-2 py-1 text-sm"
        >
          {view === "month" ? "Week view" : "Month view"}
        </button>
        <select
          value={roomFilter}
          onChange={(e) => {
            setRoomFilter(e.target.value);
            void load(pos.year, pos.month, e.target.value, mineOnly);
          }}
          aria-label="Filter by room"
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="">All rooms</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              #{r.slug}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            checked={mineOnly}
            onChange={(e) => {
              setMineOnly(e.target.checked);
              void load(pos.year, pos.month, roomFilter, e.target.checked);
            }}
          />
          Mine
        </label>
      </div>

      <form onSubmit={addEvent} className="flex flex-wrap items-center gap-2">
        <input
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="New event title…"
          aria-label="New event title"
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        />
        <input
          type="date"
          value={form.date}
          onChange={(e) => setForm({ ...form, date: e.target.value })}
          aria-label="Event date"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        />
        <input
          type="time"
          value={form.time}
          onChange={(e) => setForm({ ...form, time: e.target.value })}
          aria-label="Event time (optional)"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        />
        <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm">
          Add event
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="grid grid-cols-7 gap-px rounded-lg border border-border bg-border text-xs">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="bg-muted/50 p-1 text-center font-semibold">
            {d}
          </div>
        ))}
        {weeks.flat().map((day) => (
          <div
            key={day.iso}
            className={`min-h-20 bg-background p-1 ${day.inMonth ? "" : "opacity-50"} ${day.iso === todayIso ? "ring-1 ring-inset ring-blue-500" : ""}`}
          >
            <div className="text-right text-muted-foreground">{day.dayOfMonth}</div>
            <div className="flex flex-col gap-0.5">
              {(byDay.get(day.iso) ?? []).map((e) => (
                <span
                  key={`${e.kind}:${e.id}`}
                  className={`truncate rounded px-1 ${
                    e.kind === "event"
                      ? "bg-blue-500/15"
                      : e.status === "done"
                        ? "bg-muted line-through"
                        : "bg-amber-500/15"
                  }`}
                  title={e.title}
                >
                  {e.kind === "event" && e.all_day === 0 ? `${localTimeLabel(e.starts_at)} ` : ""}
                  {e.title}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

Run: `pnpm --filter @loomwiki/web exec vitest run src/components/calendar/CalendarView.test.tsx` — expected PASS.

- [ ] **Step 3: Create the page**

Create `apps/web/src/pages/calendar.astro` (same skeleton as `tasks.astro`):

```astro
---
// SPDX-License-Identifier: Apache-2.0
// Calendar (v0.1 M9) — /calendar. SSR-fetches the current month's grid
// range; the React island owns navigation, filters, and event creation.

import AppShell from "@/components/AppShell.astro";
import { CalendarView } from "@/components/calendar/CalendarView";
import Layout from "@/layouts/Layout.astro";
import { gridRangeEpochs, monthGrid } from "@/lib/calendar-dates";
import { SsrApiError, SsrAuthRequiredError, ssrApiGet } from "@/lib/ssr-api";
import type { CurrentUserPayload } from "@/lib/types";
import type { CalendarEntry } from "@loomwiki/schema";

let me: CurrentUserPayload;
try {
  me = await ssrApiGet<CurrentUserPayload>(Astro.request, "/api/me");
} catch (err) {
  if (err instanceof SsrAuthRequiredError) return Astro.redirect("/login");
  throw err;
}

const now = new Date();
const year = now.getUTCFullYear();
const month = now.getUTCMonth() + 1;
const { from, to } = gridRangeEpochs(monthGrid(year, month));

let entries: CalendarEntry[] = [];
try {
  const resp = await ssrApiGet<{ entries: CalendarEntry[] }>(
    Astro.request,
    `/api/calendar?from=${from}&to=${to}`,
  );
  entries = resp.entries;
} catch (err) {
  if (err instanceof SsrAuthRequiredError) return Astro.redirect("/login");
  if (!(err instanceof SsrApiError)) throw err;
}

const rooms = me.rooms.map((r) => ({ id: r.id, slug: r.slug }));
---

<Layout title={`Calendar — ${me.workspace.name}`}>
  <AppShell
    workspaceName={me.workspace.name}
    userDisplayName={me.user.display_name}
    isOwner={me.workspace.owner_id === me.user.id}
  >
    <div class="p-4">
      <CalendarView
        client:load
        initialEntries={entries}
        initialYear={year}
        initialMonth={month}
        rooms={rooms}
        currentUserId={me.user.id}
      />
    </div>
  </AppShell>
</Layout>
```

- [ ] **Step 4: Add nav links**

In `apps/web/src/components/AppShell.astro`, the workspace nav (`<nav aria-label="Workspace nav">`, ~line 92) holds anchor blocks for `/`, `/w`, `/ask`, `/inbox`, …. Duplicate the `/ask` anchor block twice, immediately after it, changing only the `href` and visible label: one with `href="/tasks"` labeled `Tasks`, one with `href="/calendar"` labeled `Calendar`. Keep every class and attribute of the copied block identical so active-state styling keeps working.

- [ ] **Step 5: Run web gates**

Run: `pnpm --filter @loomwiki/web test && pnpm --filter @loomwiki/web typecheck`
Expected: PASS / no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/calendar/ apps/web/src/pages/calendar.astro apps/web/src/components/AppShell.astro
git commit -m "feat(web): add calendar page with month/week views and event creation"
```

---

### Task 12: SPEC.md amendments

**Files:**
- Modify: `SPEC.md` (§1, §2, §7, §8, §19, §20)

The design doc reverses two POC non-goals; SPEC.md must say so or the spec contradicts the shipped code (a CLAUDE.md stop-and-flag condition for every future session).

- [ ] **Step 1: §1 — narrow the non-goals**

In the §1 "Non-goals (POC)" list, replace the two lines:

```markdown
- Calendar / meetings / availability
- Tasks, projects, sprints, OKRs
```

with:

```markdown
- Full project management: sprints, OKRs, Gantt, story points (lightweight
  native tasks, kanban, and calendar shipped in v0.1 — see §19 M9–M11)
```

- [ ] **Step 2: §2 — extend the open-questions index table**

Append to the §2 table (after the Q24 row):

```markdown
| Q25 | Event recurrence (rrule column reserved) | deferred (v0.1 design doc) |
| Q26 | In-column manual kanban ordering | deferred (v0.1 design doc) |
| Q27 | Task priority field | deferred (v0.1 design doc) |
| Q28 | Live board sync over WS | deferred (with Q18) |
| Q29 | Attendee RSVP status | deferred (v0.1 design doc) |
| Q30 | Event reminders (scheduled_actions fit) | deferred (v0.1 design doc) |
| Q31 | scheduled_actions overlay on calendar | deferred (v0.1 design doc) |
| Q32 | GitHub Issues sync layer (issue #30) | deferred until after M11 |
```

- [ ] **Step 3: §7 — add subsection 7.4**

Insert after §7.3 (before the `## 8. API surface` heading):

```markdown
### 7.4 Tasks & events (v0.1, migration `0006_tasks_events.sql`)

Native task tracker + calendar entities (M9). Full DDL in
`packages/schema/d1-migrations/0006_tasks_events.sql`; design + decisions log
in `docs/superpowers/specs/2026-07-08-calendar-tasks-kanban-design.md`.

- **`tasks`** — room-optional (`room_id` nullable), fixed status enum
  (`backlog|todo|doing|done|cancelled`), single `assignee_id`, `due_at`,
  `origin_message_id` chat provenance. Kanban is a view over `status` —
  no board/column tables.
- **`task_tags`** — `(task_id, tag)`; tags are kebab-case lowercase.
- **`events`** — single-occurrence (`rrule` reserved NULL, Q25), `all_day`
  flag, soft-cancel via `cancelled_at`, `origin_message_id` provenance.
- **`event_attendees`** — `(event_id, user_id)`; no RSVP status (Q29).

Time conventions: date-only values (task `due_at`, all-day events) are epoch
at 00:00:00 UTC and render by UTC date; timed events are instants rendered
browser-local.
```

- [ ] **Step 4: §8 — extend the API table**

Append rows to the §8 route table:

```markdown
| GET | `/api/workspaces/:wid/members` | Workspace user list (assignee pickers) |
| GET/POST | `/api/tasks` | List (filters + cursor) / create task (v0.1 M9) |
| GET/PATCH/DELETE | `/api/tasks/:id` | Task detail / partial update / hard delete |
| GET/POST | `/api/events` | Range list / create event (v0.1 M9) |
| GET/PATCH/DELETE | `/api/events/:id` | Event detail / update / soft-cancel |
| POST/DELETE | `/api/events/:id/attendees/:uid` | Add / remove attendee |
| GET | `/api/calendar` | Union of events + due tasks over a range |
```

- [ ] **Step 5: §19 — add the milestones**

Append after the M8 section (before the `**Total**` line):

```markdown
### M9 — Tasks + events + kanban + calendar (v0.1, one session)
- Migration `0006_tasks_events.sql`; Zod schemas + parsers in `packages/schema`.
- Routes: `/api/tasks`, `/api/events` (+ attendees), `/api/calendar`,
  `/api/workspaces/:wid/members`. Integration tests per route.
- `/tasks` kanban (fixed columns, drag = status PATCH) + `/calendar`
  (month/week) in `apps/web`.
- ChatRoom DO slash commands `/task`, `/event`, `/done` (deterministic
  parser in `packages/shared`; confirmation via the system-message path).
- **Subagent fan-out**: once Tasks 1–3 (migration, schemas, parser) are
  committed, the route tasks (5–7), DO task (8), and web tasks (9–11) are
  three independent lanes.
- **DoD**: create a task by chat command and by board; drag it across the
  board; see its due date and an event on `/calendar`.
- Plan: `docs/superpowers/plans/2026-07-08-m9-tasks-events-foundation.md`.

### M10 — Tasks/calendar interop (one session)
- Message↔task linking UI (create-from-message, backlink chips).
- Status-broadcast system messages on API-side changes to room-scoped tasks.
- Room-page Tasks/Calendar tabs; My-views polish.
- Daily vault snapshot: `/tasks/board.md` + `/calendar/YYYY-MM.md` in the
  02:00 UTC cron. Re-scoping comment on issue #30.

### M11 — Agent extraction (one session)
- `extraction_proposals` table (migration 0007); ingest agent proposes
  tasks/events into the existing inbox; merge materializes rows.
- ⚠️ Touches `vault-template/AGENTS.md` (do-not-touch surface): requires
  explicit operator approval at milestone start.
```

- [ ] **Step 6: §20 — add the deferred questions**

Insert before the `### Repo-level` heading in §20:

```markdown
### v0.1 tasks/calendar (M9–M11)

- **Q25 — Event recurrence** (deferred; `events.rrule` reserved NULL):
- **Q26 — In-column manual kanban ordering** (deferred; sort = due, then created):
- **Q27 — Task priority field** (deferred):
- **Q28 — Live board sync over WS** (deferred with Q18):
- **Q29 — Attendee RSVP status** (deferred):
- **Q30 — Event reminders** (deferred; natural `scheduled_actions` fit):
- **Q31 — `scheduled_actions` overlay on calendar** (deferred):
- **Q32 — GitHub Issues sync layer (#30)** (deferred until after M11):
```

- [ ] **Step 7: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): amend SPEC for v0.1 tasks/events/kanban/calendar (M9-M11)"
```

---

### Task 13: Final gates + wrap-up

- [ ] **Step 1: Full gates from the repo root**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: every package green, zero type errors, zero biome findings. If biome complains about formatting, run `pnpm format`, re-run gates, and amend the offending commit or add a `chore: format` commit.

- [ ] **Step 2: Report explicit results**

State the actual counts ("N test files, M tests passing") — not "tests pass".

- [ ] **Step 3: Ship**

Use the `/ship` skill (repo convention) to run the pre-PR checklist and open the PR. PR title: `feat: tasks + events + kanban + calendar foundation (M9)`. Description references the design doc, lists the SPEC §20 assumptions (Q25–Q32 deferred; delta notes: `before` cursor param name; sender-only WS error envelopes for slash failures; chat `/event` times are UTC while UI times are local), and does NOT enable auto-merge until CI is green.

- [ ] **Step 4: File follow-up issues**

Per the user's global workflow rules, before declaring done, offer to file GitHub issues for: M10 (interop) and M11 (agent extraction) milestone issues referencing the design doc, plus any scope cuts discovered during implementation.

---

## Self-review notes (spec-coverage map)

| Design-doc section | Plan task |
|---|---|
| §3 data model (4 tables, indexes) | Task 1 |
| §3 Zod schemas / §4 wire shapes | Task 2 |
| §6 slash grammar (parser) | Task 3 |
| §4 API: tasks list/create/patch/delete + tags | Task 5 |
| §4 API: events + attendees + soft-cancel | Task 6 |
| §4 API: calendar union | Task 7 |
| §6 slash commands in DO + confirmations | Task 8 |
| §5 views: kanban `/tasks` | Tasks 9–10 |
| §5 views: calendar `/calendar` (month + week) | Tasks 9, 11 |
| §1 SPEC amendments / §10 deferred questions | Task 12 |
| §9 testing rules (route + DO + web tests) | inside every task |
| Members list for assignee UI (implied by §5 filters) | Task 4 |

Known deliberate deltas from the design doc (also listed in the PR description step): cursor param is `before` (repo precedent) not `cursor`; slash-command failures are sender-only WS `error` envelopes, not room-visible system messages; chat `/event` interprets times as UTC while the web form uses browser-local. M10 scope (message-menu linking, status broadcasts, room tabs, vault snapshot) and M11 scope (extraction proposals) are intentionally absent — separate plans.


