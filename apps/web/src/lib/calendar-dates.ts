// SPDX-License-Identifier: Apache-2.0

// Date helpers for the tasks/calendar UI (v0.1 M9). Rendering convention
// (design doc §2): date-only values (task due_at, all-day events) are epoch
// at 00:00:00 UTC and bucket by UTC date; timed events are instants and
// bucket by browser-local date.

import type { CalendarEntry } from "@loomwiki/schema";

export interface CalDay {
  iso: string; // YYYY-MM-DD (UTC)
  dayOfMonth: number;
  inMonth: boolean;
}

export function utcDateIso(epochS: number): string {
  return new Date(epochS * 1000).toISOString().slice(0, 10);
}

export function localDateIso(epochS: number): string {
  const d = new Date(epochS * 1000);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function entryDayIso(e: CalendarEntry): string {
  if (e.kind === "task_due") return utcDateIso(e.due_at);
  return e.all_day === 1 ? utcDateIso(e.starts_at) : localDateIso(e.starts_at);
}

export function localTimeLabel(epochS: number): string {
  return new Date(epochS * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Monday-start grid of full weeks covering `year`-`month` (month is 1–12). */
export function monthGrid(year: number, month: number): CalDay[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // 0=Mon … 6=Sun
  const start = Date.UTC(year, month - 1, 1 - lead);
  const total = Math.ceil((lead + daysInMonth) / 7) * 7;
  const cells: CalDay[] = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(start + i * 86_400_000);
    cells.push({
      iso: d.toISOString().slice(0, 10),
      dayOfMonth: d.getUTCDate(),
      inMonth: d.getUTCMonth() === month - 1,
    });
  }
  const weeks: CalDay[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function addMonths(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (((idx % 12) + 12) % 12) + 1 };
}

/** Fetch window for a grid: one day of slop each side for local-tz bucketing. */
export function gridRangeEpochs(grid: CalDay[][]): { from: number; to: number } {
  const firstDay = grid[0]?.[0];
  const lastWeek = grid[grid.length - 1];
  const lastDay = lastWeek?.[lastWeek.length - 1];
  if (!firstDay || !lastDay) throw new Error("empty calendar grid");
  return {
    from: Date.parse(`${firstDay.iso}T00:00:00Z`) / 1000 - 86_400,
    to: Date.parse(`${lastDay.iso}T00:00:00Z`) / 1000 + 2 * 86_400,
  };
}

export function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Event-creation form → starts_at. A time means a browser-local instant;
 * no time means an all-day UTC calendar date. (Chat's /event uses UTC for
 * times instead — documented in its confirmation text.)
 */
export function formStartsAt(
  date: string,
  time: string | null,
): { startsAt: number; allDay: boolean } {
  if (time === null || time === "") {
    return { startsAt: Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000), allDay: true };
  }
  return { startsAt: Math.floor(new Date(`${date}T${time}:00`).getTime() / 1000), allDay: false };
}
