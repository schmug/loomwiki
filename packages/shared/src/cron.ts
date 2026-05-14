// SPDX-License-Identifier: Apache-2.0

// Pure-TS five-field POSIX cron parser (no deps, no Node APIs).
//
// Fields: minute hour dom month dow
//   minute : 0-59
//   hour   : 0-23
//   dom    : 1-31
//   month  : 1-12
//   dow    : 0-6  (Sunday=0)
//
// Supported syntax per field:
//   *        any value
//   */N      every N (step)
//   5        exact value
//   1,3,5    comma list
//   1-5      range (inclusive)
//   1-5,7    combination
//
// All computations are in UTC (no DST). Cap: 4 years (~2,102,400 minutes).

export interface ParsedCron {
  minutes: number[]; // sorted
  hours: number[];
  doms: number[];
  months: number[];
  dows: number[];
}

// ---------------------------------------------------------------------------
// Field parsing helpers
// ---------------------------------------------------------------------------

function parseRange(s: string, min: number, max: number): number[] | null {
  // Single value
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n < min || n > max) return null;
    return [n];
  }
  // Range: a-b
  const rangeMatch = /^(\d+)-(\d+)$/.exec(s);
  if (rangeMatch) {
    const a = Number(rangeMatch[1]);
    const b = Number(rangeMatch[2]);
    if (a < min || b > max || a > b) return null;
    const result: number[] = [];
    for (let i = a; i <= b; i++) result.push(i);
    return result;
  }
  return null;
}

function parseField(field: string, min: number, max: number): number[] | null {
  // "*" — every value
  if (field === "*") {
    const all: number[] = [];
    for (let i = min; i <= max; i++) all.push(i);
    return all;
  }

  // "*/N" — every-N step
  const stepStarMatch = /^\*\/(\d+)$/.exec(field);
  if (stepStarMatch) {
    const step = Number(stepStarMatch[1]);
    if (step <= 0) return null;
    const result: number[] = [];
    for (let i = min; i <= max; i += step) result.push(i);
    return result;
  }

  // "a-b/N" — range with step
  const stepRangeMatch = /^(\d+)-(\d+)\/(\d+)$/.exec(field);
  if (stepRangeMatch) {
    const a = Number(stepRangeMatch[1]);
    const b = Number(stepRangeMatch[2]);
    const step = Number(stepRangeMatch[3]);
    if (a < min || b > max || a > b || step <= 0) return null;
    const result: number[] = [];
    for (let i = a; i <= b; i += step) result.push(i);
    return result;
  }

  // Comma-separated list (each part may be a range or a single value)
  const parts = field.split(",");
  if (parts.length > 1 || (parts.length === 1 && !field.includes("-") && /^\d+$/.test(field))) {
    const result: number[] = [];
    for (const part of parts) {
      const parsed = parseRange(part.trim(), min, max);
      if (!parsed) return null;
      for (const v of parsed) {
        if (!result.includes(v)) result.push(v);
      }
    }
    result.sort((a, b) => a - b);
    return result;
  }

  // Single range a-b (already handled above in parseRange but let's route through)
  return parseRange(field, min, max);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a five-field cron expression.
 * Returns `null` if the expression is syntactically invalid.
 */
export function parseCronExpr(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minuteF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string];

  const minutes = parseField(minuteF, 0, 59);
  if (!minutes || minutes.length === 0) return null;

  const hours = parseField(hourF, 0, 23);
  if (!hours || hours.length === 0) return null;

  const doms = parseField(domF, 1, 31);
  if (!doms || doms.length === 0) return null;

  const months = parseField(monthF, 1, 12);
  if (!months || months.length === 0) return null;

  const dows = parseField(dowF, 0, 6);
  if (!dows || dows.length === 0) return null;

  return { minutes, hours, doms, months, dows };
}

// ---------------------------------------------------------------------------
// Next-fire computation
// ---------------------------------------------------------------------------

// Maximum search window: 4 years in seconds (leap-day safe).
const MAX_SEARCH_S = 4 * 366 * 24 * 60 * 60;

/**
 * Return the next epoch second (> `fromEpochS`) when `expr` fires.
 * All computation is UTC. Throws on invalid expr or if no match is found
 * within 4 years.
 */
export function nextFireAt(expr: string, fromEpochS: number): number {
  const parsed = parseCronExpr(expr);
  if (!parsed) throw new Error(`Invalid cron expression: ${expr}`);

  const { minutes, hours, doms, months, dows } = parsed;

  // Start from the next whole minute (fromEpochS is exclusive).
  const startMs = (Math.floor(fromEpochS) + 60) * 1000;
  const limitMs = (fromEpochS + MAX_SEARCH_S) * 1000;

  // Align to the start of the minute
  let tMs = Math.floor(startMs / 60_000) * 60_000;

  while (tMs <= limitMs) {
    const d = new Date(tMs);
    const month = d.getUTCMonth() + 1; // 1-12
    const dom = d.getUTCDate(); // 1-31
    const dow = d.getUTCDay(); // 0-6 Sunday=0
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();

    if (!months.includes(month)) {
      // Skip to the 1st of next month
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
      tMs = Date.UTC(nextYear, nextMonth - 1, 1, 0, 0, 0, 0);
      continue;
    }

    if (!doms.includes(dom) || !dows.includes(dow)) {
      // Skip to next day
      tMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dom + 1, 0, 0, 0, 0);
      continue;
    }

    if (!hours.includes(hour)) {
      // Skip to next matching hour today
      const nextHour = hours.find((h) => h > hour);
      if (nextHour !== undefined) {
        tMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dom, nextHour, 0, 0, 0);
      } else {
        // No matching hour today — advance to next day
        tMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dom + 1, 0, 0, 0, 0);
      }
      continue;
    }

    if (!minutes.includes(minute)) {
      // Skip to next matching minute in this hour
      const nextMin = minutes.find((m) => m > minute);
      if (nextMin !== undefined) {
        tMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dom, hour, nextMin, 0, 0);
      } else {
        // No matching minute in this hour — advance to next hour
        tMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dom, hour + 1, 0, 0, 0);
      }
      continue;
    }

    // All fields match!
    return Math.floor(tMs / 1000);
  }

  throw new Error(`No cron match found within 4 years for: ${expr}`);
}
