// SPDX-License-Identifier: Apache-2.0

// BYOK envelope encryption + storage layer (M8 / SPEC §22 / ADR-0006).
//
// Public surface (frozen — lib/llm.ts and the settings routes depend
// on these shapes):
//
//   getBYOK(env, workspaceId, provider) → plaintext key | null
//   setBYOK(env, workspaceId, provider, plaintextKey, actorUserId, ctx?)
//   deleteBYOK(env, workspaceId, provider, actorUserId, ctx?)
//   listBYOK(env, workspaceId) → BYOKKeyMetadata[]
//
// Plaintext contract: getBYOK is the ONLY function that returns a
// plaintext key, and the value lives only in memory inside lib/llm.ts
// for the duration of one HTTP request. listBYOK / setBYOK / deleteBYOK
// return metadata or void; the key is never echoed back, never
// written to logs, never stored unencrypted. AES-GCM-256 envelope
// encryption is in lib/crypto.ts; the master key (`BYOK_ENCRYPTION_KEY`
// Worker secret) is the secret root.
//
// Soft-delete: deleteBYOK overwrites the row's ciphertext with the
// documented sentinel (single 0x00 byte) and clears the IV, so a
// subsequent getBYOK returns null without attempting to decrypt. The
// row stays in D1 for audit-trail integrity (created_at / created_by
// remain queryable). A subsequent setBYOK overwrites the sentinel with
// a fresh ciphertext.

import { type BYOKKeyMetadata, BYOKKeyMetadataSchema, ByokProviderSchema } from "@loomwiki/schema";
import { ErrorCodes, LoomwikiError } from "@loomwiki/shared";
import type { Env } from "../env.js";
import {
  BYOK_DELETED_CIPHERTEXT,
  BYOK_DELETED_IV,
  decryptValue,
  encryptValue,
  isDeletedCiphertext,
} from "./crypto.js";

export type ByokProvider = "anthropic" | "openai" | "google";

const KNOWN_PROVIDERS: ReadonlySet<ByokProvider> = new Set(["anthropic", "openai", "google"]);

export function isKnownByokProvider(value: unknown): value is ByokProvider {
  return typeof value === "string" && KNOWN_PROVIDERS.has(value as ByokProvider);
}

interface ByokRow {
  workspace_id: string;
  provider: string;
  ciphertext: ArrayBuffer | Uint8Array;
  iv: ArrayBuffer | Uint8Array;
  created_at: number;
  created_by: string;
  last_used_at: number | null;
}

function toBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value);
}

function requireMasterKey(env: Env): string {
  if (!env.BYOK_ENCRYPTION_KEY || env.BYOK_ENCRYPTION_KEY.length === 0) {
    throw new LoomwikiError(
      ErrorCodes.INTERNAL_ERROR,
      "BYOK is not configured. Set BYOK_ENCRYPTION_KEY via `wrangler secret put`.",
      { status: 503 },
    );
  }
  return env.BYOK_ENCRYPTION_KEY;
}

/**
 * Look up the plaintext BYOK key for `(workspaceId, provider)`. Returns:
 *
 *   - `null` when no row exists
 *   - `null` when the row is soft-deleted (sentinel ciphertext)
 *   - the decrypted plaintext otherwise
 *
 * Throws `LoomwikiError("BYOK_DECRYPT_FAILED")` if a present row's
 * ciphertext cannot be decrypted (key rotation gone wrong, corrupted
 * row). Callers that want the resilient null-on-failure shape should
 * catch and translate.
 *
 * Updates `last_used_at` on every successful decrypt, throttled to
 * once-per-minute per row (the freshness signal is for the settings UI;
 * cost-amortizing the D1 write avoids hot-spotting under chat fan-out).
 */
export async function getBYOK(
  env: Env,
  workspaceId: string,
  provider: ByokProvider,
): Promise<string | null> {
  if (!isKnownByokProvider(provider)) return null;

  const row = await env.DB.prepare(
    `SELECT workspace_id, provider, ciphertext, iv, created_at, created_by, last_used_at
       FROM byok_keys WHERE workspace_id = ? AND provider = ?`,
  )
    .bind(workspaceId, provider)
    .first<ByokRow>();

  if (row === null) return null;

  const ciphertext = toBytes(row.ciphertext);
  if (isDeletedCiphertext(ciphertext)) return null;

  const iv = toBytes(row.iv);
  const master = requireMasterKey(env);
  const plaintext = await decryptValue(ciphertext, iv, master);

  // Throttled last_used_at update — best-effort, must not block.
  const now = Math.floor(Date.now() / 1000);
  const sixtySecondsAgo = now - 60;
  if (row.last_used_at === null || row.last_used_at < sixtySecondsAgo) {
    try {
      await env.DB.prepare(
        "UPDATE byok_keys SET last_used_at = ? WHERE workspace_id = ? AND provider = ?",
      )
        .bind(now, workspaceId, provider)
        .run();
    } catch {
      // Don't fail the LLM call because the metadata write failed.
      // Sentry will pick the error up if it's persistent.
    }
  }

  return plaintext;
}

/**
 * Set / replace the BYOK key for `(workspaceId, provider)`. Encrypts
 * with the master key and upserts. Caller is the workspace owner
 * (enforced at the route layer); `actorUserId` is recorded as
 * `created_by` and used for the audit log entry the route writes
 * AFTER this returns successfully.
 */
