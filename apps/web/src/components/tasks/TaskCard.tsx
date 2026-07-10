// SPDX-License-Identifier: Apache-2.0

import { utcDateIso } from "@/lib/calendar-dates";
import type { Task } from "@loomwiki/schema";

export interface TaskCardProps {
  task: Task;
  assigneeName: string | null;
}

export function TaskCard({ task, assigneeName }: TaskCardProps) {
  return (
    <article
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/task-id", task.id)}
      className="cursor-grab rounded-md border border-border bg-background p-2 shadow-sm"
    >
      <p className="text-sm">{task.title}</p>
      <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
        {assigneeName !== null && <span>{assigneeName}</span>}
        {task.due_at !== null && <span>due {utcDateIso(task.due_at)}</span>}
        {task.tags.map((tag) => (
          <span key={tag} className="rounded bg-muted px-1">
            #{tag}
          </span>
        ))}
      </div>
    </article>
  );
}
