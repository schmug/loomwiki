// SPDX-License-Identifier: Apache-2.0

// jest-dom matchers loaded by src/test/setup.ts.
import type { SerializedProposal, WikiPagePayload } from "@/lib/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalDetail } from "./ProposalDetail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CREATE_PROPOSAL: SerializedProposal = {
  id: "01970000-0000-7000-8000-000000000001",
  run_id: "01970000-0000-7000-8000-000000000010",
  page_path: "/wiki/decisions/dmarc.md",
  action: "create",
  before_sha: null,
  after_content: `---
title: DMARC
kind: decision
created: 2026-05-04
last_updated: 2026-05-04
status: draft
---

# DMARC

Body.
`,
  rationale: "rationale text",
  status: "pending",
  created_at: new Date().toISOString(),
  reviewed_at: null,
  reviewed_by: null,
  artifacts_commit: null,
};

const UPDATE_PROPOSAL: SerializedProposal = {
  ...CREATE_PROPOSAL,
  id: "01970000-0000-7000-8000-000000000002",
  page_path: "/wiki/concepts/spf.md",
  action: "update",
  before_sha: "deadbeef",
};

const CURRENT_PAGE: WikiPagePayload = {
  path: "/wiki/concepts/spf.md",
  frontmatter: {
    title: "SPF",
    kind: "concept",
    created: "2026-04-01",
    last_updated: "2026-04-01",
    status: "published",
  },
  body: "Existing SPF body",
  sha: "deadbeef",
};

describe("ProposalDetail (create)", () => {
  it("renders only the proposed pane (no current pane for create)", () => {
    render(<ProposalDetail proposal={CREATE_PROPOSAL} currentPage={null} />);
    expect(screen.getByText(/Proposed/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Current$/i)).toBeNull();
    expect(screen.getByText(CREATE_PROPOSAL.page_path)).toBeInTheDocument();
  });

  it("merge happy path posts and shows the success banner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          ok: true,
          data: { merged: true, page_path: CREATE_PROPOSAL.page_path, sha: "abc" },
        }),
      ),
    );
    render(<ProposalDetail proposal={CREATE_PROPOSAL} currentPage={null} />);
    fireEvent.click(screen.getByRole("button", { name: /^Merge$/i }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/now live/i);
    });
  });

  it("merge 409 surfaces the conflict banner pointing to the wiki editor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(409, {
          ok: false,
          error: {
            code: "CONFLICT",
            message: "Wiki page changed",
            details: {
              path: CREATE_PROPOSAL.page_path,
              current_sha: "x",
              current_raw: "x",
              base_sha: "x",
              base_raw: "x",
              attempted_frontmatter: {},
              attempted_body: "",
            },
          },
        }),
      ),
    );
    render(<ProposalDetail proposal={CREATE_PROPOSAL} currentPage={null} />);
    fireEvent.click(screen.getByRole("button", { name: /^Merge$/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/wiki page changed/i);
    });
  });

  it("reject happy path posts and shows the rejected banner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          ok: true,
          data: { rejected: true, proposal_id: CREATE_PROPOSAL.id },
        }),
      ),
    );
    render(<ProposalDetail proposal={CREATE_PROPOSAL} currentPage={null} />);
    fireEvent.click(screen.getByRole("button", { name: /^Reject$/i }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/rejected/i);
    });
  });
});

describe("ProposalDetail (update)", () => {
  it("renders both Current and Proposed panes", () => {
    render(<ProposalDetail proposal={UPDATE_PROPOSAL} currentPage={CURRENT_PAGE} />);
    expect(screen.getByText(/^Current$/i)).toBeInTheDocument();
    expect(screen.getByText(/Proposed/i)).toBeInTheDocument();
    // Current page body should be visible.
    expect(screen.getByText(/Existing SPF body/)).toBeInTheDocument();
  });

  it("merge sends the current page's sha as before_sha", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        data: { merged: true, page_path: UPDATE_PROPOSAL.page_path, sha: "newsha" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ProposalDetail proposal={UPDATE_PROPOSAL} currentPage={CURRENT_PAGE} />);
    fireEvent.click(screen.getByRole("button", { name: /^Merge$/i }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
      const init = calls[0]?.[1];
      expect(init?.body).toBe(JSON.stringify({ before_sha: "deadbeef" }));
    });
  });
});
