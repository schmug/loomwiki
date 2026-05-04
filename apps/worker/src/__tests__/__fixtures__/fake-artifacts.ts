// SPDX-License-Identifier: Apache-2.0

// In-memory fake of the Cloudflare Artifacts Workers binding. Conforms
// to the typed surface in apps/worker/src/artifacts-binding.d.ts so
// route + library tests can exercise the binding paths without the
// real (remote-only) Artifacts service.
//
// What this fakes: repo lifecycle (create / get / list / delete) and
// repo-handle methods (createToken / listTokens / revokeToken / fork).
// What it doesn't fake: file-level git operations (those don't exist
// on the binding either; M4.5 will mock those at a different seam).

import type {
  ArtifactsBinding,
  ArtifactsCreateRepoResult,
  ArtifactsCreateTokenResult,
  ArtifactsRepo,
  ArtifactsRepoInfo,
  ArtifactsTokenInfo,
  ArtifactsTokenListResult,
} from "../../artifacts-binding.js";
import type { Env } from "../../env.js";

interface FakeRepoState {
  info: ArtifactsRepoInfo;
  tokens: Map<string, ArtifactsTokenInfo & { plaintext: string }>;
}

let __counter = 0;
function nextId(prefix: string): string {
  __counter += 1;
  return `${prefix}_${__counter.toString(16).padStart(8, "0")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class FakeArtifactsBinding implements ArtifactsBinding {
  private readonly repos = new Map<string, FakeRepoState>();

  async create(
    name: string,
    opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
  ): Promise<ArtifactsCreateRepoResult> {
    if (this.repos.has(name)) {
      throw new Error(`fake-artifacts: repo "${name}" already exists`);
    }
    const id = nextId("repo");
    const defaultBranch = opts?.setDefaultBranch ?? "main";
    const info: ArtifactsRepoInfo = {
      id,
      name,
      description: opts?.description ?? null,
      defaultBranch,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastPushAt: null,
      source: null,
      readOnly: opts?.readOnly ?? false,
      remote: `https://artifacts.example/${name}.git`,
    };
    const state: FakeRepoState = { info, tokens: new Map() };
    this.repos.set(name, state);
    const initialToken = mintFakeToken(state, "write", 86400);
    return {
      id: info.id,
      name: info.name,
      description: info.description,
      defaultBranch: info.defaultBranch,
      remote: info.remote,
      token: initialToken.plaintext,
      tokenExpiresAt: initialToken.expiresAt,
    };
  }

  async get(name: string): Promise<ArtifactsRepo> {
    const state = this.repos.get(name);
    if (!state) {
      throw new Error(`fake-artifacts: repo "${name}" not found`);
    }
    return repoHandle(state);
  }

  async delete(name: string): Promise<boolean> {
    return this.repos.delete(name);
  }

  async list(opts?: { limit?: number; cursor?: string }): Promise<{
    repos: Omit<ArtifactsRepoInfo, "remote">[];
    total: number;
    cursor?: string;
  }> {
    const all = [...this.repos.values()].map(({ info }) => {
      const { remote: _remote, ...rest } = info;
      return rest;
    });
    const limit = Math.min(opts?.limit ?? 50, 200);
    return { repos: all.slice(0, limit), total: all.length };
  }
}

function repoHandle(state: FakeRepoState): ArtifactsRepo {
  return {
    ...state.info,
    async createToken(scope = "write", ttl = 86400) {
      return mintFakeToken(state, scope, ttl);
    },
    async listTokens(): Promise<ArtifactsTokenListResult> {
      const tokens: ArtifactsTokenInfo[] = [...state.tokens.values()].map((t) => ({
        id: t.id,
        scope: t.scope,
        state: t.state,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
      }));
      return { tokens, total: tokens.length };
    },
    async revokeToken(tokenOrId: string): Promise<boolean> {
      // Try by plaintext first, then by id.
      for (const t of state.tokens.values()) {
        if (t.plaintext === tokenOrId || t.id === tokenOrId) {
          t.state = "revoked";
          return true;
        }
      }
      return false;
    },
    async fork(forkName, opts) {
      const fakeBinding = new FakeArtifactsBinding();
      // We don't share a registry with the parent; tests that need to
      // fork should construct their own and wire by hand.
      return fakeBinding.create(forkName, opts);
    },
  };
}

function mintFakeToken(
  state: FakeRepoState,
  scope: "read" | "write",
  ttlSeconds: number,
): ArtifactsCreateTokenResult {
  const id = nextId("tok");
  const plaintext = `fake-${id}`;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const info: ArtifactsTokenInfo & { plaintext: string } = {
    id,
    scope,
    state: "active",
    createdAt: nowIso(),
    expiresAt,
    plaintext,
  };
  state.tokens.set(id, info);
  return { id, plaintext, scope, expiresAt };
}

/**
 * Helper that returns an Env-like object containing a fresh fake
 * Artifacts binding plus the rest of the test bindings. Useful in tests
 * that don't go through SELF (which would use the real binding from
 * cloudflare:test). For SELF-based tests, the real binding still gets
 * used and the test asserts only on the M4 backend (KV) side.
 */
export function fakeEnv(repoName = "loomwiki-vault"): Env {
  const artifacts = new FakeArtifactsBinding();
  // Return a minimal Env shape — only the fields the bootstrap path
  // touches are populated. Other fields are typed `any` here because
  // tests that need them should construct their own env.
  return {
    ARTIFACTS: artifacts,
    ARTIFACTS_REPO: repoName,
    // Fields below aren't read by bootstrapVault, but TS demands them.
    // We cast to `unknown` to keep this fake narrow.
  } as unknown as Env;
}
