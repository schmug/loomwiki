// SPDX-License-Identifier: Apache-2.0

// Pins the SSE consumer's parser:
//   - data: {"text": "..."} chunks → onDelta
//   - event: citations + data: [...] → onCitations
//   - event: done → onDone
//   - 4xx with JSON body → onError(ApiError) with `.details` preserved
//   - reads frames in chunks, including a frame split across two
//     network reads (the buffer carry-over branch).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, AuthRequiredError } from "./api";
import { askStream } from "./api-ask";

function sse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build an SSE Response whose body delivers each chunk as a separate
 * read — that exercises the carry-over buffer in api-ask.
 */
function chunkedSse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function flush(): Promise<void> {
  // Multiple ticks: each await reader.read() resolves on a tick, so we
  // need a few of them to fully drain a streamed response.
  for (let i = 0; i < 10; i++) await nextTick();
}

describe("askStream", () => {
  it("dispatches delta + citations + done in order", async () => {
    const body = `data: ${JSON.stringify({ text: "Hello " })}\n\ndata: ${JSON.stringify({ text: "world." })}\n\nevent: citations\ndata: ${JSON.stringify(
      [{ path: "/wiki/concepts/dmarc.md", title: "DMARC", kind: "concept", heading_slug: null }],
    )}\n\nevent: done\ndata: {}\n\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sse(body)),
    );

    const deltas: string[] = [];
    let cites: unknown = null;
    let done = false;
    let err: unknown = null;
    askStream("hi", {
      onDelta: (t) => deltas.push(t),
      onCitations: (c) => {
        cites = c;
      },
      onDone: () => {
        done = true;
      },
      onError: (e) => {
        err = e;
      },
    });
    await flush();
    expect(err).toBeNull();
    expect(deltas).toEqual(["Hello ", "world."]);
    expect(cites).toEqual([
      { path: "/wiki/concepts/dmarc.md", title: "DMARC", kind: "concept", heading_slug: null },
    ]);
    expect(done).toBe(true);
  });

  it("handles a frame split across two network reads", async () => {
    // Split mid-frame: first chunk has `data: {"te` and the rest comes
    // in the second chunk. The buffer carry-over should reassemble.
    const c1 = `data: {"te`;
    const c2 = `xt": "ok"}\n\nevent: done\ndata: {}\n\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => chunkedSse([c1, c2])),
    );

    const deltas: string[] = [];
    let done = false;
    askStream("q", {
      onDelta: (t) => deltas.push(t),
      onCitations: () => undefined,
      onDone: () => {
        done = true;
      },
      onError: () => undefined,
    });
    await flush();
    expect(deltas).toEqual(["ok"]);
    expect(done).toBe(true);
  });

  it("surfaces a 4xx JSON body as ApiError to onError, preserving details", async () => {
    const details = {
      limit: 50,
      used: 50,
      scope: "user",
      reset_at: "2026-05-05T00:00:00Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(429, {
          ok: false,
          error: { code: "RATE_LIMITED", message: "rate limited", details },
        }),
      ),
    );
    let captured: unknown = null;
    askStream("q", {
      onDelta: () => undefined,
      onCitations: () => undefined,
      onDone: () => undefined,
      onError: (e) => {
        captured = e;
      },
    });
    await flush();
    expect(captured).toBeInstanceOf(ApiError);
    expect((captured as ApiError).code).toBe("RATE_LIMITED");
    expect((captured as ApiError).status).toBe(429);
    expect((captured as ApiError).details).toEqual(details);
  });

  it("surfaces a 401 as AuthRequiredError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(401, {
          ok: false,
          error: { code: "AUTH_REQUIRED", message: "x" },
        }),
      ),
    );
    let captured: unknown = null;
    askStream("q", {
      onDelta: () => undefined,
      onCitations: () => undefined,
      onDone: () => undefined,
      onError: (e) => {
        captured = e;
      },
    });
    await flush();
    expect(captured).toBeInstanceOf(AuthRequiredError);
  });

  it("ignores SSE comment lines", async () => {
    const body = `: keepalive\n\ndata: ${JSON.stringify({ text: "x" })}\n\nevent: done\ndata: {}\n\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sse(body)),
    );
    const deltas: string[] = [];
    askStream("q", {
      onDelta: (t) => deltas.push(t),
      onCitations: () => undefined,
      onDone: () => undefined,
      onError: () => undefined,
    });
    await flush();
    expect(deltas).toEqual(["x"]);
  });
});
