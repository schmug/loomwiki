// SPDX-License-Identifier: Apache-2.0

// Loomwiki has two wire formats for timestamps and they're both
// load-bearing:
//   - Messages (M2 WS protocol + GET /api/rooms/:rid/messages) use
//     epoch seconds as numbers — see packages/shared/src/ws-protocol.ts
//     and the M2 PR description "Wire format note".
//   - Users / workspaces / rooms (M1) use ISO-8601 strings — see
//     apps/worker/src/lib/serialize.ts.
//
// The two helpers here keep call sites readable. Both render relative
// ("3m ago") for ≤24h, then absolute (locale date+time) thereafter.
// Uses Intl.RelativeTimeFormat — no `date-fns` / `dayjs` dep.

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const ABS = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const TIME_ONLY = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const DAY_HEADING = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function relativeFromSecondsAgo(secondsAgo: number): string {
  const abs = Math.abs(secondsAgo);
  if (abs < MINUTE) return RTF.format(-Math.round(secondsAgo), "second");
  if (abs < HOUR) return RTF.format(-Math.round(secondsAgo / MINUTE), "minute");
  if (abs < DAY) return RTF.format(-Math.round(secondsAgo / HOUR), "hour");
  return RTF.format(-Math.round(secondsAgo / DAY), "day");
}

/** Format a unix-epoch-seconds timestamp (M2 wire format). */
export function formatEpochSeconds(seconds: number, now: number = Date.now() / 1000): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const secondsAgo = now - seconds;
  if (Math.abs(secondsAgo) < DAY) {
    return relativeFromSecondsAgo(secondsAgo);
  }
  return ABS.format(new Date(seconds * 1000));
}

/** Format an ISO-8601 string (M1 wire format). */
export function formatIsoString(iso: string, now: number = Date.now() / 1000): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return formatEpochSeconds(ms / 1000, now);
}

/** Hour:minute only — used for the per-message time stamp inline. */
export function formatTimeOnly(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  return TIME_ONLY.format(new Date(seconds * 1000));
}

/** "Tuesday, May 4" — used for date separators between messages. */
export function formatDayHeading(seconds: number, now: number = Date.now() / 1000): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const date = new Date(seconds * 1000);
  const today = new Date(now * 1000);
  const yesterday = new Date((now - DAY) * 1000);
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return DAY_HEADING.format(date);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
