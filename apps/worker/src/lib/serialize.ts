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
