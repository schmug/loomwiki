// SPDX-License-Identifier: Apache-2.0

// Unified timeline feed (issue #32). Owner-only surface — the Astro
// page enforces the gate server-side; this island renders the feed and
// the client-side controls (source pills, day/week/month grouping vs a
// flat feed). Data comes from GET /api/timeline, which server-side-
// unions audit_log + ingest_runs + scheduled_actions (+ issue_threads
// once #30 lands). The same Zod-inferred `TimelineEntry` type the
// worker emits is imported here from @loomwiki/schema so the two sides
// never drift.
//
// Q-tl-3: the server returns unix-epoch seconds; this island converts
// to the *viewer's* local timezone for the day/week/month grouping.

import { apiGet } from "@/lib/api";
import {
  TIMELINE_FILTER_PILLS,
  type TimelineEntry,
  type TimelineFilterPill,
} from "@loomwiki/schema";
import { useCallback, useEffect, useState } from "react";

interface RoomRef {
  id: string;
  slug: string;
}

export interface TimelineFeedProps {
  initialEntries: TimelineEntry[];
  initialNextCursor: string | null;
  /** room_id → slug, for deep-linking ingest/scheduled entries. */
  rooms: RoomRef[];
}

type ViewMode = "feed" | "day" | "week" | "month";

interface TimelineApiResponse {
  entries: TimelineEntry[];
  next_cursor: string | null;
}

const PILL_LABEL: Record<TimelineFilterPill, string> = {
  chat: "Chat",
  wiki: "Wiki",
  ingest: "Ingest",
  scheduled: "Scheduled",
  issue: "Issue",
};

// Empty-state copy per pill. Each names the upstream that will populate
// it so the operator understands an empty filter is "not built yet",
// not "broken".
const EMPTY_COPY: Record<TimelineFilterPill, string> = {
  chat: "No chat activity yet — chat-stream timeline rows land with a future producer (Q-tl-2).",
  wiki: "No wiki activity yet — merged proposals and AGENTS.md edits show here.",
  ingest: "No ingest runs yet — trigger one from a chat room or wait for the daily 03:00 UTC scan.",
  scheduled: "No scheduled prompts yet — set one up via Settings → Schedules.",
  issue: "No issue activity yet — lands with #30 (spec-kit Issue threads).",
};

