// SPDX-License-Identifier: Apache-2.0

// Calendar (v0.1 M9): month grid + week strip over GET /api/calendar.
// Bucketing rule lives in lib/calendar-dates.entryDayIso — date-only values
// by UTC date, timed events by browser-local date. Month changes refetch;
// filters refetch server-side (room/user are query params, not client
// filtering, so the range cap stays meaningful).

import { createEvent, getCalendar } from "@/lib/api-calendar";
import {
  addMonths,
  entryDayIso,
  formStartsAt,
  gridRangeEpochs,
  localDateIso,
  localTimeLabel,
  monthGrid,
  monthLabel,
} from "@/lib/calendar-dates";
import type { CalendarEntry } from "@loomwiki/schema";
import { useMemo, useState } from "react";

export interface CalendarViewProps {
  initialEntries: CalendarEntry[];
  initialYear: number;
  initialMonth: number; // 1-12
  rooms: Array<{ id: string; slug: string }>;
  currentUserId: string;
}

export function CalendarView({
  initialEntries,
  initialYear,
  initialMonth,
  rooms,
  currentUserId,
}: CalendarViewProps) {
  const [pos, setPos] = useState({ year: initialYear, month: initialMonth });
  const [entries, setEntries] = useState<CalendarEntry[]>(initialEntries);
  const [roomFilter, setRoomFilter] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [view, setView] = useState<"month" | "week">("month");
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", date: "", time: "" });

  const grid = useMemo(() => monthGrid(pos.year, pos.month), [pos]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const e of entries) {
      const key = entryDayIso(e);
      const list = map.get(key) ?? [];
      list.push(e);
      map.set(key, list);
    }
    return map;
  }, [entries]);

  async function load(year: number, month: number, room: string, mine: boolean): Promise<void> {
    const { from, to } = gridRangeEpochs(monthGrid(year, month));
    try {
      const resp = await getCalendar(from, to, {
        ...(room !== "" ? { room } : {}),
        ...(mine ? { user: currentUserId } : {}),
      });
      setEntries(resp.entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load calendar");
    }
  }

  function nav(delta: number): void {
    const next =
      delta === 0
        ? { year: new Date().getFullYear(), month: new Date().getMonth() + 1 }
        : addMonths(pos.year, pos.month, delta);
    setPos(next);
    void load(next.year, next.month, roomFilter, mineOnly);
  }

  async function addEvent(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const title = form.title.trim();
    if (title === "" || form.date === "") return;
    const { startsAt, allDay } = formStartsAt(form.date, form.time === "" ? null : form.time);
    try {
      await createEvent({ title, starts_at: startsAt, all_day: allDay });
      setForm({ title: "", date: "", time: "" });
      await load(pos.year, pos.month, roomFilter, mineOnly);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create event");
    }
  }

  const todayIso = localDateIso(Math.floor(Date.now() / 1000));
  const weeks =
    view === "month"
      ? grid
      : [grid.find((w) => w.some((d) => d.iso === todayIso)) ?? grid[0] ?? []];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => nav(-1)}
          aria-label="Previous month"
          className="rounded-md border border-border px-2 py-1 text-sm"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={() => nav(0)}
          className="rounded-md border border-border px-2 py-1 text-sm"
        >
          Today
        </button>
        <button
          type="button"
          onClick={() => nav(1)}
          aria-label="Next month"
          className="rounded-md border border-border px-2 py-1 text-sm"
        >
          ›
        </button>
        <h2 className="px-1 text-sm font-semibold">{monthLabel(pos.year, pos.month)}</h2>
        <button
          type="button"
          onClick={() => setView(view === "month" ? "week" : "month")}
          className="rounded-md border border-border px-2 py-1 text-sm"
        >
          {view === "month" ? "Week view" : "Month view"}
        </button>
        <select
          value={roomFilter}
          onChange={(e) => {
            setRoomFilter(e.target.value);
            void load(pos.year, pos.month, e.target.value, mineOnly);
          }}
          aria-label="Filter by room"
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="">All rooms</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              #{r.slug}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            checked={mineOnly}
            onChange={(e) => {
              setMineOnly(e.target.checked);
              void load(pos.year, pos.month, roomFilter, e.target.checked);
            }}
          />
          Mine
        </label>
      </div>

      <form onSubmit={addEvent} className="flex flex-wrap items-center gap-2">
        <input
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="New event title…"
          aria-label="New event title"
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        />
        <input
          type="date"
          value={form.date}
          onChange={(e) => setForm({ ...form, date: e.target.value })}
          aria-label="Event date"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        />
        <input
          type="time"
          value={form.time}
          onChange={(e) => setForm({ ...form, time: e.target.value })}
          aria-label="Event time (optional)"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        />
        <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm">
          Add event
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="grid grid-cols-7 gap-px rounded-lg border border-border bg-border text-xs">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="bg-muted/50 p-1 text-center font-semibold">
            {d}
          </div>
        ))}
        {weeks.flat().map((day) => (
          <div
            key={day.iso}
            className={`min-h-20 bg-background p-1 ${day.inMonth ? "" : "opacity-50"} ${day.iso === todayIso ? "ring-1 ring-inset ring-blue-500" : ""}`}
          >
            <div className="text-right text-muted-foreground">{day.dayOfMonth}</div>
            <div className="flex flex-col gap-0.5">
              {(byDay.get(day.iso) ?? []).map((e) => (
                <span
                  key={`${e.kind}:${e.id}`}
                  className={`truncate rounded px-1 ${
                    e.kind === "event"
                      ? "bg-blue-500/15"
                      : e.status === "done"
                        ? "bg-muted line-through"
                        : "bg-amber-500/15"
                  }`}
                  title={e.title}
                >
                  {e.kind === "event" && e.all_day === 0 ? `${localTimeLabel(e.starts_at)} ` : ""}
                  {e.title}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
