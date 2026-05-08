// SPDX-License-Identifier: Apache-2.0

// M8 BYOK envelope-encryption tests. Replaces the M6 null-contract
// tests now that byok.ts decrypts real rows.

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  deleteBYOK,
  getBYOK,
  isKnownByokProvider,
  listBYOK,
  resolveProviderForModel,
  setBYOK,
} from "../lib/byok.js";
import { generateTestMasterKeyB64 } from "../lib/crypto.js";
import { getOrCreateUser } from "../lib/users.js";
import { DEFAULT_WORKSPACE_ID, getOrBootstrapWorkspace } from "../lib/workspace.js";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await resetDb();
  // Inject a fresh master key per test. The Env type marks
  // BYOK_ENCRYPTION_KEY optional; in production it's a Worker secret.
  // biome-ignore lint/suspicious/noExplicitAny: setting optional secret on env
  (env as any).BYOK_ENCRYPTION_KEY = generateTestMasterKeyB64();
});

async function bootstrap(): Promise<{ userId: string }> {
  const user = await getOrCreateUser(env, "owner@example.com");
  await getOrBootstrapWorkspace(env, user.id);
  return { userId: user.id };
}

describe("isKnownByokProvider", () => {
  it("recognizes the v0.0.1 providers and rejects everything else", () => {
    expect(isKnownByokProvider("anthropic")).toBe(true);
    expect(isKnownByokProvider("openai")).toBe(true);
    expect(isKnownByokProvider("google")).toBe(true);
    expect(isKnownByokProvider("cohere")).toBe(false);
    expect(isKnownByokProvider("")).toBe(false);
    expect(isKnownByokProvider(undefined)).toBe(false);
  });
});

