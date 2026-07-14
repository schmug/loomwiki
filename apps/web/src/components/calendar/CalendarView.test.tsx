// SPDX-License-Identifier: Apache-2.0

import type { CalendarEntry } from "@loomwiki/schema";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CalendarView } from "./CalendarView";

vi.mock("@/lib/api-calendar", () => ({
  getCalendar: vi.fn(),
  createEvent: vi.fn(),
}));

const UID = "0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa";

describe("CalendarView", () => {
  it("renders the month label and buckets entries onto their UTC day", () => {
    const entries: CalendarEntry[] = [
      {
        kind: "event",
        id: UID,
        title: "Offsite",
        room_id: null,
        starts_at: Date.parse("2026-07-20T00:00:00Z") / 1000,
        ends_at: null,
        all_day: 1,
      },
      {
        kind: "task_due",
        id: `${UID.slice(0, -1)}1`,
        title: "Ship M9",
        status: "done",
        room_id: null,
        assignee_id: null,
        due_at: Date.parse("2026-07-21T00:00:00Z") / 1000,
      },
    ];
    render(
      <CalendarView
        initialEntries={entries}
        initialYear={2026}
        initialMonth={7}
        rooms={[]}
        currentUserId={UID}
      />,
    );
    expect(screen.getByText("July 2026")).toBeDefined();
    expect(screen.getByText("Offsite")).toBeDefined();
    expect(screen.getByText("Ship M9")).toBeDefined();
  });
});
