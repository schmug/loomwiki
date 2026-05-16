-- SPDX-License-Identifier: Apache-2.0
--
-- Scheduled actions: user-defined cron/once prompts that fire into a ChatRoom.
-- Forward-only. See issue #33.

CREATE TABLE IF NOT EXISTS scheduled_actions (
  id             TEXT PRIMARY KEY,            -- UUIDv7
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  room_id        TEXT NOT NULL REFERENCES rooms(id),
  created_by     TEXT NOT NULL REFERENCES users(id),
  kind           TEXT NOT NULL CHECK(kind IN ('cron','once')),
  cron_expr      TEXT,                        -- non-null when kind='cron'
  fire_at        INTEGER,                     -- epoch s, non-null when kind='once'
  prompt         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','fired','failed')),
  failure_count  INTEGER NOT NULL DEFAULT 0,
  last_fired_at  INTEGER,
  next_fire_at   INTEGER NOT NULL,            -- epoch s, indexed
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_scheduled_actions_tick
  ON scheduled_actions(next_fire_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_scheduled_actions_room
  ON scheduled_actions(room_id, status);

CREATE INDEX IF NOT EXISTS idx_scheduled_actions_workspace
  ON scheduled_actions(workspace_id, status);
