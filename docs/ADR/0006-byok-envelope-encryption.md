<!-- SPDX-License-Identifier: Apache-2.0 -->

# ADR 0006 — BYOK envelope encryption

- **Status**: Accepted
- **Date**: 2026-05-07
- **Milestone**: M8

## Context

M8 ships Bring-Your-Own-Key for the per-workspace LLM provider override.
Operators paste an Anthropic or OpenAI key into the `/settings/byok`
form; the worker uses it for that workspace's `/ask` and ingest calls.
SPEC §22 names this surface; `docs/SECURITY.md` §M22 is the threat-model
row.

The constraint that drove the design is sharp:

- The plaintext key must never appear in any API response, in any log
  line, in any error payload, or at rest in any column we can read
  back.
- The key is needed in cleartext at exactly one site
  (`apps/worker/src/lib/llm.ts`) for the duration of one HTTP request to
  the upstream provider.
- A compromised D1 export must not yield plaintext keys without also
  yielding `BYOK_ENCRYPTION_KEY`, which lives in Worker Secrets — a
  separate trust boundary.

D1 has no native column-level encryption, and Workers Secrets isn't a
KV — we can't write per-key secrets there at runtime. The pattern that
fits is **envelope encryption**: a single long-lived master key
(secret) wraps many short-lived data keys (the BYOK plaintext bytes),
with the data keys living next to the data they decrypt.

## Decision

### a. AES-GCM-256 with a Worker-secret master key

`BYOK_ENCRYPTION_KEY` is a 32-byte key, base64-encoded, set via
`wrangler secret put`. Operators generate it with
`openssl rand -base64 32`. The worker imports it as an AES-GCM
`CryptoKey` once per isolate (cached in `lib/crypto.ts`), and uses it
to encrypt/decrypt every BYOK row.

AES-GCM-256 was chosen over AES-CBC + HMAC because:

- The Workers runtime exposes it natively via `crypto.subtle`. No
  bundled crypto dependency.
- GCM authenticates — a tampered ciphertext, wrong IV, or wrong key
  all manifest as a single decrypt failure (`OperationError`), which
  we map to `LoomwikiError("BYOK_DECRYPT_FAILED")`. Callers don't need
  to layer their own MAC.
- It's the same primitive Cloudflare's own platform docs use for
  workers-secret encryption-at-rest, so we don't fight the platform's
  threat model.

### b. Per-record fresh 12-byte IV

Each `setBYOK` call generates a fresh 12-byte IV via
`crypto.getRandomValues`. The IV is stored alongside the ciphertext in
the `byok_keys` row (`ciphertext`, `iv` columns; both `BLOB`). GCM IV
reuse with the same key destroys confidentiality, so the design point
is: never reuse, and never rely on a counter. A fresh 96-bit random IV
collides at `2^48` writes — comfortably out of reach for a single
workspace's key-rotation cadence.

### c. Plaintext is in-memory, request-scoped, never returned

The plaintext-handling contract is enforced by a small, frozen surface
in `apps/worker/src/lib/byok.ts`:

| Function | Returns |
|---|---|
| `getBYOK(env, ws, provider)` | the plaintext key, or `null` |
| `setBYOK(env, ws, provider, plaintext, actor)` | metadata only |
| `deleteBYOK(env, ws, provider)` | void |
| `listBYOK(env, ws)` | metadata array |