function epochToLocal(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

// Day bucket key in the *viewer's* local timezone (Q-tl-3). For
// week/month we still bucket by the entry's local day, then collapse
// the heading to the week-start / month.
function localDayKey(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function groupHeading(epochSeconds: number, mode: ViewMode): string {
  const d = new Date(epochSeconds * 1000);
  if (mode === "month") {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long" });
  }
  if (mode === "week") {
    // Week starting Monday, in viewer-local time.
    const day = d.getDay(); // 0=Sun
    const diffToMonday = (day + 6) % 7;
    const monday = new Date(d);
    monday.setDate(d.getDate() - diffToMonday);
    return `Week of ${monday.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })}`;
  }
  // day
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function bucketKey(epochSeconds: number, mode: ViewMode): string {
  const d = new Date(epochSeconds * 1000);
  if (mode === "month") return `${d.getFullYear()}-${d.getMonth()}`;
  if (mode === "week") {
    const day = d.getDay();
    const diffToMonday = (day + 6) % 7;
    const monday = new Date(d);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(d.getDate() - diffToMonday);
    return `w${monday.getTime()}`;
  }
  return localDayKey(epochSeconds);
}

function entryTitle(e: TimelineEntry): string {
  switch (e.source) {
    case "audit":
      return e.action;
    case "ingest":
      return `Ingest run ${e.status}`;
    case "scheduled":
      return `Scheduled prompt (${e.kind}) — ${e.status}`;
    case "issue":
      return `Issue #${e.issue_number} — ${e.status}`;
  }
}

function entryDetail(e: TimelineEntry): string {
  switch (e.source) {
    case "audit":
      return `${e.resource_kind}${e.resource_id ? ` · ${e.resource_id}` : ""}`;
    case "ingest":
      return e.summary ?? e.error ?? "—";
    case "scheduled":
      return e.prompt_preview;
    case "issue":
      return e.repo;
  }
}

function entryHref(e: TimelineEntry, roomSlugById: Map<string, string>): string | null {
  switch (e.source) {
    case "audit":
      // Proposal merge/reject → deep-link to the proposal detail (which
      // renders the snapshotted before/after diff). Other audit kinds
      // have no dedicated page in v0.0.1.
      if (e.resource_kind === "proposal" && e.resource_id) {
        return `/inbox/proposals/${e.resource_id}`;
      }
      return null;
    case "ingest": {
      const slug = roomSlugById.get(e.room_id);
      return slug ? `/r/${slug}` : null;
    }
    case "scheduled": {
      const slug = roomSlugById.get(e.room_id);
      return slug ? `/r/${slug}` : null;
    }
    case "issue":
      // Once #30 lands, deep-link to the linked chat thread.
      if (e.chat_room_id) {
        const slug = roomSlugById.get(e.chat_room_id);
        return slug ? `/r/${slug}` : null;
      }
      return null;
  }
}

export function TimelineFeed({ initialEntries, initialNextCursor, rooms }: TimelineFeedProps) {
  const roomSlugById = new Map(rooms.map((r) => [r.id, r.slug]));
  const [active, setActive] = useState<Set<TimelineFilterPill>>(new Set());
  const [view, setView] = useState<ViewMode>("feed");
  const [entries, setEntries] = useState<TimelineEntry[]>(initialEntries);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildQuery = useCallback(
    (cursor: string | null): string => {
      const params = new URLSearchParams();
      if (active.size > 0) params.set("sources", Array.from(active).join(","));
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      return `/api/timeline${qs ? `?${qs}` : ""}`;
    },
    [active],
  );

  // Refetch from scratch whenever the active pill set changes. The
  // initial SSR payload is unfiltered, so any pill change needs a
  // fresh page-1 fetch (poll-on-filter-change; realtime push is a
  // documented follow-up, out of scope for #32).
  useEffect(() => {
    let cancelled = false;
    if (active.size === 0) {
      // Restore the SSR-provided unfiltered first page without a
      // network round-trip on the very first render.
      setEntries(initialEntries);
      setNextCursor(initialNextCursor);
      return;
    }
    setLoading(true);
    setError(null);
    apiGet<TimelineApiResponse>(buildQuery(null))
      .then((res) => {
        if (cancelled) return;
        setEntries(res.entries);
        setNextCursor(res.next_cursor);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load timeline");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, buildQuery, initialEntries, initialNextCursor]);

  const togglePill = (pill: TimelineFilterPill) => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(pill)) next.delete(pill);
      else next.add(pill);
      return next;
    });
  };

  const loadMore = async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<TimelineApiResponse>(buildQuery(nextCursor));
      setEntries((prev) => [...prev, ...res.entries]);
      setNextCursor(res.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoading(false);
    }
  };

  // Which empty-state copy to show when the feed is empty: if exactly
  // one pill is active, name its upstream; otherwise generic.
  const emptyCopy =
    active.size === 1
      ? EMPTY_COPY[Array.from(active)[0] as TimelineFilterPill]
      : "Nothing here yet. Workspace activity (proposals, wiki edits, agent runs, scheduled prompts) will appear as it happens.";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <fieldset aria-label="Source filters" className="m-0 flex flex-wrap gap-1.5 border-0 p-0">
          {TIMELINE_FILTER_PILLS.map((pill) => {
            const on = active.has(pill);
            return (
              <button
                key={pill}
                type="button"
                aria-pressed={on}
                onClick={() => togglePill(pill)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  on
                    ? "border-foreground bg-foreground text-background"
                    : "border-border text-muted-foreground hover:bg-secondary/60"
                }`}
              >
                {PILL_LABEL[pill]}
              </button>
            );
          })}
        </fieldset>
        <fieldset aria-label="View mode" className="m-0 ml-auto flex gap-1.5 border-0 p-0">
          {(["feed", "day", "week", "month"] as ViewMode[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={view === m}
              onClick={() => setView(m)}
              className={`rounded-md border px-2.5 py-1 text-xs capitalize transition-colors ${
                view === m
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:bg-secondary/60"
              }`}
            >
              {m}
            </button>
          ))}
        </fieldset>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p className="px-4 py-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {entries.length === 0 && !loading ? (
          <div className="grid h-full place-items-center p-8 text-center">
            <div className="max-w-md space-y-2">
              <h2 className="text-lg font-semibold">No activity</h2>
              <p className="text-sm text-muted-foreground">{emptyCopy}</p>
            </div>
          </div>
        ) : view === "feed" ? (
          <TimelineList entries={entries} roomSlugById={roomSlugById} />
        ) : (
          <GroupedTimeline entries={entries} mode={view} roomSlugById={roomSlugById} />
        )}

        {nextCursor && (
          <div className="flex justify-center p-4">
            <button
              type="button"
              onClick={loadMore}
              disabled={loading}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-secondary/60 disabled:opacity-50"
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineList({
  entries,
  roomSlugById,
}: {
  entries: TimelineEntry[];
  roomSlugById: Map<string, string>;
}) {
  return (
    <ul aria-label="Timeline" className="divide-y divide-border">
      {entries.map((e) => (
        <li key={`${e.source}:${e.id}`}>
          <TimelineRow entry={e} roomSlugById={roomSlugById} />
        </li>
      ))}
    </ul>
  );
}

function GroupedTimeline({
  entries,
  mode,
  roomSlugById,
}: {
  entries: TimelineEntry[];
  mode: ViewMode;
  roomSlugById: Map<string, string>;
}) {
  const groups: { key: string; heading: string; items: TimelineEntry[] }[] = [];
  const byKey = new Map<string, number>();
  for (const e of entries) {
    const key = bucketKey(e.at, mode);
    let idx = byKey.get(key);
    if (idx === undefined) {
      idx = groups.length;
      byKey.set(key, idx);
      groups.push({ key, heading: groupHeading(e.at, mode), items: [] });
    }
    groups[idx]?.items.push(e);
  }
  return (
    <div>
      {groups.map((g) => (
        <section key={g.key} aria-label={g.heading}>
          <h3 className="sticky top-0 z-10 bg-secondary/80 px-4 py-1.5 text-xs font-semibold text-muted-foreground backdrop-blur">
            {g.heading}
          </h3>
          <ul className="divide-y divide-border">
            {g.items.map((e) => (
              <li key={`${e.source}:${e.id}`}>
                <TimelineRow entry={e} roomSlugById={roomSlugById} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TimelineRow({
  entry,
  roomSlugById,
}: {
  entry: TimelineEntry;
  roomSlugById: Map<string, string>;
}) {
  const href = entryHref(entry, roomSlugById);
  const body = (
    <div className="flex items-start gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className="mt-0.5 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground"
      >
        {entry.source}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{entryTitle(entry)}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{entryDetail(entry)}</p>
      </div>
      <time className="ml-auto shrink-0 text-[11px] text-muted-foreground">
        {epochToLocal(entry.at)}
      </time>
    </div>
  );
  if (href) {
    return (
      <a href={href} className="block transition-colors hover:bg-secondary/40">
        {body}
      </a>
    );
  }
  return body;
}
