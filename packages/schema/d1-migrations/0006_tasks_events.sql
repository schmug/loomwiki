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
