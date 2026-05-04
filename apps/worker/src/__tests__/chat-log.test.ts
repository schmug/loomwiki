// SPDX-License-Identifier: Apache-2.0

// Unit tests for the chat-log path/format helpers. The integration
// tests in archive-day.test.ts exercise the D1 + backend round-trip;
// these tests own the formatter contract — frontmatter shape, body
// ordering, tombstone rendering, deterministic re-format.

import { describe, expect, it } from "vitest";
import {
  type ArchivableMessage,
  dayBoundsUtc,
  formatChatLogContent,
  formatChatLogPath,
  isValidIsoDate,
  previousUtcDayFromScheduledTime,
  validateChatLogPath,
} from "../lib/chat-log.js";

const ALICE = "01900000-0000-7000-8000-000000000001";
const BOB = "01900000-0000-7000-8000-000000000002";

describe("formatChatLogPath / validateChatLogPath", () => {
  it("formats canonical /rooms/{slug}/log/{date}.md", () => {
    const path = formatChatLogPath("general", "2026-05-03");
    expect(path).toBe("/rooms/general/log/2026-05-03.md");
    expect(validateChatLogPath(path)).toBe(true);
  });

  it("validateChatLogPath accepts conformant paths", () => {
    expect(validateChatLogPath("/rooms/general/log/2026-05-03.md")).toBe(true);
    expect(validateChatLogPath("/rooms/ops-cyber/log/2099-12-31.md")).toBe(true);
  });

  it("validateChatLogPath rejects everything else", () => {
    // Uppercase room slug
    expect(validateChatLogPath("/rooms/General/log/2026-05-03.md")).toBe(false);
    // Wrong prefix
    expect(validateChatLogPath("/wiki/general/log/2026-05-03.md")).toBe(false);
    // Garbage suffix
    expect(validateChatLogPath("/rooms/general/log/garbage.md")).toBe(false);
    // No .md
    expect(validateChatLogPath("/rooms/general/log/2026-05-03")).toBe(false);
    // Path traversal
    expect(validateChatLogPath("/rooms/general/log/../escape.md")).toBe(false);
    // Empty / oversize
    expect(validateChatLogPath("")).toBe(false);
    // Slug starting with digit (rooms slugs must start with a letter)
    expect(validateChatLogPath("/rooms/9general/log/2026-05-03.md")).toBe(false);
  });
});

