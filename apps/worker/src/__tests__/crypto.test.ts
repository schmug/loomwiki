// SPDX-License-Identifier: Apache-2.0

// Envelope-encryption round-trip tests for the M8 BYOK crypto layer.

import { describe, expect, it } from "vitest";
import {
  BYOK_DELETED_CIPHERTEXT,
  decryptValue,
  encryptValue,
  generateTestMasterKeyB64,
  isDeletedCiphertext,
} from "../lib/crypto.js";

describe("envelope encryption", () => {
  it("round-trips a single value", async () => {
    const master = generateTestMasterKeyB64();
    const { ciphertext, iv } = await encryptValue("sk-ant-test-1234567890", master);
    const out = await decryptValue(ciphertext, iv, master);
    expect(out).toBe("sk-ant-test-1234567890");
  });

  it("produces different ciphertexts for the same plaintext (fresh IV)", async () => {
    const master = generateTestMasterKeyB64();
    const a = await encryptValue("hello", master);
    const b = await encryptValue("hello", master);
    expect(Array.from(a.iv)).not.toEqual(Array.from(b.iv));
    expect(Array.from(a.ciphertext)).not.toEqual(Array.from(b.ciphertext));
  });

  it("fails to decrypt with a different master key (auth tag rejects)", async () => {
    const masterA = generateTestMasterKeyB64();
    const masterB = generateTestMasterKeyB64();
    const { ciphertext, iv } = await encryptValue("payload", masterA);
    await expect(decryptValue(ciphertext, iv, masterB)).rejects.toMatchObject({
      code: "BYOK_DECRYPT_FAILED",
    });
  });

  it("fails to decrypt with a wrong IV", async () => {
    const master = generateTestMasterKeyB64();
    const { ciphertext } = await encryptValue("payload", master);
    const wrongIv = new Uint8Array(12); // all zeros
    await expect(decryptValue(ciphertext, wrongIv, master)).rejects.toMatchObject({
      code: "BYOK_DECRYPT_FAILED",
    });
  });

  it("fails to decrypt tampered ciphertext (AES-GCM authenticates)", async () => {
    const master = generateTestMasterKeyB64();
    const { ciphertext, iv } = await encryptValue("payload", master);
    // Flip a bit in the middle of the ciphertext
    const tampered = new Uint8Array(ciphertext);
    if (tampered.length > 0) {
      const target = tampered[Math.floor(tampered.length / 2)] as number;
      tampered[Math.floor(tampered.length / 2)] = target ^ 0x01;
    }
    await expect(decryptValue(tampered, iv, master)).rejects.toMatchObject({
      code: "BYOK_DECRYPT_FAILED",
    });
  });

  it("rejects an IV that isn't 12 bytes", async () => {
    const master = generateTestMasterKeyB64();
    const ciphertext = new Uint8Array([1, 2, 3, 4]);
    await expect(decryptValue(ciphertext, new Uint8Array(8), master)).rejects.toMatchObject({
      code: "BYOK_DECRYPT_FAILED",
    });
  });

  it("rejects a missing / wrong-size master key", async () => {
    await expect(encryptValue("x", "")).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    await expect(encryptValue("x", "dGVzdA==")).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it("survives a stability sweep", async () => {
    const master = generateTestMasterKeyB64();
    for (let i = 0; i < 100; i++) {
      const value = `value-${i}-${crypto.randomUUID()}`;
      const { ciphertext, iv } = await encryptValue(value, master);
      expect(await decryptValue(ciphertext, iv, master)).toBe(value);
    }
  });

  it("handles unicode plaintext (BYOK keys are ASCII but document the contract)", async () => {
    const master = generateTestMasterKeyB64();
    const value = "café-€-汉字-🔑";
    const { ciphertext, iv } = await encryptValue(value, master);
    expect(await decryptValue(ciphertext, iv, master)).toBe(value);
  });
});

describe("soft-delete sentinel", () => {
  it("recognizes the documented sentinel value", () => {
    expect(isDeletedCiphertext(BYOK_DELETED_CIPHERTEXT)).toBe(true);
    expect(isDeletedCiphertext(new Uint8Array([0x00]))).toBe(true);
  });

  it("does not treat a normal ciphertext as deleted", () => {
    expect(isDeletedCiphertext(new Uint8Array([0x01]))).toBe(false);
    expect(isDeletedCiphertext(new Uint8Array([0x00, 0x00]))).toBe(false);
    expect(isDeletedCiphertext(new Uint8Array(0))).toBe(false);
  });
});
