-- SPDX-License-Identifier: Apache-2.0
--
-- M6: LLM cost guards + FTS5 wiki search fallback.
--
-- Forward-only — never edit a migration file once applied to a deployed DB.
-- All `*_at`/`day` columns follow the M0–M1 convention: epoch seconds for
-- timestamps, YYYY-MM-DD strings for calendar days.
--
-- This migration is idempotent — `IF NOT EXISTS` guards every object so a
-- partial replay of M5→M6 (e.g. a CI box that aborted mid-apply) can be
-- re-run without `table already exists` errors.

-- --------------------------------------------------------------------
-- Per-day LLM usage counters. The cost-guard middleware reads these on
-- every /api/ask and /api/search request and refuses calls past the
-- configured daily limits. (M6 cost-guard.ts)
--
-- Why a single table with `scope_type` instead of two tables (one for
-- per-user, one for per-workspace): same shape, same upsert path, half
-- the SQL surface. The composite primary key keeps writes race-safe via
-- `ON CONFLICT DO UPDATE`.
--
-- `scope_id` carries the user UUIDv7 for `scope_type='user'` rows and
-- the literal sentinel `'_workspace'` for the workspace-wide row. The
-- sentinel is impossible to confuse with a UUIDv7 (UUIDs cannot start
-- with `_`), so the union is unambiguous.
--
-- No background reaper job in M6 — `day` is part of the PK so a new day
-- creates a new row, and stale rows are inert until manually trimmed.
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS llm_usage_daily (
  workspace_id   TEXT    NOT NULL REFERENCES workspaces(id),
  day            TEXT    NOT NULL,                                       -- YYYY-MM-DD UTC
  scope_type     TEXT    NOT NULL CHECK (scope_type IN ('user', 'workspace')),
  scope_id       TEXT    NOT NULL,                                       -- UUIDv7 or '_workspace'
  ask_count      INTEGER NOT NULL DEFAULT 0,
  search_count   INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (workspace_id, day, scope_type, scope_id)
);

-- Day-leading index for the eventual reaper job (delete WHERE day < ?).
CREATE INDEX IF NOT EXISTS idx_llm_usage_day ON llm_usage_daily(day);

-- --------------------------------------------------------------------
-- FTS5 fallback index over `/wiki/**` pages. Used when AI Search is
-- unavailable (local dev, fresh deploy pre-bootstrap, or AI Search
-- outage). Populated by the M6 indexer + the M4 wiki PUT/DELETE
-- extension; the AI Search side reindexes itself off the vault.
--
-- `path UNINDEXED` keeps the path out of the BM25 ranking but lets
-- queries `SELECT path FROM wiki_pages_fts WHERE wiki_pages_fts MATCH ?`
-- without joining a separate row table. Tokenizer is `porter unicode61`
-- — Porter stemming gives "DMARC"/"DMARCs" parity, unicode61 tokenizes
-- on Unicode word boundaries.
-- ----------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts USING fts5(
  path UNINDEXED,
  title,
  body,
  tokenize='porter unicode61'
);