`getBYOK` is the **only** function in the whole worker that returns
plaintext. It's called from exactly one place
(`apps/worker/src/lib/llm.ts`'s upstream-call path), the value is held
in a local variable for the duration of the upstream `fetch`, and goes
out of scope at request end. No other code path can read the key:
`listBYOK` returns `BYOKKeyMetadata` (no `key` field exists in the
schema), and the settings UI's GET surface uses `listBYOK` exclusively.

The settings React component (`/settings/byok`) clears the input
textarea on save and never re-renders the typed value — see
`apps/web/README.md` "Settings (M8)" for the convention.

### d. Soft-delete via sentinel ciphertext

`deleteBYOK` overwrites the row's `ciphertext` column with a single
`0x00` byte (`BYOK_DELETED_CIPHERTEXT` in `lib/crypto.ts`) and clears
the IV. The row stays in D1 — `created_at` and `created_by` remain
queryable for audit. `getBYOK` checks for the sentinel via
`isDeletedCiphertext()` and returns `null` without attempting decrypt.

A real AES-GCM ciphertext is never a single 0x00 byte (the GCM auth
tag alone is 16 bytes), so the sentinel is unambiguous. A subsequent
`setBYOK` overwrites the sentinel cleanly via `INSERT OR REPLACE`.

The audit-trail integrity is the load-bearing reason. Hard-deleting
the row would mean a key-rotation gone wrong (or a subpoena response,
or a forensic question about who set what when) loses information we
already legitimately had.

### e. Master-key rotation is a runbook, not automated

`BYOK_ENCRYPTION_KEY` rotation is rare and requires re-encrypting
every existing `byok_keys` row under the new master key. v0.0.1 ships
this as a documented manual procedure in `DEPLOY.md`
("BYOK_ENCRYPTION_KEY rotation runbook"):

1. Generate new key — `openssl rand -base64 32`.
2. Read every row from `byok_keys` (operator script via
   `wrangler d1 execute`).
3. For each non-deleted row: decrypt with the old master, re-encrypt
   with the new master, `UPDATE` the ciphertext + IV.
4. `wrangler secret put BYOK_ENCRYPTION_KEY` with the new value.

Automation (a `/settings/rotate-master-key` admin route) is deferred
to v0.1. The v0.0.1 dogfood team rotates ad-hoc on key compromise; a
self-hoster rotates "annually or on incident." The runbook is short
enough to follow without panic.

### f. Provider list: Anthropic + OpenAI in the UI; Google reserved in schema

`packages/schema`'s `ByokProviderSchema` enum is
`["anthropic", "openai", "google"]`. The settings UI exposes only
**Anthropic** and **OpenAI** in v0.0.1; Google is reserved in the
schema so a v0.1 enable-flag flip doesn't require a schema migration.
The `validateProviderKeyShape` helper in `lib/byok.ts` knows the
v0.0.1 shape constraints (`sk-ant-` for Anthropic, `sk-` for OpenAI)
and lets Google through with the generic length/newline checks until
a real key shape is observed.

## Consequences

### Positive

- Plaintext keys exist only inside `lib/llm.ts`'s call frame. Every
  other surface — list endpoints, audit log entries, error payloads,
  Sentry events — sees metadata only. The PII scrubber in
  `lib/sentry.ts` adds a defense-in-depth filter for `api_key` /
  `token` / `authorization` field names; the primary defense is that
  those values never reach the logger in the first place.
- A D1 dump (legitimate or otherwise) yields ciphertext + per-row IVs,
  not plaintext. Without `BYOK_ENCRYPTION_KEY` from the Worker secret
  store, the dump is useless.
- Soft-delete preserves the audit trail. A future "who set what when"
  question survives even after the operator clears the key.
- Rotation has a documented procedure. Operators can act when needed.

### Negative / accepted trade-offs

- **Master-key rotation is manual.** A self-hoster who never rotates
  carries unbounded compromise blast radius. Mitigations: the
  `BYOK_ENCRYPTION_KEY` only ever decrypts data that already lived in
  the operator's D1, and `getBYOK` failures map to `BYOK_DECRYPT_FAILED`
  loudly, so a half-rotated state is debuggable.
- **The cache in `importMasterKey` keys on the base64 string.** If
  `BYOK_ENCRYPTION_KEY` changes mid-isolate (e.g., a new deploy
  rolls), the previous import stays cached for that isolate's
  remaining lifetime. Acceptable: isolates are short-lived (minutes,
  not hours), and the new isolate after deploy picks up the new
  secret cleanly.
- **No per-row salt or AAD.** AAD (additional authenticated data,
  e.g., binding the ciphertext to `workspace_id || provider`) would
  prevent a hypothetical "swap one workspace's ciphertext into
  another workspace's row" attack against an operator with D1 write
  access. We don't ship AAD in v0.0.1; the threat requires write
  access to D1, which means the operator is already compromised
  beyond what AAD recovers.
- **`isKnownByokProvider` returning `false` for an unknown provider
  causes `getBYOK` to return `null` silently.** A schema drift between
  `packages/schema` and `lib/byok.ts` would manifest as "BYOK never
  works for the new provider." The integration test
  (`apps/worker/src/__tests__/byok.test.ts`) asserts the enum agrees.

## Revisit when

- Workers Secrets Store ships with per-key (rather than per-Worker)
  secrets. The envelope pattern collapses to "look up the key in
  Secrets Store" and the master key + ciphertext columns disappear.
- A self-hoster reports that manual master-key rotation is too painful
  in production. v0.1 adds the `/settings/rotate-master-key` admin
  flow.
- We add a third or fourth provider whose key shape doesn't fit the
  current `validateProviderKeyShape` rules. The validation is
  intentionally loose; tightening per-provider lives there.

## Alternatives considered

- **Plaintext keys in D1 with a `WIKI_KV` indirection.** Rejected on
  the threat model — D1 dump = plaintext key compromise.
- **Per-key secret in Workers Secrets Store.** Rejected for v0.0.1
  because Secrets Store doesn't expose a runtime "set a new secret"
  API to a Worker. Operator-typed BYOK keys can't reach there without
  the operator running `wrangler secret put` per key.
- **AES-CBC + HMAC.** Rejected — extra moving parts, no platform-
  native primitive, no advantage over GCM at our threat level.
- **Hard delete on `deleteBYOK`.** Rejected — loses audit trail. The
  sentinel costs one byte per deleted row and gains "who set this and
  when did they delete it" forever.

## References

- `apps/worker/src/lib/crypto.ts` — `encryptValue` / `decryptValue` /
  master-key import.
- `apps/worker/src/lib/byok.ts` — `getBYOK` / `setBYOK` / `deleteBYOK`
  / `listBYOK` / `resolveProviderForModel`.
- `apps/worker/src/__tests__/byok.test.ts` — round-trip + soft-delete
  + provider-key-shape tests.
- `docs/SECURITY.md` §M22 — threat-model row.
- `DEPLOY.md` — `BYOK_ENCRYPTION_KEY` rotation runbook.
