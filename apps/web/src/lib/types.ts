// SPDX-License-Identifier: Apache-2.0

// Wire types the web client consumes. Mirrors the SerializedX types in
// apps/worker/src/lib/serialize.ts (M1) — duplicated here so the web
// app doesn't depend on the worker's internals. If serialize.ts ever
// moves into a shared package, switch this module to a re-export.

export interface SerializedUser {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string; // ISO-8601
}

export interface SerializedWorkspace {
  id: string;
  name: string;
  owner_id: string;
  vault_repo: string;
  ai_search_id: string | null;
  created_at: string;
}

export interface SerializedRoom {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  topic: string | null;
  created_by: string;
  created_at: string;
}

export interface CurrentUserPayload {
  user: SerializedUser;
  workspace: SerializedWorkspace;
  rooms: SerializedRoom[];
}

export interface RoomDetailPayload {
  room: SerializedRoom;
}

export interface RoomsListPayload {
  rooms: SerializedRoom[];
}

export interface CreateRoomRequest {
  slug: string;
  name: string;
  topic?: string;
}

// ---------- Wiki (M4) ----------

export type WikiPageKind = "entity" | "decision" | "concept" | "open-question" | "glossary";

export type WikiPageStatus = "draft" | "published" | "superseded";

export interface WikiPageSource {
  room: string;
  message_id: string;
  excerpt?: string;
}

export interface WikiPageFrontmatter {
  title: string;
  kind: WikiPageKind;
  created: string; // ISO-8601 date or datetime
  last_updated: string;
  status: WikiPageStatus;
  superseded_by?: string;
  sources?: WikiPageSource[];
}

export interface WikiPagePayload {
  path: string;
  frontmatter: WikiPageFrontmatter;
  body: string;
  sha: string;
}

export interface WikiPageReadResponse {
  page: WikiPagePayload;
}

/** Structured write — sent by the editor's normal save flow. */
export interface WikiPageStructuredWrite {
  frontmatter: WikiPageFrontmatter;
  body: string;
  before_sha?: string;
}

/**
 * Raw write — sent by the merge dialog when the user pastes / accepts
 * the on-disk YAML page text directly. The worker re-parses with
 * gray-matter and applies the same validation.
 */
export interface WikiPageRawWrite {
  raw: string;
  before_sha?: string;
}

export type WikiPageWriteRequest = WikiPageStructuredWrite | WikiPageRawWrite;

export interface WikiTreeResponse {
  paths: string[];
}

/**
 * Shape of the `error.details` field on a 409 CONFLICT from PUT
 * /api/wiki/*. The MergeDialog renders against this exactly.
 */
export interface WikiConflictDetails {
  path: string;
  current_sha: string;
  current_raw: string;
  base_sha: string;
  base_raw: string;
  attempted_frontmatter: WikiPageFrontmatter;
  attempted_body: string;
}

// ---------- Search + Ask (M6) ----------

/**
 * Where the result row came from. `ai_search` is Cloudflare AI Search's
 * hybrid (vector + BM25) result; `fts5` is the on-D1 fallback path used
 * when AI Search is unavailable or its index hasn't been built yet.
 */
export type WikiSearchSource = "ai_search" | "fts5";

/**
 * `hybrid` = AI Search returned. `fts5_fallback` = AI Search was
 * skipped/unavailable and only D1 FTS5 results are present. The UI
 * uses this to show a "semantic search unavailable" banner so users
 * understand why ranking might feel keyword-y today.
 */
export type WikiSearchMode = "hybrid" | "fts5_fallback";

export interface WikiSearchResult {
  /** Vault path, e.g. `/wiki/concepts/dmarc.md`. */
  path: string;
  title: string;
  kind: WikiPageKind;
  /**
   * Pre-rendered snippet. For FTS5 results it contains `<mark>...</mark>`
   * tags around matched terms — render via the helper that converts
   * those into React `<mark>` elements (NOT innerHTML).
   */
  snippet: string;
  score: number;
  source: WikiSearchSource;
}

export interface WikiSearchResponse {
  results: WikiSearchResult[];
  mode: WikiSearchMode;
}

export interface AskCitation {
  /** Vault path, e.g. `/wiki/concepts/dmarc.md`. */
  path: string;
  title: string;
  kind: WikiPageKind;
  /** Slugified heading anchor, or null when the chunk had no heading. */
  heading_slug: string | null;
}

/**
 * Shape of the `error.details` field on a 429 RATE_LIMITED. Surfaced in
 * the RateLimitBanner. `scope` selects the wording (per-user vs the
 * shared workspace bucket); `reset_at` is ISO-8601.
 */
export interface RateLimitDetails {
  limit: number;
  used: number;
  scope: "user" | "workspace";
  reset_at: string;
}

// ---------- Inbox / proposals (M7) ----------

export type ProposalAction = "create" | "update";
export type ProposalStatus = "pending" | "merged" | "rejected" | "superseded";
export type IngestRunStatus = "running" | "succeeded" | "failed";

export interface SerializedProposal {
  id: string;
  run_id: string;
  page_path: string;
  action: ProposalAction;
  before_sha: string | null;
  after_content: string;
  rationale: string;
  status: ProposalStatus;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  artifacts_commit: string | null;
}

export interface SerializedIngestRun {
  id: string;
  room_id: string;
  triggered_by: string;
  started_at: string;
  finished_at: string | null;
  last_message_id: string | null;
  status: IngestRunStatus;
  summary: string | null;
  error: string | null;
}

export interface ProposalsListResponse {
  proposals: SerializedProposal[];
}

export interface ProposalCountResponse {
  status: ProposalStatus;
  count: number;
}

export interface ProposalDetailResponse {
  proposal: SerializedProposal;
}

export interface MergeProposalResponse {
  merged: true;
  page_path: string;
  sha: string;
}

export interface RejectProposalResponse {
  rejected: true;
  proposal_id: string;
}

export interface TriggerIngestResponse {
  run_id: string;
  status: "running" | "lock_held";
}

export interface RunDetailResponse {
  run: SerializedIngestRun;
}
