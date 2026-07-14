// SPDX-License-Identifier: Apache-2.0

// Kanban board (v0.1 M9). The board is a client-side grouping of tasks by
// the fixed status enum — dragging a card between columns is a PATCH with
// optimistic update + rollback. No board entity, no manual in-column
// ordering (SPEC Q26): columns sort by due date, then created.

import { createTask, patchTask } from "@/lib/api-tasks";
import {
  type MemberSummary,
  TASK_BOARD_STATUSES,
  type Task,
  type TaskStatus,
} from "@loomwiki/schema";
import { useMemo, useState } from "react";
import { TaskCard } from "./TaskCard";

export interface KanbanBoardProps {
  initialTasks: Task[];
  members: MemberSummary[];
  rooms: Array<{ id: string; slug: string }>;
  currentUserId: string;
}

const COLUMN_LABELS: Record<(typeof TASK_BOARD_STATUSES)[number], string> = {
  backlog: "Backlog",
  todo: "To do",
  doing: "Doing",
  done: "Done",
};

export function KanbanBoard({ initialTasks, members, rooms, currentUserId }: KanbanBoardProps) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [roomFilter, setRoomFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.status !== "cancelled" &&
          (roomFilter === "" || t.room_id === roomFilter) &&
          (assigneeFilter === "" || t.assignee_id === assigneeFilter),
      ),
    [tasks, roomFilter, assigneeFilter],
  );

  const memberName = (uid: string | null): string | null =>
    uid === null ? null : (members.find((m) => m.id === uid)?.display_name ?? null);

  async function moveTask(taskId: string, status: TaskStatus): Promise<void> {
    // Per-task, race-safe optimistic update: functional setState so two
    // concurrent drags compose over the latest state instead of one
    // clobbering the other via a snapshot of the whole array (see review).
    const prevStatus = tasks.find((t) => t.id === taskId)?.status;
    if (prevStatus === undefined) return;
    setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, status } : t)));
    try {
      const { task } = await patchTask(taskId, { status });
      setTasks((ts) => ts.map((t) => (t.id === taskId ? task : t)));
      setError(null);
    } catch (err) {
      setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, status: prevStatus } : t)));
      setError(err instanceof Error ? err.message : "failed to move task");
    }
  }

  async function addTask(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const title = newTitle.trim();
    if (title.length === 0) return;
    setNewTitle("");
    try {
      const { task } = await createTask({ title });
      setTasks((ts) => [...ts, task]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create task");
    }
  }

  function columnTasks(status: TaskStatus): Task[] {
    return visible
      .filter((t) => t.status === status)
      .sort(
        (a, b) =>
          (a.due_at ?? Number.MAX_SAFE_INTEGER) - (b.due_at ?? Number.MAX_SAFE_INTEGER) ||
          a.created_at - b.created_at,
      );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={addTask} className="flex gap-2">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="New task title…"
            aria-label="New task title"
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          />
          <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm">
            Add
          </button>
        </form>
        <select
          value={roomFilter}
          onChange={(e) => setRoomFilter(e.target.value)}
          aria-label="Filter by room"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">All rooms</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              #{r.slug}
            </option>
          ))}
        </select>
        <select
          value={assigneeFilter}
          onChange={(e) => setAssigneeFilter(e.target.value)}
          aria-label="Filter by assignee"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Everyone</option>
          <option value={currentUserId}>My tasks</option>
          {members
            .filter((m) => m.id !== currentUserId)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name}
              </option>
            ))}
        </select>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        {TASK_BOARD_STATUSES.map((status) => (
          <section
            key={status}
            aria-label={COLUMN_LABELS[status]}
            className="rounded-lg border border-border bg-muted/30 p-2"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const taskId = e.dataTransfer.getData("text/task-id");
              if (taskId !== "") void moveTask(taskId, status);
            }}
          >
            <h2 className="mb-2 px-1 text-sm font-semibold">
              {COLUMN_LABELS[status]}{" "}
              <span className="font-normal text-muted-foreground">
                {columnTasks(status).length}
              </span>
            </h2>
            <div className="flex min-h-8 flex-col gap-2">
              {columnTasks(status).map((t) => (
                <TaskCard key={t.id} task={t} assigneeName={memberName(t.assignee_id)} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
