// SPDX-License-Identifier: Apache-2.0

// Migration + reset helpers for tests. Apply once per test file in beforeAll;
// reset between tests so state does not leak.

import { applyD1Migrations, env } from "cloudflare:test";

export async function applyMigrations(): Promise<void> {
  if (!env.TEST_MIGRATIONS) {
    throw new Error(
      "TEST_MIGRATIONS binding missing — vitest.config.ts must read packages/schema/d1-migrations",
    );
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

// Truncate the application tables. Order respects FK references.
const TRUNCATE_ORDER = [
  "byok_keys",
  "proposals",
  "ingest_runs",
  "messages",
  "room_members",
  "rooms",
  "workspaces",
  "users",
];

export async function resetDb(): Promise<void> {
  for (const table of TRUNCATE_ORDER) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

export async function clearJwksCache(): Promise<void> {
  // KV in miniflare-test mode persists across tests in a file unless cleared.
  // Each test that mutates JWKS state should call this in beforeEach.
  const list = await env.CACHE.list({ prefix: "access-jwks:" });
  for (const key of list.keys) {
    await env.CACHE.delete(key.name);
  }
}
