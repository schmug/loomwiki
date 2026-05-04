// SPDX-License-Identifier: Apache-2.0

import type { WikiConflictDetails } from "@/lib/types";
// jest-dom matchers loaded by src/test/setup.ts.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MergeDialog } from "./MergeDialog";

afterEach(() => {
  cleanup();
});

const DETAILS: WikiConflictDetails = {
  path: "/wiki/concepts/dmarc.md",
  current_sha: "newer",
  current_raw: "INCOMING",
  base_sha: "newer",
  base_raw: "BASE",
  attempted_frontmatter: {
    title: "DMARC",
    kind: "concept",
    created: "2026-05-04",
    last_updated: "2026-05-04",
    status: "draft",
  },
  attempted_body: "LOCAL",
};

describe("MergeDialog", () => {
  it("renders incoming, local, and base panes when open", () => {
    render(<MergeDialog details={DETAILS} onResolve={async () => {}} onClose={() => {}} />);
    expect(screen.getByText(/Resolve conflict/i)).toBeInTheDocument();
    expect(document.body.textContent).toContain("INCOMING");
    // Local pane is initialized as YAML-fenced; the LOCAL body text
    // appears alongside the YAML frontmatter.
    const local = screen.getByTestId("merge-local") as HTMLTextAreaElement;
    expect(local.value).toContain("LOCAL");
    expect(local.value).toMatch(/^---\n/); // YAML fence at the start
    expect(local.value).toContain("title:");
    // Base text is in a <details><pre>; pre's textContent includes it.
    expect(document.querySelector("pre")?.textContent).toBe("BASE");
  });

  it('"Use this" copies the incoming pane into the local pane verbatim', () => {
    const onResolve = vi.fn<(merged: string, sha: string) => Promise<void>>(async () => {});
    render(<MergeDialog details={DETAILS} onResolve={onResolve} onClose={() => {}} />);
    // The "Use this" button on the incoming pane.
    fireEvent.click(screen.getByRole("button", { name: /use this/i }));
    fireEvent.click(screen.getByRole("button", { name: /save resolution/i }));
    expect(onResolve).toHaveBeenCalledWith("INCOMING", "newer");
  });

  it("calls onResolve with the local pane and current_sha on save", async () => {
    const onResolve = vi.fn<(merged: string, sha: string) => Promise<void>>(async () => {});
    render(<MergeDialog details={DETAILS} onResolve={onResolve} onClose={() => {}} />);
    const localTextarea = screen.getByTestId("merge-local") as HTMLTextAreaElement;
    fireEvent.change(localTextarea, { target: { value: "MERGED" } });
    fireEvent.click(screen.getByRole("button", { name: /save resolution/i }));
    expect(onResolve).toHaveBeenCalled();
    expect(onResolve).toHaveBeenCalledWith("MERGED", "newer");
  });

  it("does not render when details is null", () => {
    render(<MergeDialog details={null} onResolve={async () => {}} onClose={() => {}} />);
    expect(screen.queryByText(/resolve conflict/i)).toBeNull();
  });
});