describe("isValidIsoDate", () => {
  it("accepts well-formed YYYY-MM-DD strings", () => {
    expect(isValidIsoDate("2026-05-03")).toBe(true);
    expect(isValidIsoDate("2000-01-01")).toBe(true);
  });
  it("rejects malformed or impossible dates", () => {
    expect(isValidIsoDate("2026-13-01")).toBe(false); // bad month
    expect(isValidIsoDate("2026-02-31")).toBe(false); // calendar overflow
    expect(isValidIsoDate("26-05-03")).toBe(false); // wrong shape
    expect(isValidIsoDate("not-a-date")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
  });
});

describe("previousUtcDayFromScheduledTime", () => {
  it("returns yesterday for a 02:00 UTC tick", () => {
    const ts = Date.parse("2026-05-04T02:00:00Z");
    expect(previousUtcDayFromScheduledTime(ts)).toBe("2026-05-03");
  });

  it("returns yesterday for a tick exactly at midnight UTC (the -1ms guard)", () => {
    const ts = Date.parse("2026-05-04T00:00:00Z");
    expect(previousUtcDayFromScheduledTime(ts)).toBe("2026-05-03");
  });

  it("returns yesterday for any time-of-day on the scheduled date", () => {
    // Late-day tick still archives YESTERDAY relative to the
    // scheduledTime's UTC date — the function is time-of-day agnostic.
    const ts = Date.parse("2026-05-04T23:59:59Z");
    expect(previousUtcDayFromScheduledTime(ts)).toBe("2026-05-03");
  });

  it("uses UTC, not local time (DST has no effect on UTC arithmetic)", () => {
    // March transition in many locales — UTC offset stays 0.
    const ts = Date.parse("2026-03-30T02:00:00Z");
    expect(previousUtcDayFromScheduledTime(ts)).toBe("2026-03-29");
  });
});

describe("dayBoundsUtc", () => {
  it("returns [start, end) in epoch seconds spanning 24h", () => {
    const { startSec, endSec } = dayBoundsUtc("2026-05-03");
    expect(endSec - startSec).toBe(86400);
    expect(new Date(startSec * 1000).toISOString()).toBe("2026-05-03T00:00:00.000Z");
    expect(new Date(endSec * 1000).toISOString()).toBe("2026-05-04T00:00:00.000Z");
  });
});

describe("formatChatLogContent", () => {
  it("returns null for an empty message list", () => {
    expect(
      formatChatLogContent({
        roomSlug: "general",
        dateUtc: "2026-05-03",
        messages: [],
        displayNamesById: new Map(),
      }),
    ).toBeNull();
  });

  it("renders frontmatter + a single message block", () => {
    const messages: ArchivableMessage[] = [
      {
        id: "01900000-0000-7000-8000-aaaaaaaaaaa1",
        room_id: "room-1",
        user_id: ALICE,
        body: "hello",
        // 2026-05-03T14:32:11Z
        created_at: Math.floor(Date.parse("2026-05-03T14:32:11Z") / 1000),
        edited_at: null,
        deleted_at: null,
      },
    ];
    const content = formatChatLogContent({
      roomSlug: "general",
      dateUtc: "2026-05-03",
      messages,
      displayNamesById: new Map([[ALICE, "alice"]]),
    });
    expect(content).toBe(
      [
        "---",
        "room: general",
        "date: 2026-05-03",
        "message_count: 1",
        "ingest_run_ids: []",
        "---",
        "",
        "## 14:32 alice",
        "",
        "hello",
        "",
      ].join("\n"),
    );
  });

  it("orders by created_at, then by id, regardless of input order", () => {
    const tBase = Math.floor(Date.parse("2026-05-03T14:00:00Z") / 1000);
    const messages: ArchivableMessage[] = [
      {
        id: "01900000-0000-7000-8000-aaaaaaaaaaa3",
        room_id: "r",
        user_id: ALICE,
        body: "third",
        created_at: tBase + 60,
        edited_at: null,
        deleted_at: null,
      },
      {
        id: "01900000-0000-7000-8000-aaaaaaaaaaa1",
        room_id: "r",
        user_id: ALICE,
        body: "first-tied",
        created_at: tBase,
        edited_at: null,
        deleted_at: null,
      },
      {
        id: "01900000-0000-7000-8000-aaaaaaaaaaa2",
        room_id: "r",
        user_id: BOB,
        body: "second-tied",
        created_at: tBase,
        edited_at: null,
        deleted_at: null,
      },
    ];
    const content = formatChatLogContent({
      roomSlug: "general",
      dateUtc: "2026-05-03",
      messages,
      displayNamesById: new Map([
        [ALICE, "alice"],
        [BOB, "bob"],
      ]),
    });
    // Bodies should appear in (first-tied, second-tied, third) order.
    const idxFirst = content?.indexOf("first-tied") ?? -1;
    const idxSecond = content?.indexOf("second-tied") ?? -1;
    const idxThird = content?.indexOf("third") ?? -1;
    expect(idxFirst).toBeGreaterThan(0);
    expect(idxSecond).toBeGreaterThan(idxFirst);
    expect(idxThird).toBeGreaterThan(idxSecond);
  });

  it("renders tombstoned messages as [deleted]", () => {
    const messages: ArchivableMessage[] = [
      {
        id: "01900000-0000-7000-8000-aaaaaaaaaaa1",
        room_id: "r",
        user_id: ALICE,
        body: "",
        created_at: Math.floor(Date.parse("2026-05-03T08:00:00Z") / 1000),
        edited_at: null,
        deleted_at: Math.floor(Date.parse("2026-05-03T09:00:00Z") / 1000),
      },
    ];
    const content = formatChatLogContent({
      roomSlug: "general",
      dateUtc: "2026-05-03",
      messages,
      displayNamesById: new Map([[ALICE, "alice"]]),
    });
    expect(content).toContain("## 08:00 alice");
    expect(content).toContain("[deleted]");
  });

  it("uses the post-edit body for edited messages", () => {
    const messages: ArchivableMessage[] = [
      {
        id: "01900000-0000-7000-8000-aaaaaaaaaaa1",
        room_id: "r",
        user_id: ALICE,
        body: "final text after edit",
        created_at: Math.floor(Date.parse("2026-05-03T08:00:00Z") / 1000),
        edited_at: Math.floor(Date.parse("2026-05-03T08:01:00Z") / 1000),
        deleted_at: null,
      },
    ];
    const content = formatChatLogContent({
      roomSlug: "general",
      dateUtc: "2026-05-03",
      messages,
      displayNamesById: new Map([[ALICE, "alice"]]),
    });
    expect(content).toContain("final text after edit");
  });

  it("falls back to <deleted user> for an unknown user id", () => {
    const messages: ArchivableMessage[] = [
      {
        id: "01900000-0000-7000-8000-aaaaaaaaaaa1",
        room_id: "r",
        user_id: ALICE,
        body: "hi",
        created_at: Math.floor(Date.parse("2026-05-03T08:00:00Z") / 1000),
        edited_at: null,
        deleted_at: null,
      },
    ];
    const content = formatChatLogContent({
      roomSlug: "general",
      dateUtc: "2026-05-03",
      messages,
      displayNamesById: new Map(), // ALICE missing
    });
    expect(content).toContain("<deleted user>");
  });

  it("is deterministic — same input produces byte-identical output", () => {
    const messages: ArchivableMessage[] = [
      {
        id: "01900000-0000-7000-8000-aaaaaaaaaaa1",
        room_id: "r",
        user_id: ALICE,
        body: "hi",
        created_at: Math.floor(Date.parse("2026-05-03T08:00:00Z") / 1000),
        edited_at: null,
        deleted_at: null,
      },
      {
        id: "01900000-0000-7000-8000-aaaaaaaaaaa2",
        room_id: "r",
        user_id: BOB,
        body: "hello",
        created_at: Math.floor(Date.parse("2026-05-03T09:00:00Z") / 1000),
        edited_at: null,
        deleted_at: null,
      },
    ];
    const args = {
      roomSlug: "general",
      dateUtc: "2026-05-03",
      messages,
      displayNamesById: new Map([
        [ALICE, "alice"],
        [BOB, "bob"],
      ]),
    } as const;
    expect(formatChatLogContent(args)).toBe(formatChatLogContent(args));
  });

  it("ends with a single trailing newline (POSIX convention)", () => {
    const messages: ArchivableMessage[] = [
      {
        id: "01900000-0000-7000-8000-aaaaaaaaaaa1",
        room_id: "r",
        user_id: ALICE,
        body: "hi",
        created_at: Math.floor(Date.parse("2026-05-03T08:00:00Z") / 1000),
        edited_at: null,
        deleted_at: null,
      },
    ];
    const content = formatChatLogContent({
      roomSlug: "general",
      dateUtc: "2026-05-03",
      messages,
      displayNamesById: new Map([[ALICE, "alice"]]),
    });
    expect(content?.endsWith("\n")).toBe(true);
    expect(content?.endsWith("\n\n")).toBe(false);
  });
});
