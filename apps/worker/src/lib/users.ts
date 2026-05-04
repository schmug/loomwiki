// SPDX-License-Identifier: Apache-2.0

// JIT user provisioning. The first time we see a verified email claim we
// create a row in `users`; subsequent requests resolve to the same row.
//
// Idempotency under race: two simultaneous first-time requests for the same
// email must not produce two users. SQLite's `INSERT ... ON CONFLICT(email)
// DO NOTHING` followed by a `SELECT` is atomic enough — `users.email` has a
// UNIQUE constraint (see d1-migrations/0001_init.sql). We do not check-then-
// insert.

import { type User, parseUserRow } from "@loomwiki/schema/parsers";
import { ErrorCodes, LoomwikiError, id } from "@loomwiki/shared";
import type { Env } from "../env.js";

function deriveDisplayName(email: string): string {
  const local = email.split("@")[0] ?? "";
  if (local.length === 0) return "User";
  const first = local[0] ?? "";
  return first.toUpperCase() + local.slice(1);
}

export async function getOrCreateUser(
  env: Env,
  email: string,
  displayName?: string,
): Promise<User> {
  const normalized = email.trim().toLowerCase();

  // Hot path: user already exists. Skip the insert round-trip when possible.
  const existing = await env.DB.prepare("SELECT * FROM users WHERE email = ?")
    .bind(normalized)
    .first();
  if (existing) return parseUserRow(existing);

  // Cold path: race-safe upsert + re-select.
  const newId = id();
  const dn = displayName ?? deriveDisplayName(normalized);
  await env.DB.prepare(
    "INSERT INTO users (id, email, display_name) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING",
  )
    .bind(newId, normalized, dn)
    .run();

  const row = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(normalized).first();
  if (!row) {
    throw new LoomwikiError(ErrorCodes.INTERNAL_ERROR, "User upsert failed", { status: 500 });
  }
  return parseUserRow(row);
}

export async function getUserById(env: Env, userId: string): Promise<User | null> {
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  return row ? parseUserRow(row) : null;
}
