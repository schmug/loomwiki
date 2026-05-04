// SPDX-License-Identifier: Apache-2.0

// Tests for the vault-bootstrap library. We exercise the InMemoryWikiBackend
// to keep these tests deterministic and free of the Artifacts binding (which
// is "remote-only" in miniflare and would force network calls). The
// Artifacts binding lifecycle is exercised by the route-level tests via
// a fake-Artifacts fixture.
//
// What this test owns: idempotency, no-overwrite semantics, and that all
// /wiki/** template files end up in the backend.

import { describe, expect, it } from "vitest";
import { bootstrapVault } from "../lib/vault-bootstrap.js";
import { InMemoryWikiBackend } from "../lib/wiki-backend.js";
import { fakeEnv } from "./__fixtures__/fake-artifacts.js";

describe("bootstrapVault", () => {
  it("seeds /wiki/_index.md and /wiki/_open-questions.md on first run", async () => {
    const backend = new InMemoryWikiBackend();
    const env = fakeEnv();
    const result = await bootstrapVault(env, backend);

    expect(result.seededPaths).toContain("/wiki/_index.md");
    expect(result.seededPaths).toContain("/wiki/_open-questions.md");
    expect(await backend.listPaths()).toEqual(
      expect.arrayContaining(["/wiki/_index.md", "/wiki/_open-questions.md"]),
    );
  });

  it("skips top-level vault files (/AGENTS.md, /README.md) for the KV-only v0.0.1 backend", async () => {
    // Top-level files are part of the vault per SPEC §7.2 but live
    // outside /wiki/. M4.5 will push them via git; M4 only persists
    // them in the manifest, not in the wiki backend.
    const backend = new InMemoryWikiBackend();
    const env = fakeEnv();
    const result = await bootstrapVault(env, backend);
    expect(result.skippedPaths).toEqual(expect.arrayContaining(["/AGENTS.md", "/README.md"]));
    expect(await backend.read("/AGENTS.md")).toBeNull();
    expect(await backend.read("/README.md")).toBeNull();
  });

  it("is idempotent: a second run seeds nothing new", async () => {
    const backend = new InMemoryWikiBackend();
    const env = fakeEnv();
    const first = await bootstrapVault(env, backend);
    const sizeAfterFirst = backend.size();

    const second = await bootstrapVault(env, backend);
    expect(second.seededPaths).toEqual([]);
    // Every /wiki/** path from first becomes a skipped on second.
    for (const p of first.seededPaths) {
      expect(second.skippedPaths).toContain(p);
    }
    expect(backend.size()).toBe(sizeAfterFirst);
  });

  it("only fills in missing paths on a partial-seed re-run", async () => {
    const backend = new InMemoryWikiBackend();
    const env = fakeEnv();
    // Pretend a previous bootstrap seeded only /wiki/_index.md.
    await backend.write({
      path: "/wiki/_index.md",
      raw: "---\ntitle: Pre-existing\nkind: concept\ncreated: 2026-01-01\nlast_updated: 2026-01-01\nstatus: published\n---\n\nbody\n",
      sha: "preexisting",
    });
    const result = await bootstrapVault(env, backend);
    expect(result.skippedPaths).toContain("/wiki/_index.md");
    expect(result.seededPaths).not.toContain("/wiki/_index.md");

    // The pre-existing record is preserved unchanged.
    const preserved = await backend.read("/wiki/_index.md");
    expect(preserved?.sha).toBe("preexisting");
  });
});
