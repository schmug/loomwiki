// SPDX-License-Identifier: Apache-2.0

// @testing-library/jest-dom matchers are loaded by src/test/setup.ts.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WikiViewer } from "./WikiViewer";

afterEach(() => {
  cleanup();
});

const PAGE = {
  path: "/wiki/concepts/dmarc.md",
  frontmatter: {
    title: "DMARC",
    kind: "concept" as const,
    created: "2026-05-04",
    last_updated: "2026-05-04",
    status: "draft" as const,
  },
  body: "**DMARC** stands for Domain-based Message Authentication.",
  sha: "abc",
};

describe("WikiViewer", () => {
  it("renders the title, path, and sanitized markdown", () => {
    render(<WikiViewer page={PAGE} canEdit={false} />);
    // Title appears in the header h1.
    expect(screen.getByRole("heading", { level: 1, name: "DMARC" })).toBeInTheDocument();
    expect(screen.getByTestId("wiki-path")).toHaveTextContent("/wiki/concepts/dmarc.md");
    // Sanitizer turns **markdown** into <strong>.
    expect(document.querySelector(".md strong")).not.toBeNull();
  });

  it("strips a <script> tag from the rendered body", () => {
    const dangerous = {
      ...PAGE,
      body: "Hello <script>alert(1)</script> world",
    };
    render(<WikiViewer page={dangerous} canEdit={false} />);
    // No <script> in the document — sanitizer dropped it.
    expect(document.querySelector(".md script")).toBeNull();
    expect(document.body.textContent ?? "").toContain("Hello");
  });

  it("hides the Edit button when canEdit=false", () => {
    render(<WikiViewer page={PAGE} canEdit={false} />);
    expect(screen.queryByTestId("wiki-edit")).toBeNull();
  });

  it("shows the Edit button when canEdit=true", () => {
    render(<WikiViewer page={PAGE} canEdit />);
    expect(screen.getByTestId("wiki-edit")).toBeInTheDocument();
  });
});
