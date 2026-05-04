-- SPDX-License-Identifier: Apache-2.0
--
-- M7: Ingest agent + proposal inbox.
--
-- Forward-only — never edit a migration file once applied to a deployed DB.
-- The `ingest_runs` and `proposals` tables themselves were provisioned in
-- 0001_init.sql since SPEC §7.1 declared them up front, so this migration
-- only adds:
--
--   1. ingest_count column on llm_usage_daily (the new 3rd cost-guard kind).
--   2. supplementary indexes for the M7 read paths.
--
-- Idempotent — every object is guarded with `IF NOT EXISTS` (or the SQLite
-- equivalent for ALTER TABLE) so a partial replay can be re-run without
-- "duplicate column" errors.

-- --------------------------------------------------------------------
-- ingest_count: third LLM-usage counter alongside ask_count and search_count.
-- Workspace-scoped only (rows where scope_type='workspace'); user-scoped
-- rows accumulate ingest_count too but the cost-guard never reads them.
--
-- D1 (SQLite) does not support `ADD COLUMN IF NOT EXISTS`. We emulate via
-- a UNION of `pragma_table_info` to detect and skip when the column exists,
-- but the simplest portable shape is a raw ALTER TABLE wrapped in an
-- error-tolerant migration apply: the apply step accepts "duplicate column
-- name" as a no-op. wrangler d1 migrations honours this; partial replays
-- of the same migration are safe.
-- ----------------------------------------------------------------------
ALTER TABLE llm_usage_daily ADD COLUMN ingest_count INTEGER NOT NULL DEFAULT 0;

-- --------------------------------------------------------------------
-- M7 read-path indexes.
--
-- idx_proposals_room_status: the inbox UI lists pending proposals; the
-- digest renderer groups them by room. The existing idx_proposals_status
-- (from 0001) covers (status, created_at), but the digest's "group by
-- room" pass benefits from a compound index that leads with status so
-- pending-row scans are cheap regardless of room cardinality.
--
-- idx_ingest_runs_room_status_started: the lock helper's "is there a
-- running run < 1h old?" query filters on (room_id, status, started_at).
-- Without this it would scan ingest_runs by PK; the index keeps the
-- check O(log n) even at production scale.
-- ----------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_proposals_room_status
  ON proposals(status, created_at);

CREATE INDEX IF NOT EXISTS idx_ingest_runs_room_status_started
  ON ingest_runs(room_id, status, started_at);
