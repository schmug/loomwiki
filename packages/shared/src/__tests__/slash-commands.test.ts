// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "../slash-commands.js";

describe("parseSlashCommand — non-commands", () => {
  it("ignores plain messages and unknown slash commands", () => {
    expect(parseSlashCommand("hello world")).toEqual({ matched: false });
    expect(parseSlashCommand("/ask what did we decide")).toEqual({ matched: false });
    expect(parseSlashCommand("/tasked wrong")).toEqual({ matched: false });
  });
});

describe("/task", () => {
  it("parses title only", () => {
    expect(parseSlashCommand("/task Fix login bug")).toEqual({
      matched: true,
      ok: true,
      command: { kind: "task", title: "Fix login bug", assigneeToken: null, dueDate: null },
    });
  });

  it("parses assignee and due anywhere", () => {
    expect(parseSlashCommand("/task @cory Fix login bug due:2026-07-20")).toEqual({
      matched: true,
      ok: true,
      command: { kind: "task", title: "Fix login bug", assigneeToken: "cory", dueDate: "2026-07-20" },
    });
  });

  it("rejects empty title", () => {
    const r = parseSlashCommand("/task @cory due:2026-07-20");
    expect(r).toMatchObject({ matched: true, ok: false });
  });

  it("rejects invalid calendar dates", () => {
    expect(parseSlashCommand("/task x due:2026-02-31")).toMatchObject({ matched: true, ok: false });
    expect(parseSlashCommand("/task x due:2026-13-01")).toMatchObject({ matched: true, ok: false });
  });

  it("rejects two assignee tokens", () => {
    expect(parseSlashCommand("/task x @a @b")).toMatchObject({ matched: true, ok: false });
  });
});

describe("/event", () => {
  it("parses all-day event (date only)", () => {
    expect(parseSlashCommand("/event Team offsite 2026-07-20")).toEqual({
      matched: true,
      ok: true,
      command: { kind: "event", title: "Team offsite", date: "2026-07-20", time: null, durationMinutes: null },
    });
  });

  it("parses timed event with duration", () => {
    expect(parseSlashCommand("/event Standup 2026-07-20 09:30 +30m")).toEqual({
      matched: true,
      ok: true,
      command: { kind: "event", title: "Standup", date: "2026-07-20", time: "09:30", durationMinutes: 30 },
    });
    expect(parseSlashCommand("/event Review 2026-07-20 14:00 +2h")).toMatchObject({
      matched: true,
      ok: true,
      command: { durationMinutes: 120 },
    });
  });

  it("rejects missing date, bad time, duration without time, trailing junk", () => {
    expect(parseSlashCommand("/event Standup tomorrow")).toMatchObject({ matched: true, ok: false });
    expect(parseSlashCommand("/event S 2026-07-20 25:00")).toMatchObject({ matched: true, ok: false });
    expect(parseSlashCommand("/event S 2026-07-20 +30m")).toMatchObject({ matched: true, ok: false });
    expect(parseSlashCommand("/event S 2026-07-20 09:00 +30m extra")).toMatchObject({ matched: true, ok: false });
  });
});

describe("/done", () => {
  it("parses the title", () => {
    expect(parseSlashCommand("/done Fix login bug")).toEqual({
      matched: true,
      ok: true,
      command: { kind: "done", title: "Fix login bug" },
    });
  });

  it("rejects empty title", () => {
    expect(parseSlashCommand("/done")).toMatchObject({ matched: true, ok: false });
  });
});
