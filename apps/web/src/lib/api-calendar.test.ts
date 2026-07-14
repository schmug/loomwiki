// SPDX-License-Identifier: Apache-2.0

// Wire-shape tests for the M9 calendar/events API helpers. Pinning the
// request URLs + methods prevents drift from the worker route
// registration.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelEvent, getCalendar } from "./api-calendar";

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

describe("api-calendar", () => {
  it("getCalendar GETs the range with optional filters", async () => {
    const fetchMock = mockFetch(200, { ok: true, data: { entries: [], from: 1, to: 2 } });
    await getCalendar(1, 2, { room: "r1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/calendar?from=1&to=2&room=r1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("cancelEvent DELETEs the event", async () => {
    const fetchMock = mockFetch(200, { ok: true, data: { event: { id: "e1" } } });
    await cancelEvent("e1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/events/e1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
