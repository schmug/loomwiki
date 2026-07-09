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

// Truncate the application tables. Order respects FK references —
// children before parents so DELETE never trips a foreign-key constraint.
const TRUNCATE_ORDER = [
  "audit_log",
  "workspace_settings",
  "llm_usage_daily",
  "byok_keys",
  "proposals",
  "ingest_runs",
  // M9: task_tags before tasks (FK on task_id); both before messages/rooms/
  // workspaces/users since tasks references all of those.
  "task_tags",
  "tasks",
  // M9: event_attendees before events (FK on event_id); both before
  // messages/rooms/workspaces/users since events references all of those.
  "event_attendees",
  "events",
  "messages",
  "room_members",
  "scheduled_actions",
  "rooms",
  "workspaces",
  "users",
];

// FTS5 virtual tables are independent of FK ordering — flush them
// alongside the regular tables so search-index state doesn't bleed
// between tests in the same file.
const FTS5_TABLES = ["wiki_pages_fts"];

export async function resetDb(): Promise<void> {
  for (const table of TRUNCATE_ORDER) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const table of FTS5_TABLES) {
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
