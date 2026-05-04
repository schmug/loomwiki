// SPDX-License-Identifier: Apache-2.0

// jest-dom matchers loaded by src/test/setup.ts.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CitationPill } from "./CitationPill";

describe("CitationPill", () => {
  it("renders a link to /w/<slug> when no heading_slug is set", () => {
    render(
      <CitationPill
        citation={{
          path: "/wiki/concepts/dmarc.md",
          title: "DMARC",
          kind: "concept",
          heading_slug: null,
        }}
      />,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/w/concepts/dmarc");
    expect(link).toHaveTextContent("DMARC");
    expect(link).toHaveTextContent("concept");
  });

  it("appends #<heading_slug> when set", () => {
    render(
      <CitationPill
        citation={{
          path: "/wiki/concepts/dmarc.md",
          title: "DMARC",
          kind: "concept",
          heading_slug: "alignment",
        }}
      />,
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "/w/concepts/dmarc#alignment");
  });

  it("strips the leading /wiki/ and trailing .md from the path", () => {
    render(
      <CitationPill
        citation={{
          path: "/wiki/_index.md",
          title: "Home",
          kind: "concept",
          heading_slug: null,
        }}
      />,
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "/w/_index");
  });
});
