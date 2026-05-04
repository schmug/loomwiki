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
