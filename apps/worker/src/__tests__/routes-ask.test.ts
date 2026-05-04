// SPDX-License-Identifier: Apache-2.0

// Integration tests for POST /api/ask. Covers auth, validation, rate
// limiting, and the SSE response shape. Streaming behavior end-to-end
// (real LLM, real RAG) is covered by the rag-lib suite — here we mock
// askWithRag with a canned async-iterable so the route layer tests
// don't depend on Workers AI bindings.

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, resetDb } from "./__fixtures__/db.js";
import { type JwtFixture, makeJwtFixture } from "./__fixtures__/jwt.js";

// Build a small async iterable that yields the given chunks. This is
// the contract askWithRag returns for `result.stream`.
function asyncIterable(chunks: string[]): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<string>> {
          if (i >= chunks.length) return { value: undefined, done: true };
          const value = chunks[i++] ?? "";
          return { value, done: false };
        },
      };
    },
  };
}

vi.mock("../lib/rag.js", () => ({
  askWithRag: vi.fn(async () => ({
    searchResults: [],
    citations: [
      {
        path: "/wiki/concepts/dmarc.md",
        title: "DMARC",
        kind: "concept",
        heading_slug: null,
      },
    ],
    stream: asyncIterable(["Hello ", "world", ""]), // empty chunk filtered out
    meta: { mode: "hybrid", model: "@cf/test/echo" },
  })),
}));

let fixture: JwtFixture;

beforeAll(async () => {
  await applyMigrations();
  fixture = await makeJwtFixture();
});

beforeEach(async () => {
  await resetDb();
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

interface Err {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

async function authedFetch(jwt: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("CF-Access-Jwt-Assertion", jwt);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return SELF.fetch(`https://api.local${path}`, { ...init, headers });
}

interface ParsedSse {
  // Default-event `data:` payloads (we treat these as deltas).
  deltas: string[];
  // event:<name> blocks keyed by event name → JSON-parsed data.
  events: Map<string, unknown[]>;
}

// Minimal SSE parser. Splits on the blank-line frame separator; a
// frame may contain `event:` and one `data:` line per the M6 wire
// format. Production clients typically use EventSource which is not
// available in workerd-test, so we parse the raw stream by hand.
function parseSse(text: string): ParsedSse {
  const out: ParsedSse = { deltas: [], events: new Map() };
  for (const block of text.split(/\n\n/)) {
    if (block.trim() === "") continue;
    let event: string | null = null;
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (event === null) {
      const parsed = JSON.parse(data) as { delta?: string };
      if (typeof parsed.delta === "string") out.deltas.push(parsed.delta);
    } else {
      const list = out.events.get(event) ?? [];
      list.push(JSON.parse(data));
      out.events.set(event, list);
    }
  }
  return out;
}

describe("POST /api/ask — auth gating", () => {
  it("returns 401 without a JWT", async () => {
    const res = await SELF.fetch("https://api.local/api/ask", {
      method: "POST",
      body: JSON.stringify({ question: "hi" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/ask — validation", () => {
  it("returns 400 for an empty question", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await authedFetch(jwt, "/api/ask", {
      method: "POST",
      body: JSON.stringify({ question: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Err;
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 for a question over the 4000-char cap", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const tooLong = "a".repeat(4001);
    const res = await authedFetch(jwt, "/api/ask", {
      method: "POST",
      body: JSON.stringify({ question: tooLong }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a missing body", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await authedFetch(jwt, "/api/ask", { method: "POST" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/ask — SSE response", () => {
  it("streams text deltas, then a citations event, then done", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await authedFetch(jwt, "/api/ask", {
      method: "POST",
      body: JSON.stringify({ question: "What is DMARC?" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toMatch(/no-cache/);

    const text = await res.text();
    const parsed = parseSse(text);

    // Empty chunk should have been suppressed by the route.
    expect(parsed.deltas).toEqual(["Hello ", "world"]);

    // events.get("citations") is the list of `data:` payloads for that
    // event type — there's exactly one frame, and its payload is the
    // citations array.
    const citationsFrames = parsed.events.get("citations");
    expect(citationsFrames).toHaveLength(1);
    const citations = (citationsFrames ?? [[]])[0] as Array<{ path: string; title: string }>;
    expect(citations).toHaveLength(1);
    expect(citations[0]?.path).toBe("/wiki/concepts/dmarc.md");
    expect(citations[0]?.title).toBe("DMARC");

    expect(parsed.events.get("done")).toEqual([{}]);
  });
});

describe("POST /api/ask — cost guard", () => {
  it("returns 429 with details once the per-user ask cap is exhausted", async () => {
    const original = env.LLM_DAILY_LIMIT_PER_USER_ASK;
    (env as unknown as { LLM_DAILY_LIMIT_PER_USER_ASK: string }).LLM_DAILY_LIMIT_PER_USER_ASK = "1";
    try {
      const jwt = await fixture.mint({ email: "alice@example.com" });

      const first = await authedFetch(jwt, "/api/ask", {
        method: "POST",
        body: JSON.stringify({ question: "first" }),
      });
      expect(first.status).toBe(200);
      // Drain the body so the underlying stream completes before the
      // next request — keeps the test deterministic.
      await first.text();

      const second = await authedFetch(jwt, "/api/ask", {
        method: "POST",
        body: JSON.stringify({ question: "second" }),
      });
      expect(second.status).toBe(429);
      const body = (await second.json()) as Err;
      expect(body.error.code).toBe("RATE_LIMITED");
      const details = body.error.details as {
        limit: number;
        used: number;
        scope: string;
        reset_at: string;
      };
      expect(details.limit).toBe(1);
      expect(details.used).toBe(1);
      expect(details.scope).toBe("user");
    } finally {
      (env as unknown as { LLM_DAILY_LIMIT_PER_USER_ASK: string }).LLM_DAILY_LIMIT_PER_USER_ASK =
        original;
    }
  });
});
