// SPDX-License-Identifier: Apache-2.0

// Smoke tests for the dual-format time helpers (M1 ISO + M2 epoch).
// Avoids asserting on locale-dependent strings except where the helper
// returns a fixed value ("Today" / "Yesterday").

import { describe, expect, it } from "vitest";
import { formatDayHeading, formatEpochSeconds, formatIsoString, formatTimeOnly } from "./time";

const NOW = 1_700_000_000; // arbitrary epoch s
const DAY = 24 * 60 * 60;

describe("formatEpochSeconds", () => {
  it("returns the empty string for invalid input", () => {
    expect(formatEpochSeconds(Number.NaN)).toBe("");
    expect(formatEpochSeconds(-1)).toBe("");
  });

  it("renders relative for ≤24h ago", () => {
    expect(formatEpochSeconds(NOW - 5 * 60, NOW)).toMatch(/min/i);
    expect(formatEpochSeconds(NOW - 3 * 60 * 60, NOW)).toMatch(/hour/i);
  });

  it("renders absolute date+time for >24h ago", () => {
    const out = formatEpochSeconds(NOW - 2 * DAY, NOW);
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/ago/i);
  });
});

describe("formatIsoString", () => {
  it("works on a valid ISO-8601 string", () => {
    const iso = new Date((NOW - 2 * 60) * 1000).toISOString();
    expect(formatIsoString(iso, NOW)).toMatch(/min|second/i);
  });

  it("returns empty for an invalid string", () => {
    expect(formatIsoString("nonsense")).toBe("");
  });
});

describe("formatTimeOnly", () => {
  it("returns a HH:MM-ish string", () => {
    const out = formatTimeOnly(NOW);
    expect(out).toMatch(/\d/);
  });
});

describe("formatDayHeading", () => {
  it("returns 'Today' for the same calendar day", () => {
    expect(formatDayHeading(NOW, NOW)).toBe("Today");
  });

  it("returns 'Yesterday' for the previous calendar day", () => {
    // Pick a "now" at midday so subtracting 24h lands clearly in the
    // previous local day regardless of the runner's TZ.
    const now = new Date(2026, 4, 4, 12, 0).getTime() / 1000;
    const yesterday = now - DAY;
    expect(formatDayHeading(yesterday, now)).toBe("Yesterday");
  });

  it("returns a long-form weekday for older days", () => {
    const now = new Date(2026, 4, 4, 12, 0).getTime() / 1000;
    const lastWeek = now - 7 * DAY;
    expect(formatDayHeading(lastWeek, now)).toMatch(
      /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/,
    );
  });
});
