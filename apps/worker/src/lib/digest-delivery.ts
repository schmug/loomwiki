// SPDX-License-Identifier: Apache-2.0

// Daily digest delivery. The interface is the M8 plug-in point: today
// only the `WikiPageDigestDelivery` ships, but adding email (M8) is a
// new implementation behind the same contract — no schema migration,
// no caller change.
//
// The wiki-page implementation writes `/wiki/_inbox/{YYYY-MM-DD}.md`
// via the standard wiki backend, so the digest renders through the
// existing M4 viewer + sanitizer stack. Re-rendering for the same date
// overwrites cleanly thanks to deterministic content ordering in
// renderDigestMarkdown().

import type { Env } from "../env.js";
import {
  type DigestProposal,
  type DigestStats,
  digestPathForDate,
  renderDigestMarkdown,
} from "./digest-template.js";
import { upsertPageFts5 } from "./fts5.js";
import { defaultWikiBackend } from "./vault-bootstrap.js";
import type { WikiBackend } from "./wiki-backend.js";

export interface DigestRenderArgs {
  env: Env;
  /** YYYY-MM-DD (UTC). */
  date: string;
  /** Workspace the digest covers. v0.0.1 is single-tenant. */
  workspaceId: string;
  proposals: DigestProposal[];
  stats: DigestStats;
}

export interface DigestRenderResult {
  /** True if a file was actually written (always true for v0.0.1). */
  delivered: boolean;
  /** The vault path that was written. */
  path: string;
}

export interface DigestDelivery {
  render(args: DigestRenderArgs): Promise<DigestRenderResult>;
}

// --------------------------------------------------------------------
// Wiki-page implementation (M7 default)
// --------------------------------------------------------------------

export class WikiPageDigestDelivery implements DigestDelivery {
  constructor(private readonly backend: WikiBackend) {}

  async render(args: DigestRenderArgs): Promise<DigestRenderResult> {
    const path = digestPathForDate(args.date);
    const content = renderDigestMarkdown({
      date: args.date,
      proposals: args.proposals,
      stats: args.stats,
    });
    await this.backend.writeFile(path, content);

    // Sync the FTS5 index so the digest is searchable. AI Search syncs
    // independently when the binding is configured; FTS5 is the
    // local-dev / fallback path.
    try {
      await upsertPageFts5(args.env, {
        path,
        title: `Inbox Digest — ${args.date}`,
        body: content,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[digest] FTS5 upsert failed for ${path}: ${msg}`);
    }

    return { delivered: true, path };
  }
}

/** Convenience: build the default delivery for prod cron + manual route. */
export function defaultDigestDelivery(env: Env): DigestDelivery {
  return new WikiPageDigestDelivery(defaultWikiBackend(env));
}

// --------------------------------------------------------------------
// Data assembly — query D1 for the inputs renderDigestMarkdown wants
// --------------------------------------------------------------------

/**
 * Load the digest inputs for a date. Pulls all `pending` proposals
 * created on or before the date, joined with the room_slug + run
 * timing stats. Stats cover runs that started on the date.
 */
export async function loadDigestInputs(
  env: Env,
  args: { date: string },
): Promise<{ proposals: DigestProposal[]; stats: DigestStats }> {
  const startSec = dayStartSec(args.date);
  const endSec = startSec + 86_400;

  const proposalsRs = await env.DB.prepare(
    `SELECT p.id            AS id,
            p.page_path     AS page_path,
            p.action        AS action,
            p.rationale     AS rationale,
            p.created_at    AS created_at,
            r.slug          AS room_slug
       FROM proposals p
       JOIN ingest_runs ir ON ir.id = p.run_id
       JOIN rooms r        ON r.id  = ir.room_id
      WHERE p.status = 'pending'
        AND p.created_at < ?
      ORDER BY r.slug ASC, p.id ASC`,
  )
    .bind(endSec)
    .all<DigestProposal>();

  const proposals = (proposalsRs.results ?? []) as DigestProposal[];

  const runsRs = await env.DB.prepare(
    `SELECT status, started_at, finished_at FROM ingest_runs
       WHERE started_at >= ? AND started_at < ?`,
  )
    .bind(startSec, endSec)
    .all<{ status: string; started_at: number; finished_at: number | null }>();

  const runs = runsRs.results ?? [];
  const errorCount = runs.filter((r) => r.status === "failed").length;
  const succeededDurations = runs
    .filter((r) => r.status === "succeeded" && r.finished_at !== null)
    .map((r) => ((r.finished_at as number) - r.started_at) * 1000)
    .sort((a, b) => a - b);
  const p50 =
    succeededDurations.length === 0
      ? null
      : (succeededDurations[Math.floor(succeededDurations.length / 2)] ?? null);

  return {
    proposals,
    stats: {
      run_count: runs.length,
      error_count: errorCount,
      p50_duration_ms: p50,
    },
  };
}

function dayStartSec(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

/**
 * Top-level entry point. Loads inputs, calls `delivery.render`, and
 * logs structured success/failure. Exposed so both the cron path
 * (scheduled.ts) and the admin route (`POST /api/_admin/digest/render`)
 * can converge here.
 */
export async function renderDailyDigest(args: {
  env: Env;
  date: string;
  workspaceId: string;
  delivery?: DigestDelivery;
}): Promise<DigestRenderResult> {
  const delivery = args.delivery ?? defaultDigestDelivery(args.env);
  const inputs = await loadDigestInputs(args.env, { date: args.date });
  return delivery.render({
    env: args.env,
    date: args.date,
    workspaceId: args.workspaceId,
    proposals: inputs.proposals,
    stats: inputs.stats,
  });
}
