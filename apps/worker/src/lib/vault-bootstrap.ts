// SPDX-License-Identifier: Apache-2.0

// Idempotent vault bootstrap. On first request that needs the vault we
// (a) create the Artifacts repo if missing (binding-side; see
// lib/artifacts.ts), and (b) seed the wiki backend with the
// vault-template files for any path that doesn't already exist. Never
// overwrites existing pages.
//
// The bootstrap is split between the binding (repo lifecycle) and the
// content backend (page storage) — see ADR-0003. M4.5 will additionally
// push the seed files into the git remote so `git clone` returns them.

import { isVaultTopLevelPath, validateWikiPath } from "@loomwiki/schema";
import type { Env } from "../env.js";
import {
  VAULT_TEMPLATE_FILES,
  type VaultTemplateFile,
} from "../generated/vault-template-manifest.js";
import { getOrCreateVaultRepo } from "./artifacts.js";
import { KvWikiBackend, type WikiBackend } from "./wiki-backend.js";
import { deserializePage, serializePage } from "./wiki-content.js";

export interface BootstrapResult {
  /** Repo identifier the vault was created or fetched as. */
  repoName: string;
  /** Public HTTPS git remote URL. */
  remote: string;
  /** Paths that the bootstrap routine wrote (skipping pre-existing ones). */
  seededPaths: string[];
  /** Paths that already existed and were left untouched. */
  skippedPaths: string[];
}

/**
 * Bootstrap the vault. Safe to call repeatedly — the second call seeds
 * nothing because every template path will already be present.
 *
 * The `backend` parameter is injected so tests can pass an
 * InMemoryWikiBackend; production routes pass `new KvWikiBackend(env.WIKI_KV)`.
 */
export async function bootstrapVault(env: Env, backend: WikiBackend): Promise<BootstrapResult> {
  const repo = await getOrCreateVaultRepo(env);

  const seededPaths: string[] = [];
  const skippedPaths: string[] = [];

  for (const file of VAULT_TEMPLATE_FILES) {
    const path = file.path;

    // Top-level vault files (/AGENTS.md, /README.md) live outside
    // /wiki/. They are read-only via the M4 wiki API but the
    // bootstrap still seeds them so a `git clone` of the eventual
    // M4.5-pushed vault contains them. For the KV backend, we
    // currently only persist /wiki/** paths — top-level files are
    // skipped here, with a note that M4.5 will start pushing them.
    if (isVaultTopLevelPath(path)) {
      skippedPaths.push(path);
      continue;
    }

    if (!validateWikiPath(path)) {
      // The template should never contain invalid paths; this is a
      // build-time invariant. Surface loudly if a contributor adds a
      // bad file (e.g. uppercase, missing .md).
      throw new Error(`vault-template emits an invalid wiki path: ${path}`);
    }

    const existing = await backend.read(path);
    if (existing !== null) {
      skippedPaths.push(path);
      continue;
    }

    await writeTemplateFile(backend, file);
    seededPaths.push(path);
  }

  return {
    repoName: repo.name,
    remote: repo.remote,
    seededPaths,
    skippedPaths,
  };
}

async function writeTemplateFile(backend: WikiBackend, file: VaultTemplateFile): Promise<void> {
  // Template files contain valid frontmatter + body. We round-trip
  // through deserialize → serialize so the SHA we record in KV
  // matches what a future writer would compute, and so the seed text
  // is byte-stable across regenerations of the manifest.
  const parsed = await deserializePage(file.content);
  const serialized = await serializePage(parsed.frontmatter, parsed.body);
  await backend.write({
    path: file.path,
    raw: serialized.raw,
    sha: serialized.sha,
  });
}

/** Convenience for prod routes: build the default backend from env. */
export function defaultWikiBackend(env: Env): WikiBackend {
  return new KvWikiBackend(env.WIKI_KV);
}
