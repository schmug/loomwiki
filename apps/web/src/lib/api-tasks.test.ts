// SPDX-License-Identifier: Apache-2.0

// Wire-shape tests for the M9 tasks API helpers. Pinning the request
// URLs + methods prevents drift from the worker route registration.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTasksQuery, createTask, listTasks, patchTask } from "./api-tasks";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  // Builds a fresh Response per invocation (bodies are single-use streams),
  // so a single stub can back multiple calls in the same test.
  const f = vi.fn(async () => jsonResponse(status, body));
  vi.stubGlobal("fetch", f);
  return f;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildTasksQuery", () => {
  it("serializes only the provided filters", () => {
    expect(buildTasksQuery({})).toBe("");
    expect(buildTasksQuery({ status: "done", tag: "bug", limit: 200 })).toBe(
      "?status=done&tag=bug&limit=200",
    );
  });
});

describe("api-tasks", () => {
  it("listTasks GETs /api/tasks with filters", async () => {
    const fetchMock = mockFetch(200, { ok: true, data: { tasks: [], hasMore: false } });
    await listTasks({ status: "doing" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks?status=doing",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("createTask POSTs and patchTask PATCHes", async () => {
    const fetchMock = mockFetch(200, { ok: true, data: { task: { id: "x" } } });
    await createTask({ title: "t" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks",
      expect.objectContaining({ method: "POST" }),
    );
    await patchTask("abc", { status: "done" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/abc",
      expect.objectContaining({ method: "PATCH" }),
    );
  });
});
