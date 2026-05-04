// SPDX-License-Identifier: Apache-2.0

import type { WikiSearchResult } from "@/lib/types";
// jest-dom matchers loaded by src/test/setup.ts.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchResults } from "./SearchResults";

const RESULT: WikiSearchResult = {
  path: "/wiki/concepts/dmarc.md",
  title: "DMARC",
  kind: "concept",
  snippet: "Hello <mark>DMARC</mark> world",
  score: 0.9,
  source: "ai_search",
};

describe("SearchResults", () => {
  it("renders the title, path, and converts <mark> to a real <mark> element", () => {
    render(<SearchResults results={[RESULT]} mode="hybrid" onSelect={() => undefined} />);
    // Title appears once (as bold text) AND once inside the <mark> snippet.
    // Use queryAllByText since the title literal appears twice.
    expect(screen.getAllByText("DMARC").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("/wiki/concepts/dmarc.md")).toBeInTheDocument();
    // The mark wraps just the matched term, not arbitrary HTML.
    const marks = document.querySelectorAll("mark");
    expect(marks.length).toBe(1);
    expect(marks[0]?.textContent).toBe("DMARC");
  });

  it("calls onSelect with the path on click", () => {
    const onSelect = vi.fn();
    render(<SearchResults results={[RESULT]} mode="hybrid" onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("search-result"));
    expect(onSelect).toHaveBeenCalledWith("/wiki/concepts/dmarc.md");
  });

  it("calls onSelect on Enter key", () => {
    const onSelect = vi.fn();
    render(<SearchResults results={[RESULT]} mode="hybrid" onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByTestId("search-result"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("/wiki/concepts/dmarc.md");
  });

  it("shows a fallback notice when mode = fts5_fallback (with results)", () => {
    render(<SearchResults results={[RESULT]} mode="fts5_fallback" onSelect={() => undefined} />);
    expect(
      screen.getByText(/keyword matches only — semantic search is unavailable/i),
    ).toBeInTheDocument();
  });

  it("renders the empty state for mode = hybrid", () => {
    render(<SearchResults results={[]} mode="hybrid" onSelect={() => undefined} />);
    expect(screen.getByTestId("search-empty")).toHaveTextContent("No matches.");
    expect(screen.queryByText(/keyword matches only/i)).toBeNull();
  });

  it("renders the empty state with the fallback notice for fts5_fallback", () => {
    render(<SearchResults results={[]} mode="fts5_fallback" onSelect={() => undefined} />);
    expect(screen.getByTestId("search-empty")).toHaveTextContent(
      /keyword matches only — semantic search is unavailable/i,
    );
  });

  it("never injects a script tag from the snippet", () => {
    const malicious = { ...RESULT, snippet: "ok <script>alert(1)</script> more" };
    render(<SearchResults results={[malicious]} mode="hybrid" onSelect={() => undefined} />);
    // The snippet renderer only honors <mark>; everything else is text.
    expect(document.querySelector("script")).toBeNull();
    expect(document.body.textContent ?? "").toContain("ok <script>alert(1)</script> more");
  });
});
