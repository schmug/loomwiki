-- SPDX-License-Identifier: Apache-2.0
--
-- M8: Release-readiness migration.
--
--   1. audit_log         — append-only record of admin/proposal-merge actions.
--   2. workspace_settings — single-row-per-workspace settings (timezone,
--                            default LLM model).
--   3. byok_keys.last_used_at — timestamp of the most recent successful
--                                decrypt. Read by the BYOK metadata API.
--
-- Forward-only. SQLite is forgiving about ADD COLUMN replays on partial-apply
-- (the wrangler runner accepts "duplicate column name" as a no-op), and every
-- table-level statement uses IF NOT EXISTS so the migration is idempotent.

-- --------------------------------------------------------------------
-- audit_log
--
-- Captures admin actions (BYOK CRUD, AGENTS.md edits, workspace settings
-- updates, manual ingest triggers) and proposal lifecycle transitions
-- (merge, reject). Reads via GET /api/_admin/audit?since=&limit=
-- (owner-only). Writes are wrapped in c.executionCtx.waitUntil so an
-- audit-log INSERT failure does not block the parent operation —
-- absent-but-acted-on is bad, but blocking-on-audit-infra is worse.
-- See lib/audit.ts.
--
-- before_json / after_json are 4 KB-truncated snapshots. The diff is
-- "store snapshots, compute on read" — keeps writes cheap and lets the
-- v0.1 audit-log viewer render whatever diff format suits it.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,                    -- UUIDv7
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  actor_user_id TEXT REFERENCES users(id),           -- nullable for system/cron
  action        TEXT NOT NULL,                       -- AuditAction enum (see schema)
  resource_kind TEXT NOT NULL,                       -- 'proposal' | 'byok' | 'agentsmd' | 'workspace_settings' | 'ingest'
  resource_id   TEXT,                                -- proposal id, provider name, etc.
  before_json   TEXT,                                -- JSON snapshot, truncated to 4 KB
  after_json    TEXT,                                -- JSON snapshot, truncated to 4 KB
  request_id    TEXT,                                -- correlation id (UUIDv7)
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_audit_workspace_created
  ON audit_log(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_workspace_action_created
  ON audit_log(workspace_id, action, created_at DESC);


-- --------------------------------------------------------------------
-- workspace_settings
--
-- Single-row-per-workspace mutable config. v0.0.1 ships:
--   - timezone (IANA tz name; default "UTC")
--   - default_model (Workers AI model id, or "byok:anthropic"/"byok:openai")
--
-- A row is created on first PUT /api/settings/workspace; until then,
-- routes that read settings fall back to the env-level defaults
-- (env.DEFAULT_LLM_MODEL, env.WORKSPACE_DEFAULT_TIMEZONE ?? "UTC").
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id   TEXT PRIMARY KEY REFERENCES workspaces(id),
  timezone       TEXT NOT NULL DEFAULT 'UTC',
  default_model  TEXT NOT NULL,
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by     TEXT REFERENCES users(id)
);


-- --------------------------------------------------------------------
-- byok_keys.last_used_at
--
-- Read by GET /api/settings/byok metadata. Updated by getBYOK() on the
-- decrypt path, throttled to once-per-minute to avoid hot-spotting D1
-- when chat / ingest fan out many concurrent BYOK reads. Nullable
-- because freshly-set keys have never been used.
-- --------------------------------------------------------------------
ALTER TABLE byok_keys ADD COLUMN last_used_at INTEGER;
