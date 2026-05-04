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
