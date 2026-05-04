// SPDX-License-Identifier: Apache-2.0

// jest-dom matchers loaded by src/test/setup.ts.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WikiTree } from "./WikiTree";

afterEach(() => {
  cleanup();
});

describe("WikiTree", () => {
  it("renders a flat list when there are no folders", () => {
    render(<WikiTree initialPaths={["/wiki/_index.md", "/wiki/_open-questions.md"]} />);
    expect(screen.getByText("_index")).toBeInTheDocument();
    expect(screen.getByText("_open-questions")).toBeInTheDocument();
  });

  it("groups paths into folders and links files via /w/", () => {
    render(
      <WikiTree
        initialPaths={["/wiki/concepts/dmarc.md", "/wiki/concepts/spf.md", "/wiki/_index.md"]}
      />,
    );
    // Folder is collapsed by default; click to expand.
    const folder = screen.getByRole("button", { name: /concepts/i });
    expect(folder).toBeInTheDocument();
    fireEvent.click(folder);
    // File links point at /w/.
    const link = screen.getByRole("link", { name: /^dmarc$/i });
    expect(link).toHaveAttribute("href", "/w/concepts/dmarc");
  });

  it("auto-expands the current page's ancestors", () => {
    render(
      <WikiTree initialPaths={["/wiki/concepts/dmarc.md"]} currentPath="/wiki/concepts/dmarc.md" />,
    );
    const folder = screen.getByRole("button", { name: /concepts/i });
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: /^dmarc$/i })).toHaveAttribute("aria-current", "page");
  });

  it("renders the empty-state CTA when there are no pages", () => {
    render(<WikiTree initialPaths={[]} />);
    expect(screen.getByText(/no pages yet/i)).toBeInTheDocument();
  });
});
