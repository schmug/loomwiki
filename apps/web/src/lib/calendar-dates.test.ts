// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { addMonths, entryDayIso, gridRangeEpochs, monthGrid, utcDateIso } from "./calendar-dates";

describe("monthGrid", () => {
  it("builds a Monday-start grid for July 2026", () => {
    const grid = monthGrid(2026, 7);
    // 2026-07-01 is a Wednesday → the grid leads with Mon Jun 29.
    expect(grid[0]?.[0]?.iso).toBe("2026-06-29");
    expect(grid[0]?.[0]?.inMonth).toBe(false);
    expect(grid[0]?.[2]?.iso).toBe("2026-07-01");
    expect(grid[0]?.[2]?.inMonth).toBe(true);
    expect(grid.length).toBe(5);
    for (const week of grid) expect(week.length).toBe(7);
    const last = grid[4]?.[6];
    expect(last?.iso).toBe("2026-08-02");
  });
});

describe("addMonths", () => {
  it("wraps across year boundaries", () => {
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });
});

describe("entryDayIso", () => {
  const due = Date.parse("2026-07-20T00:00:00Z") / 1000;
  it("buckets date-only values by UTC date", () => {
    expect(utcDateIso(due)).toBe("2026-07-20");
    expect(
      entryDayIso({
        kind: "task_due",
        id: "0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa",
        title: "t",
        status: "todo",
        room_id: null,
        assignee_id: null,
        due_at: due,
      }),
    ).toBe("2026-07-20");
    expect(
      entryDayIso({
        kind: "event",
        id: "0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa",
        title: "e",
        room_id: null,
        starts_at: due,
        ends_at: null,
        all_day: 1,
      }),
    ).toBe("2026-07-20");
  });
});

describe("gridRangeEpochs", () => {
  it("covers the grid with a one-day margin on each side", () => {
    const grid = monthGrid(2026, 7);
    const { from, to } = gridRangeEpochs(grid);
    expect(from).toBe(Date.parse("2026-06-28T00:00:00Z") / 1000);
    expect(to).toBe(Date.parse("2026-08-04T00:00:00Z") / 1000);
  });
});
