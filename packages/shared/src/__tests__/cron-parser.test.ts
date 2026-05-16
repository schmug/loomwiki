// SPDX-License-Identifier: Apache-2.0

// Tests for the pure-TS cron parser in packages/shared/src/cron.ts.

import { describe, expect, it } from "vitest";
import { nextFireAt, parseCronExpr } from "../cron.js";

// Epoch seconds for a known UTC time: 2024-01-01T00:00:00Z
const JAN_1_2024 = Math.floor(Date.parse("2024-01-01T00:00:00Z") / 1000);
// 2024-02-28T23:59:00Z — just before Feb 29 in a leap year
const FEB_28_2024_NIGHT = Math.floor(Date.parse("2024-02-28T23:59:00Z") / 1000);
// Monday 2026-01-05T08:00:00Z
const MON_JAN_5_2026 = Math.floor(Date.parse("2026-01-05T08:00:00Z") / 1000);

describe("parseCronExpr", () => {
  it("parses a minimal valid expression (every minute)", () => {
    const parsed = parseCronExpr("* * * * *");
    expect(parsed).not.toBeNull();
    expect(parsed?.minutes).toHaveLength(60);
    expect(parsed?.hours).toHaveLength(24);
    expect(parsed?.doms).toHaveLength(31);
    expect(parsed?.months).toHaveLength(12);
    expect(parsed?.dows).toHaveLength(7);
  });

  it("returns null for wrong field count", () => {
    expect(parseCronExpr("* * * *")).toBeNull();
    expect(parseCronExpr("* * * * * *")).toBeNull();
    expect(parseCronExpr("")).toBeNull();
  });

  it("returns null for out-of-range values", () => {
    expect(parseCronExpr("60 * * * *")).toBeNull(); // minute > 59
    expect(parseCronExpr("* 24 * * *")).toBeNull(); // hour > 23
    expect(parseCronExpr("* * 0 * *")).toBeNull(); // dom < 1
    expect(parseCronExpr("* * * 0 *")).toBeNull(); // month < 1
    expect(parseCronExpr("* * * * 7")).toBeNull(); // dow > 6
  });

  it("parses exact single values", () => {
    const parsed = parseCronExpr("5 3 15 6 2");
    expect(parsed).not.toBeNull();
    expect(parsed?.minutes).toEqual([5]);
    expect(parsed?.hours).toEqual([3]);
    expect(parsed?.doms).toEqual([15]);
    expect(parsed?.months).toEqual([6]);
    expect(parsed?.dows).toEqual([2]);
  });

  it("parses step expressions (*/N)", () => {
    const parsed = parseCronExpr("*/15 */6 * * *");
    expect(parsed?.minutes).toEqual([0, 15, 30, 45]);
    expect(parsed?.hours).toEqual([0, 6, 12, 18]);
  });

  it("parses comma lists", () => {
    const parsed = parseCronExpr("1,3,5 * * * *");
    expect(parsed?.minutes).toEqual([1, 3, 5]);
  });

  it("parses ranges", () => {
    const parsed = parseCronExpr("0-5 * * * *");
    expect(parsed?.minutes).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("parses combined range-and-list", () => {
    const parsed = parseCronExpr("1-3,7 * * * *");
    expect(parsed?.minutes).toEqual([1, 2, 3, 7]);
  });

  it("parses range-with-step", () => {
    const parsed = parseCronExpr("0-30/10 * * * *");
    expect(parsed?.minutes).toEqual([0, 10, 20, 30]);
  });

  it("returns null for an invalid step value of 0", () => {
    expect(parseCronExpr("*/0 * * * *")).toBeNull();
  });
});

describe("nextFireAt", () => {
  it("returns the next whole minute for '* * * * *'", () => {
    // fromEpochS = 00:00:30 on Jan 1; next minute is 00:01:00
    const from = JAN_1_2024 + 30; // 30 seconds into the first minute
    const next = nextFireAt("* * * * *", from);
    // Should be the next whole minute
    expect(next % 60).toBe(0);
    expect(next).toBeGreaterThan(from);
  });

  it("fires on a specific minute/hour", () => {
    // "0 9 * * *" — every day at 09:00 UTC
    const from = JAN_1_2024; // 2024-01-01T00:00:00Z
    const next = nextFireAt("0 9 * * *", from);
    const d = new Date(next * 1000);
    expect(d.getUTCHours()).toBe(9);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCFullYear()).toBe(2024);
    expect(d.getUTCMonth()).toBe(0); // January
    expect(d.getUTCDate()).toBe(1);
  });

  it("skips past midnight when no matching minute in current hour", () => {
    // "0 0 * * *" — midnight; from = Jan 1 00:01:00
    const from = JAN_1_2024 + 60; // 00:01:00
    const next = nextFireAt("0 0 * * *", from);
    const d = new Date(next * 1000);
    // Should fire on Jan 2 at 00:00
    expect(d.getUTCDate()).toBe(2);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it("handles leap day: fires on 2024-02-29", () => {
    // "0 0 29 2 *" — midnight Feb 29
    const next = nextFireAt("0 0 29 2 *", FEB_28_2024_NIGHT);
    const d = new Date(next * 1000);
    expect(d.getUTCFullYear()).toBe(2024);
    expect(d.getUTCMonth()).toBe(1); // February (0-indexed)
    expect(d.getUTCDate()).toBe(29);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it("fires on matching day-of-week", () => {
    // "0 9 * * 1" — Mondays at 09:00; from = Mon Jan 5 2026 08:00
    const next = nextFireAt("0 9 * * 1", MON_JAN_5_2026);
    const d = new Date(next * 1000);
    expect(d.getUTCDay()).toBe(1); // Monday
    expect(d.getUTCHours()).toBe(9);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it("skips to next matching month", () => {
    // "0 0 1 6 *" — June 1 at midnight
    const from = JAN_1_2024;
    const next = nextFireAt("0 0 1 6 *", from);
    const d = new Date(next * 1000);
    expect(d.getUTCMonth()).toBe(5); // June
    expect(d.getUTCDate()).toBe(1);
    expect(d.getUTCHours()).toBe(0);
  });

  it("throws for an invalid expression", () => {
    expect(() => nextFireAt("not valid", JAN_1_2024)).toThrow();
  });

  it("throws if no match within 4 years (impossible schedule)", () => {
    // "0 0 31 2 *" — Feb 31 never exists
    expect(() => nextFireAt("0 0 31 2 *", JAN_1_2024)).toThrow(/4 years/);
  });

  it("handles step expressions correctly across hours", () => {
    // "*/30 * * * *" — every 30 minutes
    const from = JAN_1_2024 + 15 * 60; // 00:15:00
    const next = nextFireAt("*/30 * * * *", from);
    const d = new Date(next * 1000);
    expect(d.getUTCMinutes()).toBe(30);
    expect(d.getUTCHours()).toBe(0);
  });

  it("each call to nextFireAt returns a time strictly after fromEpochS", () => {
    const from = JAN_1_2024;
    const next = nextFireAt("* * * * *", from);
    expect(next).toBeGreaterThan(from);
  });

  it("handles comma-list minutes", () => {
    // "15,45 * * * *"
    const from = JAN_1_2024 + 10 * 60; // 00:10:00
    const next = nextFireAt("15,45 * * * *", from);
    const d = new Date(next * 1000);
    expect(d.getUTCMinutes()).toBe(15);
  });

  it("UTC only — no DST shift", () => {
    // "0 2 * * *" — 02:00 UTC daily; DST-affected timezones shift their
    // clocks but UTC does not. The result must always be 02:00 UTC.
    const from = JAN_1_2024;
    for (let i = 0; i < 7; i++) {
      const advancedFrom = from + i * 86400;
      const next = nextFireAt("0 2 * * *", advancedFrom);
      const d = new Date(next * 1000);
      expect(d.getUTCHours()).toBe(2);
      expect(d.getUTCMinutes()).toBe(0);
    }
  });
});
