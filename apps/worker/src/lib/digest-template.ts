// SPDX-License-Identifier: Apache-2.0

// Daily digest markdown formatter. Pure function — given a date and a
// list of pending proposals, returns the full file contents (frontmatter
// + body). Deterministic ordering keeps re-renders byte-stable so the
// digest cron path is idempotent.
//
// The digest is itself a wiki page at `/wiki/_inbox/{YYYY-MM-DD}.md`,
// rendered through the same sanitizer pipeline as any other page. Content
// is plain markdown with no surprising HTML.

import type { ProposalAction } from "@loomwiki/schema";

export interface DigestProposal {
  id: string;
  page_path: string;
  action: ProposalAction;
  rationale: string;
  /** Slug of the room the source run belongs to. */
  room_slug: string;
  /** Epoch seconds — used to compute "X hours ago" in the digest. */
  created_at: number;
}

export interface DigestStats {
  /** Total runs covered in the digest period. */
  run_count: number;
  /** Runs that landed in `failed` state. */
  error_count: number;
  /**
   * p50 duration across runs in milliseconds. Null when there were no
   * successful runs to measure.
   */
  p50_duration_ms: number | null;
}

export interface DigestTemplateInput {
  /** UTC date (YYYY-MM-DD) the digest covers. */
  date: string;
  /** Pending proposals listed in the digest. */
  proposals: DigestProposal[];
  /** Run statistics for the day. */
  stats: DigestStats;
}

/**
 * Render the digest markdown. Sort: by room_slug, then by id (UUIDv7
 * sortable). Empty proposals → "no pending proposals" body. Stats are
 * always rendered so operators can spot quiet days vs. silent failures.
 */
export function renderDigestMarkdown(input: DigestTemplateInput): string {
  const sorted = [...input.proposals].sort((a, b) => {
    if (a.room_slug !== b.room_slug) return a.room_slug < b.room_slug ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const frontmatter = [
    "---",
    `title: Inbox Digest — ${input.date}`,
    "kind: open-question",
    `created: ${input.date}`,
    `last_updated: ${input.date}`,
    "status: published",
    "---",
    "",
  ].join("\n");

  const body: string[] = [`# Inbox Digest — ${input.date}`, ""];

  if (sorted.length === 0) {
    body.push("## Summary", "", "_No pending proposals for this date._", "");
  } else {
    body.push(
      "## Summary",
      "",
      `${sorted.length} pending proposal${sorted.length === 1 ? "" : "s"} across ${countRooms(
        sorted,
      )} room${countRooms(sorted) === 1 ? "" : "s"}.`,
      "",
      "## Pending Proposals",
      "",
    );

    let currentRoom = "";
    for (const p of sorted) {
      if (p.room_slug !== currentRoom) {
        currentRoom = p.room_slug;
        body.push(`### #${currentRoom}`, "");
      }
      const verb = p.action === "create" ? "Create" : "Update";
      body.push(
        `- **${verb}** \`${p.page_path}\` — ${oneLine(p.rationale)}`,
        `  → [Review](/inbox/proposals/${p.id})`,
      );
    }
    body.push("");
  }

  body.push(
    "## Stats",
    "",
    `- Runs: ${input.stats.run_count}`,
    `- Errors: ${input.stats.error_count}`,
    `- p50 duration: ${input.stats.p50_duration_ms === null ? "n/a" : `${input.stats.p50_duration_ms}ms`}`,
    "",
  );

  return `${frontmatter}${body.join("\n")}`;
}

function countRooms(proposals: DigestProposal[]): number {
  return new Set(proposals.map((p) => p.room_slug)).size;
}

/** Collapse newlines + trim. Keeps the bullet list scannable. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

const DIGEST_PATH_PREFIX = "/wiki/_inbox/";

/** Format the digest path for a UTC date string. */
export function digestPathForDate(dateUtc: string): string {
  return `${DIGEST_PATH_PREFIX}${dateUtc}.md`;
}