export async function setBYOK(
  env: Env,
  workspaceId: string,
  provider: ByokProvider,
  plaintextKey: string,
  actorUserId: string,
): Promise<BYOKKeyMetadata> {
  if (!isKnownByokProvider(provider)) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Unknown BYOK provider", {
      status: 400,
    });
  }
  validateProviderKeyShape(provider, plaintextKey);

  const master = requireMasterKey(env);
  const { ciphertext, iv } = await encryptValue(plaintextKey, master);

  const nowSec = Math.floor(Date.now() / 1000);

  // INSERT OR REPLACE: clears any prior soft-delete sentinel and the
  // old ciphertext in one statement, leaving created_at / created_by
  // refreshed to the current actor (semantics: setBYOK is "this is
  // now MY key, regardless of who set it last").
  await env.DB.prepare(
    `INSERT INTO byok_keys (workspace_id, provider, ciphertext, iv, created_at, created_by, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(workspace_id, provider) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         created_at = excluded.created_at,
         created_by = excluded.created_by,
         last_used_at = NULL`,
  )
    .bind(workspaceId, provider, ciphertext, iv, nowSec, actorUserId)
    .run();

  return parseMetadata({
    workspace_id: workspaceId,
    provider,
    has_key: true,
    created_at: nowSec,
    created_by: actorUserId,
    last_used_at: null,
  });
}

/**
 * Soft-delete the key for `(workspaceId, provider)`. The row stays in
 * D1 with a sentinel ciphertext so the audit trail is preserved.
 * Idempotent — deleting a missing or already-deleted key is not an
 * error.
 */
export async function deleteBYOK(
  env: Env,
  workspaceId: string,
  provider: ByokProvider,
): Promise<void> {
  if (!isKnownByokProvider(provider)) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Unknown BYOK provider", {
      status: 400,
    });
  }
  await env.DB.prepare(
    `UPDATE byok_keys SET ciphertext = ?, iv = ?, last_used_at = NULL
       WHERE workspace_id = ? AND provider = ?`,
  )
    .bind(BYOK_DELETED_CIPHERTEXT, BYOK_DELETED_IV, workspaceId, provider)
    .run();
}

/**
 * List metadata for all configured BYOK keys in the workspace. Filters
 * out soft-deleted rows so the UI doesn't render zombies. Plaintext
 * keys are never read or returned.
 */
export async function listBYOK(env: Env, workspaceId: string): Promise<BYOKKeyMetadata[]> {
  const rs = await env.DB.prepare(
    `SELECT workspace_id, provider, ciphertext, created_at, created_by, last_used_at
       FROM byok_keys WHERE workspace_id = ? ORDER BY provider`,
  )
    .bind(workspaceId)
    .all<ByokRow & { ciphertext: ArrayBuffer | Uint8Array }>();
  const out: BYOKKeyMetadata[] = [];
  for (const row of rs.results ?? []) {
    const ciphertext = toBytes(row.ciphertext);
    if (isDeletedCiphertext(ciphertext)) continue;
    if (!ByokProviderSchema.safeParse(row.provider).success) continue;
    out.push(
      parseMetadata({
        workspace_id: row.workspace_id,
        provider: row.provider,
        has_key: true,
        created_at: row.created_at,
        created_by: row.created_by,
        last_used_at: row.last_used_at,
      }),
    );
  }
  return out;
}

function parseMetadata(value: unknown): BYOKKeyMetadata {
  const result = BYOKKeyMetadataSchema.safeParse(value);
  if (!result.success) {
    throw new LoomwikiError("DB_PARSE_ERROR", "BYOK metadata row failed validation", {
      status: 500,
      details: result.error.issues,
    });
  }
  return result.data;
}

// ------- helper: model → provider mapping for lib/llm.ts -------

/**
 * Resolve which BYOK provider (if any) a model id should consult.
 * Returns null when the model is a Workers AI catalog id; the lib/llm
 * call site interprets null as "no BYOK lookup, use Workers AI".
 *
 * The mapping is name-based — Workers AI ids are prefixed `@cf/`; the
 * `byok:<provider>` sentinel is the workspace-default-model
 * indirection set via /settings/workspace; `claude-*` and `gpt-*` are
 * the canonical SDK shapes.
 */
export function resolveProviderForModel(model: string | undefined): ByokProvider | null {
  if (!model || model.length === 0) return null;
  if (model.startsWith("@cf/")) return null;
  if (model === "byok:anthropic") return "anthropic";
  if (model === "byok:openai") return "openai";
  if (model === "byok:google") return "google";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-")) return "openai";
  if (model.startsWith("gemini-")) return "google";
  return null;
}

// ------- key-shape validation -------

/**
 * Lightweight format check before encryption — reject empty / bad
 * shapes loud-and-early so the operator notices a paste mistake at
 * settings-save time, not at first chat. Strict regexes would be
 * brittle (Anthropic and OpenAI both rotate their public prefixes);
 * we only assert the very minimum each provider uses today.
 */
function validateProviderKeyShape(provider: ByokProvider, key: string): void {
  if (typeof key !== "string" || key.length < 8) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "BYOK key is too short", {
      status: 400,
    });
  }
  if (key.includes("\n") || key.includes("\r")) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "BYOK key cannot contain newlines", {
      status: 400,
    });
  }
  if (provider === "anthropic" && !key.startsWith("sk-ant-")) {
    throw new LoomwikiError(
      ErrorCodes.VALIDATION_FAILED,
      "Anthropic keys typically start with sk-ant-",
      { status: 400 },
    );
  }
  if (provider === "openai" && !key.startsWith("sk-")) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "OpenAI keys typically start with sk-", {
      status: 400,
    });
  }
}
