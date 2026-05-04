-- SPDX-License-Identifier: Apache-2.0
--
-- Loomwiki D1 schema (SPEC §7.1). Forward-only — to roll back, write a new
-- migration; never edit this file once it has been applied to a deployed DB.
--
-- All `*_at` columns are unix epoch seconds (per CLAUDE.md "Times: store as
-- unix epoch seconds (integer) in D1. Convert at the edge.").

-- Users (created via JIT on first authenticated request)
CREATE TABLE users (
  id            TEXT PRIMARY KEY,            -- UUIDv7
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_users_email ON users(email);

-- Workspaces (POC has exactly one per deploy — see SPEC §16, Q19)
CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_id      TEXT NOT NULL REFERENCES users(id),
  vault_repo    TEXT NOT NULL,               -- Artifacts repo identifier
  ai_search_id  TEXT,                        -- AI Search instance id
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Rooms
CREATE TABLE rooms (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  slug          TEXT NOT NULL,               -- url-safe; unique per workspace
  name          TEXT NOT NULL,
  topic         TEXT,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (workspace_id, slug)
);

-- Room membership (POC: every workspace member is in every room they join)
CREATE TABLE room_members (
  room_id       TEXT NOT NULL REFERENCES rooms(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  role          TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  joined_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (room_id, user_id)
);

-- Messages (also lived in DO SQLite; D1 is the queryable mirror — see SPEC §9)
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,            -- UUIDv7 — sortable
  room_id       TEXT NOT NULL REFERENCES rooms(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  body          TEXT NOT NULL,               -- markdown
  parent_id     TEXT REFERENCES messages(id),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  edited_at     INTEGER,
  deleted_at    INTEGER
);
CREATE INDEX idx_messages_room_created ON messages(room_id, created_at);

-- Ingest runs (one per IngestAgent execution; SPEC §10)
CREATE TABLE ingest_runs (
  id              TEXT PRIMARY KEY,
  room_id         TEXT NOT NULL REFERENCES rooms(id),
  triggered_by    TEXT NOT NULL,             -- user_id or 'cron'
  started_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at     INTEGER,
  last_message_id TEXT,                      -- bookmark
  status          TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  summary         TEXT,                      -- LLM-written one-liner
  error           TEXT
);

-- Proposals (AI-generated wiki edits awaiting review; SPEC §10)
CREATE TABLE proposals (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES ingest_runs(id),
  page_path       TEXT NOT NULL,             -- e.g. /wiki/concepts/dmarc.md
  action          TEXT NOT NULL CHECK (action IN ('create', 'update')),
  before_sha      TEXT,                      -- null for 'create'
  after_content   TEXT NOT NULL,             -- proposed markdown
  rationale       TEXT NOT NULL,             -- LLM's reasoning
  status          TEXT NOT NULL CHECK (status IN ('pending', 'merged', 'rejected', 'superseded')),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  reviewed_at     INTEGER,
  reviewed_by     TEXT REFERENCES users(id),
  artifacts_commit TEXT                      -- set on merge
);
CREATE INDEX idx_proposals_status ON proposals(status, created_at);

-- BYOK keys — envelope-encrypted with BYOK_ENCRYPTION_KEY. Routes that touch
-- this table land in M8; M1 just provisions the schema.
CREATE TABLE byok_keys (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  provider        TEXT NOT NULL,             -- 'anthropic' | 'openai' | 'google'
  ciphertext      BLOB NOT NULL,
  iv              BLOB NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by      TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (workspace_id, provider)
);
