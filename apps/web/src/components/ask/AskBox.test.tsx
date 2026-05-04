// SPDX-License-Identifier: Apache-2.0

// AskBox integration test. Mocks the global fetch with an SSE response
// (or a 429 JSON body) so we exercise the same askStream parsing the
// component depends on at runtime — no helper indirection.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskBox } from "./AskBox";

function sseStream(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await nextTick();
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AskBox", () => {
  it("streams the answer and renders citations after onCitations", async () => {
    const body = `data: ${JSON.stringify({ text: "Hello " })}\n\ndata: ${JSON.stringify({ text: "world." })}\n\nevent: citations\ndata: ${JSON.stringify(
      [{ path: "/wiki/concepts/dmarc.md", title: "DMARC", kind: "concept", heading_slug: null }],
    )}\n\nevent: done\ndata: {}\n\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseStream(body)),
    );

    render(<AskBox />);
    fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "what is dmarc?" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ask-submit"));
      await flush();
    });

    await waitFor(() => {
      const ans = screen.getByTestId("ask-answer");
      expect(ans.textContent ?? "").toContain("Hello world.");
    });
    await waitFor(() => {
      expect(screen.getByTestId("ask-citations")).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: /DMARC/ })).toHaveAttribute(
      "href",
      "/w/concepts/dmarc",
    );
    // After done, the submit button is back.
    await waitFor(() => expect(screen.queryByTestId("ask-stop")).toBeNull());
  });

  it("renders the RateLimitBanner on a 429 RATE_LIMITED with details", async () => {
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

    render(<AskBox />);
    fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "anything" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ask-submit"));
      await flush();
    });

    await waitFor(() => {
      expect(screen.getByTestId("rate-limit-banner")).toBeInTheDocument();
    });
    expect(screen.getByTestId("rate-limit-banner")).toHaveTextContent(/daily limit of 50/);
  });

  it("disables submit while streaming and exposes a Stop button", async () => {
    // Use a stream whose body never closes (until we abort). Hold the
    // controller so we can keep the stream open across assertions.
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ text: "..." })}\n\n`),
        );
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      ),
    );

    render(<AskBox />);
    fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "long question" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ask-submit"));
      await flush();
    });

    await waitFor(() => expect(screen.getByTestId("ask-stop")).toBeInTheDocument());
    expect(screen.queryByTestId("ask-submit")).toBeNull();

    // Cleanup: close the stream so the test can end.
    // Cast: TS doesn't see the assignment that happens inside the `start`
    // callback, so the inferred narrowed type is `null`. The runtime value
    // is the controller.
    (streamController as ReadableStreamDefaultController<Uint8Array> | null)?.close();
  });
});
