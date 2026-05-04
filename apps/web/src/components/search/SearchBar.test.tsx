// SPDX-License-Identifier: Apache-2.0

// jest-dom matchers loaded by src/test/setup.ts.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchBar } from "./SearchBar";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SearchBar", () => {
  it("debounces fetch and renders results", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        data: {
          results: [
            {
              path: "/wiki/concepts/dmarc.md",
              title: "DMARC",
              kind: "concept",
              snippet: "Hello <mark>DMARC</mark>",
              score: 0.9,
              source: "ai_search",
            },
          ],
          mode: "hybrid",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<SearchBar />);
    const input = screen.getByTestId("search-bar-input");
    fireEvent.change(input, { target: { value: "dmar" } });
    // Before the debounce expires the fetch hasn't fired.
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The title appears once as bold text + once inside the <mark> in the snippet.
    await waitFor(() => expect(screen.getAllByText("DMARC").length).toBeGreaterThan(0));
    expect(screen.getByTestId("search-result")).toBeInTheDocument();
  });

  it("⌘K focuses the input", () => {
    render(<SearchBar />);
    const input = screen.getByTestId("search-bar-input") as HTMLInputElement;
    // Sanity: not focused yet.
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(input);
  });

  it("Ctrl+K also focuses the input (cross-platform)", () => {
    render(<SearchBar />);
    const input = screen.getByTestId("search-bar-input") as HTMLInputElement;
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(input);
  });
});
