// SPDX-License-Identifier: Apache-2.0

// Pure-function tests for the digest markdown formatter. The
// idempotency assertion is the most important — re-rendering with the
// same input must produce byte-identical output so the cron path can
// safely overwrite each day.

import { describe, expect, it } from "vitest";
import {
  type DigestProposal,
  digestPathForDate,
  renderDigestMarkdown,
} from "../lib/digest-template.js";

const STATS = { run_count: 3, error_count: 0, p50_duration_ms: 1234 };

const SAMPLE_PROPOSAL: DigestProposal = {
  id: "01970000-0000-7000-8000-000000000001",
  page_path: "/wiki/decisions/2026-05-dmarc.md",
  action: "create",
  rationale: "DMARC quarantine policy approved across two messages.",
  room_slug: "ops-cyber",
  created_at: Date.parse("2026-05-04T03:30:00Z") / 1000,
};

describe("renderDigestMarkdown", () => {
  it("emits a minimal page when there are no pending proposals", () => {
    const out = renderDigestMarkdown({
      date: "2026-05-04",
      proposals: [],
      stats: STATS,
    });
    expect(out).toContain("title: Inbox Digest — 2026-05-04");
    expect(out).toContain("No pending proposals");
    expect(out).toContain("Runs: 3");
  });

  it("groups proposals by room slug, sorted alphabetically", () => {
    const a: DigestProposal = {
      ...SAMPLE_PROPOSAL,
      id: "01970000-0000-7000-8000-000000000002",
      room_slug: "alpha",
    };
    const b: DigestProposal = {
      ...SAMPLE_PROPOSAL,
      id: "01970000-0000-7000-8000-000000000003",
      room_slug: "beta",
    };
    const c: DigestProposal = {
      ...SAMPLE_PROPOSAL,
      id: "01970000-0000-7000-8000-000000000004",
      room_slug: "alpha",
    };

    const out = renderDigestMarkdown({
      date: "2026-05-04",
      proposals: [b, a, c],
      stats: STATS,
    });

    const alphaIdx = out.indexOf("### #alpha");
    const betaIdx = out.indexOf("### #beta");
    expect(alphaIdx).toBeGreaterThan(0);
    expect(betaIdx).toBeGreaterThan(alphaIdx);
  });

  it("is idempotent for the same input (byte-identical output)", () => {
    const a = renderDigestMarkdown({
      date: "2026-05-04",
      proposals: [
        { ...SAMPLE_PROPOSAL, id: "01970000-0000-7000-8000-000000000005" },
        { ...SAMPLE_PROPOSAL, id: "01970000-0000-7000-8000-000000000006" },
      ],
      stats: STATS,
    });
    const b = renderDigestMarkdown({
      date: "2026-05-04",
      proposals: [
        { ...SAMPLE_PROPOSAL, id: "01970000-0000-7000-8000-000000000006" },
        { ...SAMPLE_PROPOSAL, id: "01970000-0000-7000-8000-000000000005" },
      ],
      stats: STATS,
    });
    expect(a).toBe(b);
  });

  it("renders n/a when there are no successful runs to measure p50", () => {
    const out = renderDigestMarkdown({
      date: "2026-05-04",
      proposals: [],
      stats: { run_count: 0, error_count: 0, p50_duration_ms: null },
    });
    expect(out).toContain("p50 duration: n/a");
  });

  it("includes a link to /inbox/proposals/<id> for each proposal", () => {
    const out = renderDigestMarkdown({
      date: "2026-05-04",
      proposals: [SAMPLE_PROPOSAL],
      stats: STATS,
    });
    expect(out).toContain("/inbox/proposals/01970000-0000-7000-8000-000000000001");
  });
});

describe("digestPathForDate", () => {
  it("formats under /wiki/_inbox/", () => {
    expect(digestPathForDate("2026-05-04")).toBe("/wiki/_inbox/2026-05-04.md");
  });
});
