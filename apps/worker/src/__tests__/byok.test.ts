// SPDX-License-Identifier: Apache-2.0

// M6 contract test: byok.ts always returns null in M6 (M8 plug-in
// point). The test exists so the M8 PR sees an explicit failure when it
// flips the contract — that's the moment to update the test (and the
// rest of the BYOK plumbing).

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getBYOK, isKnownByokProvider } from "../lib/byok.js";
import { getOrCreateUser } from "../lib/users.js";
import { DEFAULT_WORKSPACE_ID, getOrBootstrapWorkspace } from "../lib/workspace.js";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await resetDb();
});

describe("isKnownByokProvider", () => {
  it("recognizes the three v0.0.1 providers and rejects everything else", () => {
    expect(isKnownByokProvider("anthropic")).toBe(true);
    expect(isKnownByokProvider("openai")).toBe(true);
    expect(isKnownByokProvider("google")).toBe(true);
    expect(isKnownByokProvider("cohere")).toBe(false);
    expect(isKnownByokProvider("")).toBe(false);
    expect(isKnownByokProvider(undefined)).toBe(false);
  });
});

describe("getBYOK (M6 null contract)", () => {
  it("returns null when no row exists", async () => {
    const user = await getOrCreateUser(env, "owner@example.com");
    await getOrBootstrapWorkspace(env, user.id);

    const key = await getBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic");
    expect(key).toBeNull();
  });

  it("returns null even when a (cipherless) row IS present (M6 placeholder)", async () => {
    const user = await getOrCreateUser(env, "owner@example.com");
    await getOrBootstrapWorkspace(env, user.id);

    // Plant a row directly so we exercise the present-row branch.
    await env.DB.prepare(
      "INSERT INTO byok_keys (workspace_id, provider, ciphertext, iv, created_by) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        DEFAULT_WORKSPACE_ID,
        "anthropic",
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4]),
        user.id,
      )
      .run();

    const key = await getBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic");
    // M6 contract: still null. M8 plug-in point flips this to the
    // decrypted plaintext key.
    expect(key).toBeNull();
  });

  it("returns null for an unknown provider without touching D1", async () => {
    const user = await getOrCreateUser(env, "owner@example.com");
    await getOrBootstrapWorkspace(env, user.id);

    // biome-ignore lint/suspicious/noExplicitAny: testing the runtime guard
    const key = await getBYOK(env, DEFAULT_WORKSPACE_ID, "cohere" as any);
    expect(key).toBeNull();
  });
});
