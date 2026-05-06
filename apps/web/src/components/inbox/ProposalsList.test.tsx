// SPDX-License-Identifier: Apache-2.0

// jest-dom matchers loaded by src/test/setup.ts.
import type { SerializedProposal } from "@/lib/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProposalsList } from "./ProposalsList";

afterEach(() => cleanup());

const SAMPLE: SerializedProposal = {
  id: "01970000-0000-7000-8000-000000000001",
  run_id: "01970000-0000-7000-8000-000000000010",
  page_path: "/wiki/decisions/2026-05-dmarc.md",
  action: "create",
  before_sha: null,
  after_content:
    "---\ntitle: x\nkind: decision\ncreated: 2026-05-04\nlast_updated: 2026-05-04\nstatus: draft\n---\n\nbody",
  rationale: "Two messages discussed this decision",
  status: "pending",
  created_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  reviewed_at: null,
  reviewed_by: null,
  artifacts_commit: null,
};

describe("ProposalsList", () => {
  it("renders the empty state when no proposals", () => {
    render(<ProposalsList proposals={[]} />);
    expect(screen.getByText(/Inbox is empty/i)).toBeInTheDocument();
  });

  it("renders a row per proposal with a link to the detail page", () => {
    render(<ProposalsList proposals={[SAMPLE]} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", `/inbox/proposals/${SAMPLE.id}`);
    expect(link).toHaveTextContent("Create");
    expect(link).toHaveTextContent(SAMPLE.page_path);
    expect(link).toHaveTextContent("Two messages discussed");
  });

  it("renders update + create variants distinctly", () => {
    const updateSample: SerializedProposal = {
      ...SAMPLE,
      id: "01970000-0000-7000-8000-000000000002",
      action: "update",
    };
    render(<ProposalsList proposals={[SAMPLE, updateSample]} />);
    expect(screen.getByText(/Create/i)).toBeInTheDocument();
    expect(screen.getByText(/Update/i)).toBeInTheDocument();
  });
});
