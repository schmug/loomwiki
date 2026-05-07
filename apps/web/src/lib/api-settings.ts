// SPDX-License-Identifier: Apache-2.0

// Typed helpers for the M8 settings routes (BYOK, AGENTS.md, workspace
// preferences). Mirrors the api-inbox / api-wiki shape: each helper
// returns the typed payload directly, or surfaces an ApiError for the
// caller to inspect.
//
// The plaintext BYOK key only ever travels client → worker on PUT; the
// server returns metadata only (no `key` field) so the UI can never
// show it back. See SettingsTabs / BYOKSettings for the
// don't-render-back-after-save rule.

import { apiGet, request } from "@/lib/api";

export type BYOKProvider = "anthropic" | "openai" | "google";

export interface BYOKKeyMetadata {
  workspace_id: string;
  provider: BYOKProvider;
  has_key: true;
  created_at: number;
  created_by: string;
  last_used_at: number | null;
}

export interface WorkspaceSettings {
  workspace_id: string;
  timezone: string;
  default_model: string;
  updated_at: number;
  updated_by: string | null;
}

export async function listBYOK(): Promise<BYOKKeyMetadata[]> {
  const data = await apiGet<{ keys: BYOKKeyMetadata[] }>("/api/settings/byok");
  return data.keys;
}

export function setBYOK(provider: string, key: string): Promise<BYOKKeyMetadata> {
  return request<BYOKKeyMetadata>(`/api/settings/byok/${encodeURIComponent(provider)}`, {
    method: "PUT",
    body: { key },
  });
}

export async function deleteBYOK(provider: string): Promise<void> {
  await request<{ deleted: true; provider: string }>(
    `/api/settings/byok/${encodeURIComponent(provider)}`,
    { method: "DELETE" },
  );
}

export function getAgentsMd(): Promise<{ content: string; sha: string | null }> {
  return apiGet<{ content: string; sha: string | null }>("/api/settings/agentsmd");
}

export function setAgentsMd(
  content: string,
  confirmed: boolean,
): Promise<{ saved: true; sha: string }> {
  return request<{ saved: true; sha: string }>("/api/settings/agentsmd", {
    method: "PUT",
    body: { content, confirmed },
  });
}

export async function getWorkspaceSettings(): Promise<WorkspaceSettings> {
  const data = await apiGet<{ settings: WorkspaceSettings }>("/api/settings/workspace");
  return data.settings;
}

export async function setWorkspaceSettings(opts: {
  timezone: string;
  default_model: string;
}): Promise<WorkspaceSettings> {
  const data = await request<{ settings: WorkspaceSettings }>("/api/settings/workspace", {
    method: "PUT",
    body: opts,
  });
  return data.settings;
}