describe("setBYOK + getBYOK round-trip", () => {
  it("persists an Anthropic key and decrypts it back", async () => {
    const { userId } = await bootstrap();
    const meta = await setBYOK(
      env,
      DEFAULT_WORKSPACE_ID,
      "anthropic",
      "sk-ant-test-1234567890",
      userId,
    );
    expect(meta.has_key).toBe(true);
    expect(meta.created_by).toBe(userId);
    expect(meta.last_used_at).toBeNull();

    const plaintext = await getBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic");
    expect(plaintext).toBe("sk-ant-test-1234567890");
  });

  it("persists an OpenAI key", async () => {
    const { userId } = await bootstrap();
    await setBYOK(env, DEFAULT_WORKSPACE_ID, "openai", "sk-openai-aaaaaaaa", userId);
    expect(await getBYOK(env, DEFAULT_WORKSPACE_ID, "openai")).toBe("sk-openai-aaaaaaaa");
  });

  it("returns null when no row exists", async () => {
    await bootstrap();
    expect(await getBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic")).toBeNull();
  });

  it("returns null for an unknown provider without touching D1", async () => {
    await bootstrap();
    // biome-ignore lint/suspicious/noExplicitAny: testing the runtime guard
    expect(await getBYOK(env, DEFAULT_WORKSPACE_ID, "cohere" as any)).toBeNull();
  });

  it("rejects keys with the wrong format (Anthropic must start with sk-ant-)", async () => {
    const { userId } = await bootstrap();
    await expect(
      setBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic", "wrong-prefix-abcdefgh", userId),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects empty / too-short keys", async () => {
    const { userId } = await bootstrap();
    await expect(setBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic", "", userId)).rejects.toMatchObject(
      { code: "VALIDATION_FAILED" },
    );
  });

  it("replaces an existing key on second set", async () => {
    const { userId } = await bootstrap();
    await setBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic", "sk-ant-aaaaaaaa", userId);
    await setBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic", "sk-ant-bbbbbbbb", userId);
    expect(await getBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic")).toBe("sk-ant-bbbbbbbb");
  });

  it("updates last_used_at on the read path", async () => {
    const { userId } = await bootstrap();
    await setBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic", "sk-ant-aaaaaaaa", userId);
    await getBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic");
    const list = await listBYOK(env, DEFAULT_WORKSPACE_ID);
    expect(list).toHaveLength(1);
    expect(list[0]?.last_used_at).not.toBeNull();
  });

  it("isolates by workspace_id", async () => {
    const { userId } = await bootstrap();
    await setBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic", "sk-ant-aaaaaaaa", userId);
    // A different workspace_id should not see this key.
    const otherWs = "01900000-0000-7000-8000-000000000001";
    expect(await getBYOK(env, otherWs, "anthropic")).toBeNull();
  });
});

describe("deleteBYOK", () => {
  it("soft-deletes a key (subsequent get returns null)", async () => {
    const { userId } = await bootstrap();
    await setBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic", "sk-ant-aaaaaaaa", userId);
    await deleteBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic");
    expect(await getBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic")).toBeNull();
  });

  it("preserves the row for audit trail (sentinel ciphertext, listBYOK filters it out)", async () => {
    const { userId } = await bootstrap();
    await setBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic", "sk-ant-aaaaaaaa", userId);
    await deleteBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic");

    // listBYOK hides soft-deleted rows
    const list = await listBYOK(env, DEFAULT_WORKSPACE_ID);
    expect(list).toEqual([]);

    // ...but the row still exists in D1
    const row = await env.DB.prepare(
      "SELECT created_by, ciphertext FROM byok_keys WHERE workspace_id = ? AND provider = ?",
    )
      .bind(DEFAULT_WORKSPACE_ID, "anthropic")
      .first<{ created_by: string; ciphertext: ArrayBuffer | Uint8Array }>();
    expect(row).not.toBeNull();
    const ciphertext =
      row?.ciphertext instanceof Uint8Array
        ? row.ciphertext
        : new Uint8Array(row?.ciphertext ?? new ArrayBuffer(0));
    expect(Array.from(ciphertext)).toEqual([0x00]);
  });

  it("is idempotent (deleting a missing key is not an error)", async () => {
    await bootstrap();
    await expect(deleteBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic")).resolves.toBeUndefined();
  });

  it("a subsequent set replaces the sentinel with a real ciphertext", async () => {
    const { userId } = await bootstrap();
    await setBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic", "sk-ant-aaaaaaaa", userId);
    await deleteBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic");
    await setBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic", "sk-ant-zzzzzzzz", userId);
    expect(await getBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic")).toBe("sk-ant-zzzzzzzz");
  });
});

describe("listBYOK metadata", () => {
  it("returns metadata only — never the plaintext or ciphertext", async () => {
    const { userId } = await bootstrap();
    await setBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic", "sk-ant-aaaaaaaa", userId);
    const list = await listBYOK(env, DEFAULT_WORKSPACE_ID);
    expect(list).toHaveLength(1);
    const meta = list[0];
    expect(meta).toBeDefined();
    if (!meta) throw new Error("unreachable");
    expect(meta.provider).toBe("anthropic");
    expect(meta.has_key).toBe(true);
    expect(meta.created_by).toBe(userId);
    // No plaintext / ciphertext / iv leak in the metadata shape
    const keys = Object.keys(meta);
    expect(keys).not.toContain("ciphertext");
    expect(keys).not.toContain("iv");
    expect(keys).not.toContain("key");
  });
});

describe("requires BYOK_ENCRYPTION_KEY", () => {
  it("setBYOK raises 503 when the secret is missing", async () => {
    const { userId } = await bootstrap();
    // biome-ignore lint/suspicious/noExplicitAny: clearing the secret to test the gate
    (env as any).BYOK_ENCRYPTION_KEY = undefined;
    await expect(
      setBYOK(env, DEFAULT_WORKSPACE_ID, "anthropic", "sk-ant-aaaaaaaa", userId),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 503 });
  });
});

describe("resolveProviderForModel", () => {
  it("returns null for Workers AI catalog ids", () => {
    expect(resolveProviderForModel("@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBeNull();
    expect(resolveProviderForModel("@cf/baai/bge-base-en-v1.5")).toBeNull();
  });

  it("maps the byok: sentinel models to providers", () => {
    expect(resolveProviderForModel("byok:anthropic")).toBe("anthropic");
    expect(resolveProviderForModel("byok:openai")).toBe("openai");
    expect(resolveProviderForModel("byok:google")).toBe("google");
  });

  it("infers provider from canonical SDK shapes", () => {
    expect(resolveProviderForModel("claude-opus-4-7")).toBe("anthropic");
    expect(resolveProviderForModel("gpt-4o")).toBe("openai");
    expect(resolveProviderForModel("gemini-1.5-pro")).toBe("google");
  });

  it("returns null on unknown / empty inputs", () => {
    expect(resolveProviderForModel(undefined)).toBeNull();
    expect(resolveProviderForModel("")).toBeNull();
    expect(resolveProviderForModel("mystery-9000")).toBeNull();
  });
});
