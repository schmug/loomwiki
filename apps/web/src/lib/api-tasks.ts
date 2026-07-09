// SPDX-License-Identifier: Apache-2.0

// Typed client for /api/tasks (v0.1 M9). Payload shapes mirror the worker's
// route responses; types come from @loomwiki/schema so worker and web can't
// drift.

import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import type { CreateTaskRequest, PatchTaskRequest, Task, TaskStatus } from "@loomwiki/schema";

export interface TasksListPayload {
  tasks: Task[];
  hasMore: boolean;
}

export interface TaskPayload {
  task: Task;
}

export interface TaskFilters {
  status?: TaskStatus;
  room?: string;
  assignee?: string;
  tag?: string;
  before?: string;
  limit?: number;
}

export function buildTasksQuery(f: TaskFilters): string {
  const p = new URLSearchParams();
  if (f.status !== undefined) p.set("status", f.status);
  if (f.room !== undefined) p.set("room", f.room);
  if (f.assignee !== undefined) p.set("assignee", f.assignee);
  if (f.tag !== undefined) p.set("tag", f.tag);
  if (f.before !== undefined) p.set("before", f.before);
  if (f.limit !== undefined) p.set("limit", String(f.limit));
  const s = p.toString();
  return s.length > 0 ? `?${s}` : "";
}

export function listTasks(f: TaskFilters = {}): Promise<TasksListPayload> {
  return apiGet(`/api/tasks${buildTasksQuery(f)}`);
}

export function createTask(body: CreateTaskRequest): Promise<TaskPayload> {
  return apiPost("/api/tasks", body);
}

export function patchTask(taskId: string, body: PatchTaskRequest): Promise<TaskPayload> {
  return apiPatch(`/api/tasks/${taskId}`, body);
}

export function deleteTask(taskId: string): Promise<{ deleted: true }> {
  return apiDelete(`/api/tasks/${taskId}`);
}
