// SPDX-License-Identifier: Apache-2.0

// Typed wrapper around the Cloudflare Artifacts Workers binding.
//
// The binding (env.ARTIFACTS) only exposes repo lifecycle operations:
//
//   create(name, opts?)   → ArtifactsCreateRepoResult (with initial token)
//   get(name)             → ArtifactsRepo handle (createToken/listTokens/...)
//   list/delete/import
//
// File-level CRUD is NOT on the binding — file ops happen via the standard
// git protocol against repo.remote, which lands in M4.5. M4 uses this
// wrapper for two things:
//   1. Idempotently get-or-create the workspace's vault repo on demand.
//   2. Mint a short-lived write/read token so an operator can `git clone`
//      the vault from outside (the `vault-token` admin route).
//
// Page content storage in v0.0.1 lives in WIKI_KV; see
// lib/wiki-backend.ts. ADR-0003 captures the architectural rationale.

import { ErrorCodes, LoomwikiError } from "@loomwiki/shared";
import type {
  ArtifactsCreateRepoResult,
  ArtifactsCreateTokenResult,
  ArtifactsRepo,
} from "../artifacts-binding.js";
import type { Env } from "../env.js";

const REPO_NAME_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;

/**
 * Idempotently fetch (or create) the workspace's Artifacts vault repo.
 *
 * Concurrent first-time access races on `get` first; whichever caller
 * lands a NotFound falls through to `create`. The Artifacts namespace
 * dedups on `name`, so even if two callers race the create() call only
 * one of them wins server-side and the other sees a name-already-exists
 * error which we map to a re-`get`.
 */
export async function getOrCreateVaultRepo(env: Env): Promise<ArtifactsRepo> {
  assertValidRepoName(env.ARTIFACTS_REPO);
  if (!env.ARTIFACTS) {
    throw new LoomwikiError(
      ErrorCodes.INTERNAL_ERROR,
      "Cloudflare Artifacts binding is not available on this account. " +
        "Artifacts is allowlist-gated; the v0.0.1 wiki content path uses " +
        "WIKI_KV and does not require it. Re-enable the `artifacts` binding " +
        "in wrangler.jsonc once your account has Artifacts beta access.",
      { status: 503 },
    );
  }
  try {
    return await env.ARTIFACTS.get(env.ARTIFACTS_REPO);
  } catch (cause) {
    // The binding throws on not-found; we don't have a typed error class
    // to discriminate, so we attempt create() and fall back to get() on
    // a name-collision error from a racing caller.
    try {
      const created: ArtifactsCreateRepoResult = await env.ARTIFACTS.create(env.ARTIFACTS_REPO, {
        description: "Loomwiki vault — auto-created on first use",
      });
      // create() returns metadata + an initial token but no repo handle;
      // round-trip through get() so the caller has token-mint methods.
      return await env.ARTIFACTS.get(created.name);
    } catch (createErr) {
      // Recover the racing-create case: another invocation got there first.
      try {
        return await env.ARTIFACTS.get(env.ARTIFACTS_REPO);
      } catch {
        throw new LoomwikiError(
          ErrorCodes.INTERNAL_ERROR,
          `Failed to create or get Artifacts vault repo "${env.ARTIFACTS_REPO}"`,
          { status: 500, cause: createErr ?? cause },
        );
      }
    }
  }
}

/**
 * Mint a short-lived write token for the operator to `git clone` the
 * vault from outside. Default TTL is 1 hour; the binding allows
 * 60..31_536_000 seconds.
 */
export async function mintVaultToken(
  env: Env,
  scope: "read" | "write" = "write",
  ttlSeconds = 3600,
): Promise<ArtifactsCreateTokenResult & { remote: string; repoName: string }> {
  const repo = await getOrCreateVaultRepo(env);
  const token = await repo.createToken(scope, ttlSeconds);
  return { ...token, remote: repo.remote, repoName: repo.name };
}

/**
 * Validate a repo name for the Artifacts namespace. Repo names must be
 * alphanumeric with dots, hyphens, or underscores; the binding will
 * also reject malformed names but failing earlier produces a nicer
 * error code at the route layer.
 */
function assertValidRepoName(name: string): void {
  if (!REPO_NAME_REGEX.test(name)) {
    throw new LoomwikiError(
      ErrorCodes.INTERNAL_ERROR,
      `Invalid Artifacts repo name "${name}" — must match ${REPO_NAME_REGEX}`,
      { status: 500 },
    );
  }
}
