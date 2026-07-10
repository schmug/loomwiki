// SPDX-License-Identifier: Apache-2.0

import type { Task } from "@loomwiki/schema";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KanbanBoard } from "./KanbanBoard";

vi.mock("@/lib/api-tasks", () => ({
  createTask: vi.fn(),
  patchTask: vi.fn(),
}));

const UID = "0190b0a4-7b2e-7eee-8aaa-aaaaaaaaaaaa";

function task(overrides: Partial<Task>): Task {
  return {
    id: UID,
    workspace_id: UID,
    room_id: null,
    title: "t",
    body: null,
    status: "todo",
    assignee_id: null,
    due_at: null,
    origin_message_id: null,
    created_by: UID,
    created_at: 1,
    updated_at: 1,
    completed_at: null,
    tags: [],
    ...overrides,
  };
}

describe("KanbanBoard", () => {
  it("renders four columns and buckets tasks by status, hiding cancelled", () => {
    const tasks = [
      task({ id: `${UID.slice(0, -1)}1`, title: "in todo", status: "todo" }),
      task({ id: `${UID.slice(0, -1)}2`, title: "in doing", status: "doing" }),
      task({ id: `${UID.slice(0, -1)}3`, title: "hidden", status: "cancelled" }),
    ];
    render(<KanbanBoard initialTasks={tasks} members={[]} rooms={[]} currentUserId={UID} />);
    expect(screen.getByRole("region", { name: "Backlog" })).toBeDefined();
    expect(screen.getByRole("region", { name: "To do" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Doing" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Done" })).toBeDefined();
    expect(screen.getByText("in todo")).toBeDefined();
    expect(screen.getByText("in doing")).toBeDefined();
    expect(screen.queryByText("hidden")).toBeNull();
  });
});
