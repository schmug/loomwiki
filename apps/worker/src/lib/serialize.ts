// SPDX-License-Identifier: Apache-2.0

// D1 stores times as unix epoch seconds (CLAUDE.md). Routes return ISO-8601
// strings — convert here, in one place, so wire format never drifts from
// internal representation.

import type { Room, User, Workspace } from "@loomwiki/schema/parsers";

export function epochToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export interface SerializedUser {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
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

export function serializeUser(u: User): SerializedUser {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    created_at: epochToIso(u.created_at),
  };
}

export function serializeWorkspace(w: Workspace): SerializedWorkspace {
  return {
    id: w.id,
    name: w.name,
    owner_id: w.owner_id,
    vault_repo: w.vault_repo,
    ai_search_id: w.ai_search_id,
    created_at: epochToIso(w.created_at),
  };
}

export function serializeRoom(r: Room): SerializedRoom {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    slug: r.slug,
    name: r.name,
    topic: r.topic,
    created_by: r.created_by,
    created_at: epochToIso(r.created_at),
  };
}

// ---------- M7: ingest runs + proposals ----------

import type { IngestRunRow, ProposalRow } from "@loomwiki/schema/parsers";

export interface SerializedIngestRun {
  id: string;
  room_id: string;
  triggered_by: string;
  started_at: string;
  finished_at: string | null;
  last_message_id: string | null;
  status: "running" | "succeeded" | "failed";
  summary: string | null;
  error: string | null;
}

export function serializeIngestRun(r: IngestRunRow): SerializedIngestRun {
  return {
    id: r.id,
    room_id: r.room_id,
    triggered_by: r.triggered_by,
    started_at: epochToIso(r.started_at),
    finished_at: r.finished_at === null ? null : epochToIso(r.finished_at),
    last_message_id: r.last_message_id,
    status: r.status,
    summary: r.summary,
    error: r.error,
  };
}

export interface SerializedProposal {
  id: string;
  run_id: string;
  page_path: string;
  action: "create" | "update";
  before_sha: string | null;
  after_content: string;
  rationale: string;
  status: "pending" | "merged" | "rejected" | "superseded";
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  artifacts_commit: string | null;
}

export function serializeProposal(p: ProposalRow): SerializedProposal {
  return {
    id: p.id,
    run_id: p.run_id,
    page_path: p.page_path,
    action: p.action,
    before_sha: p.before_sha,
    after_content: p.after_content,
    rationale: p.rationale,
    status: p.status,
    created_at: epochToIso(p.created_at),
    reviewed_at: p.reviewed_at === null ? null : epochToIso(p.reviewed_at),
    reviewed_by: p.reviewed_by,
    artifacts_commit: p.artifacts_commit,
  };
}
