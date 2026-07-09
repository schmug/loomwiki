// SPDX-License-Identifier: Apache-2.0

// Deterministic slash-command parser for the ChatRoom DO (v0.1 M9).
// Pure string parsing — no NLP, no Date.now(), no DB. The DO resolves
// tokens (assignee → user, title → task) against D1; this module only
// decides shape. `{ matched: false }` means "not ours — treat as a
// normal chat message", which keeps /ask and future commands unaffected.

export type SlashCommand =
  | { kind: "task"; title: string; assigneeToken: string | null; dueDate: string | null }
  | { kind: "event"; title: string; date: string; time: string | null; durationMinutes: number | null }
  | { kind: "done"; title: string };

export type SlashParseResult =
  | { matched: false }
  | { matched: true; ok: true; command: SlashCommand }
  | { matched: true; ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DURATION_RE = /^\+(\d{1,3})([mh])$/;
const MAX_TITLE = 200;

const TASK_USAGE = "usage: /task <title> [@assignee] [due:YYYY-MM-DD]";
const EVENT_USAGE = "usage: /event <title> <YYYY-MM-DD> [HH:MM] [+30m|+2h]";
const DONE_USAGE = "usage: /done <exact task title>";

/** True if `date` (YYYY-MM-DD) is a real UTC calendar date. */
export function isValidUtcDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function err(error: string): SlashParseResult {
  return { matched: true, ok: false, error };
}

function checkTitle(title: string, usage: string): SlashParseResult | null {
  if (title.length === 0) return err(usage);
  if (title.length > MAX_TITLE) return err(`title exceeds ${MAX_TITLE} characters`);
  return null;
}

export function parseSlashCommand(body: string): SlashParseResult {
  const trimmed = body.trim();
  if (!trimmed.startsWith("/")) return { matched: false };
  const tokens = trimmed.split(/\s+/);
  const head = tokens[0];
  if (head !== "/task" && head !== "/event" && head !== "/done") return { matched: false };
  const rest = tokens.slice(1);

  if (head === "/done") {
    const title = rest.join(" ");
    const bad = checkTitle(title, DONE_USAGE);
    if (bad) return bad;
    return { matched: true, ok: true, command: { kind: "done", title } };
  }

  if (head === "/task") {
    let assigneeToken: string | null = null;
    let dueDate: string | null = null;
    const titleTokens: string[] = [];
    for (const tok of rest) {
      if (tok.startsWith("@") && tok.length > 1) {
        if (assigneeToken !== null) return err("only one @assignee allowed");
        assigneeToken = tok.slice(1);
      } else if (tok.startsWith("due:")) {
        if (dueDate !== null) return err("only one due: allowed");
        const date = tok.slice(4);
        if (!isValidUtcDate(date)) return err("due: must be a valid YYYY-MM-DD date");
        dueDate = date;
      } else {
        titleTokens.push(tok);
      }
    }
    const title = titleTokens.join(" ");
    const bad = checkTitle(title, TASK_USAGE);
    if (bad) return bad;
    return { matched: true, ok: true, command: { kind: "task", title, assigneeToken, dueDate } };
  }

  // head === "/event"
  const dateIdx = rest.findIndex((tok) => DATE_RE.test(tok));
  if (dateIdx === -1) return err(EVENT_USAGE);
  const date = rest[dateIdx];
  if (date === undefined || !isValidUtcDate(date)) {
    return err("event date must be a valid YYYY-MM-DD date");
  }
  const title = rest.slice(0, dateIdx).join(" ");
  const bad = checkTitle(title, EVENT_USAGE);
  if (bad) return bad;

  let time: string | null = null;
  let durationMinutes: number | null = null;
  const tail = rest.slice(dateIdx + 1);
  let i = 0;
  const maybeTime = tail[i];
  if (maybeTime !== undefined && TIME_RE.test(maybeTime)) {
    time = maybeTime;
    i += 1;
  }
  const maybeDuration = tail[i];
  if (maybeDuration !== undefined) {
    const m = DURATION_RE.exec(maybeDuration);
    if (m === null) {
      return err(time === null ? "expected HH:MM time or nothing after the date" : EVENT_USAGE);
    }
    if (time === null) return err("duration requires a HH:MM time");
    const n = Number.parseInt(m[1] ?? "0", 10);
    durationMinutes = m[2] === "h" ? n * 60 : n;
    i += 1;
  }
  if (i < tail.length) return err(EVENT_USAGE);

  return { matched: true, ok: true, command: { kind: "event", title, date, time, durationMinutes } };
}
