// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CalendarEntrySchema,
  CreateEventRequestSchema,
  CreateTaskRequestSchema,
  EventRowSchema,
  PatchTaskRequestSchema,
  TASK_BOARD_STATUSES,
  TaskRowSchema,
} from "../index.js";

const UID = "0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa";

const taskRow = {
  id: UID,
  workspace_id: UID,
  room_id: null,
  title: "Fix login bug",
  body: null,
  status: "todo",
  assignee_id: null,
  due_at: null,
  origin_message_id: null,
  created_by: UID,
  created_at: 1751971200,
  updated_at: 1751971200,
  completed_at: null,
};

const eventRow = {
  id: UID,
  workspace_id: UID,
  room_id: null,
  title: "Standup",
  body: null,
  starts_at: 1751971200,
  ends_at: null,
  all_day: 1,
  rrule: null,
  origin_message_id: null,
  created_by: UID,
  created_at: 1751971200,
  updated_at: 1751971200,
  cancelled_at: null,
};

describe("TaskRowSchema", () => {
  it("parses a valid row", () => {
    expect(TaskRowSchema.parse(taskRow)).toEqual(taskRow);
  });

  it("rejects an unknown status", () => {
    expect(TaskRowSchema.safeParse({ ...taskRow, status: "blocked" }).success).toBe(false);
  });

  it("board statuses exclude cancelled", () => {
    expect(TASK_BOARD_STATUSES).toEqual(["backlog", "todo", "doing", "done"]);
  });
});

describe("EventRowSchema", () => {
  it("parses a valid row", () => {
    expect(EventRowSchema.parse(eventRow)).toEqual(eventRow);
  });

  it("rejects a non-null rrule (reserved in v1)", () => {
    expect(EventRowSchema.safeParse({ ...eventRow, rrule: "FREQ=WEEKLY" }).success).toBe(false);
  });
});

describe("request schemas", () => {
  it("CreateTaskRequest accepts minimal shape and rejects extras", () => {
    expect(CreateTaskRequestSchema.safeParse({ title: "x" }).success).toBe(true);
    expect(CreateTaskRequestSchema.safeParse({ title: "x", nope: 1 }).success).toBe(false);
  });

  it("PatchTaskRequest rejects empty patch", () => {
    expect(PatchTaskRequestSchema.safeParse({}).success).toBe(false);
    expect(PatchTaskRequestSchema.safeParse({ status: "done" }).success).toBe(true);
  });

  it("CreateEventRequest rejects ends_at before starts_at", () => {
    const bad = { title: "x", starts_at: 100, ends_at: 50 };
    expect(CreateEventRequestSchema.safeParse(bad).success).toBe(false);
    expect(CreateEventRequestSchema.safeParse({ title: "x", starts_at: 100 }).success).toBe(true);
  });
});

describe("CalendarEntrySchema", () => {
  it("discriminates on kind", () => {
    const taskEntry = {
      kind: "task_due",
      id: UID,
      title: "t",
      status: "todo",
      room_id: null,
      assignee_id: null,
      due_at: 1751971200,
    };
    const eventEntry = {
      kind: "event",
      id: UID,
      title: "e",
      room_id: null,
      starts_at: 1751971200,
      ends_at: null,
      all_day: 0,
    };
    expect(CalendarEntrySchema.safeParse(taskEntry).success).toBe(true);
    expect(CalendarEntrySchema.safeParse(eventEntry).success).toBe(true);
    expect(CalendarEntrySchema.safeParse({ ...eventEntry, kind: "task_due" }).success).toBe(false);
  });
});
