// SPDX-License-Identifier: Apache-2.0

// Pins the wire shape for /api/search and the 429 RATE_LIMITED contract
// the RateLimitBanner reads from.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { searchWiki } from "./api-search";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => response);
  vi.stubGlobal("fetch", f);
  return f;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchWiki", () => {
  it("POSTs the query + topK and unwraps the response", async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, {
        ok: true,
        data: {
          results: [
            {
              path: "/wiki/concepts/dmarc.md",
              title: "DMARC",
              kind: "concept",
              snippet: "Hello <mark>DMARC</mark>",
              score: 0.91,
              source: "ai_search",
            },
          ],
          mode: "hybrid",
        },
      }),
    );
    const out = await searchWiki("dmarc");
    expect(out.mode).toBe("hybrid");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.path).toBe("/wiki/concepts/dmarc.md");

    const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
    expect(call?.[0]).toBe("/api/search");
    expect(call?.[1]?.method).toBe("POST");
    expect(call?.[1]?.body).toBe(JSON.stringify({ query: "dmarc", topK: 10 }));
  });

  it("forwards an explicit topK", async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, { ok: true, data: { results: [], mode: "hybrid" } }),
    );
    await searchWiki("x", 25);
    const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
    expect(call?.[1]?.body).toBe(JSON.stringify({ query: "x", topK: 25 }));
  });

  it("surfaces RATE_LIMITED with `details` so the banner can render it", async () => {
    const details = {
      limit: 50,
      used: 50,
      scope: "user",
      reset_at: "2026-05-05T00:00:00Z",
    };
    mockFetch(
      jsonResponse(429, {
        ok: false,
        error: { code: "RATE_LIMITED", message: "rate limited", details },
      }),
    );
    try {
      await searchWiki("x");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("RATE_LIMITED");
      expect((err as ApiError).status).toBe(429);
      expect((err as ApiError).details).toEqual(details);
    }
  });

  it("propagates fts5_fallback mode unchanged", async () => {
    mockFetch(
      jsonResponse(200, {
        ok: true,
        data: { results: [], mode: "fts5_fallback" },
      }),
    );
    const out = await searchWiki("x");
    expect(out.mode).toBe("fts5_fallback");
  });
});
