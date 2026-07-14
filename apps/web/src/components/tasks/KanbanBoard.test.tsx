// SPDX-License-Identifier: Apache-2.0

import { patchTask } from "@/lib/api-tasks";
import type { Task } from "@loomwiki/schema";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("rolls back only the rejected task even when its rejection settles after a concurrent success", async () => {
    const patchTaskMock = vi.mocked(patchTask);
    const idOne = `${UID.slice(0, -1)}1`;
    const idTwo = `${UID.slice(0, -1)}2`;
    const taskOne = task({ id: idOne, title: "task one", status: "todo" });
    const taskTwo = task({ id: idTwo, title: "task two", status: "todo" });

    // Manually-controlled promises so we can dictate settle order: task
    // two's success is made to land BEFORE task one's rejection is
    // processed. That's the ordering that exposes a whole-array-snapshot
    // rollback — if the rejected drag's revert captured `tasks` before
    // task two's move, it clobbers task two's already-committed change.
    // (Under natural same-tick microtask ordering the two calls happen to
    // settle in start order, which accidentally masks the bug — so the
    // ordering is forced here rather than left to chance.)
    let rejectFirst!: (err: Error) => void;
    let resolveSecond!: (payload: { task: Task }) => void;
    const firstPatch = new Promise<{ task: Task }>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const secondPatch = new Promise<{ task: Task }>((resolve) => {
      resolveSecond = resolve;
    });
    patchTaskMock.mockImplementationOnce(() => firstPatch);
    patchTaskMock.mockImplementationOnce(() => secondPatch);

    render(
      <KanbanBoard initialTasks={[taskOne, taskTwo]} members={[]} rooms={[]} currentUserId={UID} />,
    );

    const todoColumn = screen.getByRole("region", { name: "To do" });
    const doingColumn = screen.getByRole("region", { name: "Doing" });
    const doneColumn = screen.getByRole("region", { name: "Done" });

    expect(within(todoColumn).getByText("task one")).toBeDefined();
    expect(within(todoColumn).getByText("task two")).toBeDefined();

    // Drag task one to Doing (will reject) and task two to Done (will
    // resolve) — both optimistic updates land before either promise settles.
    fireEvent.drop(doingColumn, { dataTransfer: { getData: () => idOne } });
    fireEvent.drop(doneColumn, { dataTransfer: { getData: () => idTwo } });

    await waitFor(() => expect(patchTaskMock).toHaveBeenCalledTimes(2));

    // Settle task two's move first and let its per-task commit land...
    await act(async () => {
      resolveSecond({ task: { ...taskTwo, status: "done" } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(within(doneColumn).getByText("task two")).toBeDefined();

    // ...then settle task one's rejection.
    await act(async () => {
      rejectFirst(new Error("network fail"));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Task one must revert to its prior column (Todo), not stay in Doing.
    await waitFor(() => expect(within(todoColumn).getByText("task one")).toBeDefined());
    expect(within(doingColumn).queryByText("task one")).toBeNull();

    // Task two's already-committed move must survive task one's rollback —
    // a whole-array-snapshot revert would stomp it back to "todo" here.
    expect(within(doneColumn).getByText("task two")).toBeDefined();
    expect(within(doingColumn).queryByText("task two")).toBeNull();
    expect(within(todoColumn).queryByText("task two")).toBeNull();
  });
});
