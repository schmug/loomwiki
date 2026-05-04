// SPDX-License-Identifier: Apache-2.0

// Local declaration of the Cloudflare Artifacts Workers binding shape.
// `pnpm wrangler types` writes the same surface to
// apps/worker/worker-configuration.d.ts, but including that file in the
// project conflicts with @cloudflare/workers-types (both declare Request,
// Headers, etc.). Rather than swap the entire type-source, we re-declare
// just the Artifacts surface here. Mirror this file with the upstream
// generated types whenever wrangler is rerun — kept narrow to make
// drift obvious.
//
// Source: cloudflare/workerd `Artifacts` interface generated for
// compat date 2026-04-22.

export interface ArtifactsRepoInfo {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
  source: string | null;
  readOnly: boolean;
  remote: string;
}

export interface ArtifactsCreateRepoResult {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  remote: string;
  token: string;
  tokenExpiresAt: string;
}

export interface ArtifactsCreateTokenResult {
  id: string;
  plaintext: string;
  scope: "read" | "write";
  expiresAt: string;
}

export interface ArtifactsTokenInfo {
  id: string;
  scope: "read" | "write";
  state: "active" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
}

export interface ArtifactsTokenListResult {
  tokens: ArtifactsTokenInfo[];
  total: number;
}

export interface ArtifactsRepo extends ArtifactsRepoInfo {
  createToken(scope?: "write" | "read", ttl?: number): Promise<ArtifactsCreateTokenResult>;
  listTokens(): Promise<ArtifactsTokenListResult>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  fork(
    name: string,
    opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean },
  ): Promise<ArtifactsCreateRepoResult>;
}

export interface ArtifactsBinding {
  create(
    name: string,
    opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
  ): Promise<ArtifactsCreateRepoResult>;
  get(name: string): Promise<ArtifactsRepo>;
  delete(name: string): Promise<boolean>;
  list(opts?: { limit?: number; cursor?: string }): Promise<{
    repos: Omit<ArtifactsRepoInfo, "remote">[];
    total: number;
    cursor?: string;
  }>;
}
