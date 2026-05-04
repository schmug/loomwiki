// SPDX-License-Identifier: Apache-2.0

// BYOK lookup placeholder for M8. M6 ships the abstraction so `llm.ts`
// can already invoke it; M8 swaps in the envelope-decryption logic
// against the `byok_keys` D1 table provisioned in M1.
//
// Contract (frozen, M8 must preserve):
//   getBYOK(env, workspaceId, provider) returns the plaintext API key
//   for the workspace + provider, or `null` if no key is set up.
//
// In M6 the function ALWAYS returns null. The body still queries D1 so
// the request shape (binding + table presence) is exercised in tests —
// the M8 patch is then "decrypt the row we already fetched", not "wire
// up the query". Test assertions for the M6 null-contract live in
// __tests__/byok.test.ts.

import type { Env } from "../env.js";

export type ByokProvider = "anthropic" | "openai" | "google";

const KNOWN_PROVIDERS: ReadonlySet<ByokProvider> = new Set([
  "anthropic",
  "openai",
  "google",
]);

export function isKnownByokProvider(value: unknown): value is ByokProvider {
  return typeof value === "string" && KNOWN_PROVIDERS.has(value as ByokProvider);
}

/**
 * Look up a BYOK API key for `(workspaceId, provider)`. Returns null if
 * no row exists OR if the row exists but cannot be decrypted (M8 will
 * differentiate; M6 always returns null and never decrypts).
 *
 * M6 deliberately never throws on a missing key — callers expect null
 * to mean "use the workspace default LLM" (Workers AI for v0.0.1).
 */
export async function getBYOK(
  env: Env,
  workspaceId: string,
  provider: ByokProvider,
): Promise<string | null> {
  if (!isKnownByokProvider(provider)) return null;

  // Touch D1 so the request shape is wired even though M6 doesn't
  // decrypt yet. A missing row → null. A present row → still null in
  // M6 (M8 plug-in point: decrypt(row.iv, row.ciphertext) here).
  const row = await env.DB.prepare(
    "SELECT 1 AS present FROM byok_keys WHERE workspace_id = ? AND provider = ?",
  )
    .bind(workspaceId, provider)
    .first();

  if (row === null) return null;
  // M8 plug-in point: replace this with envelope decryption.
  return null;
}
