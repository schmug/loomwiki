// SPDX-License-Identifier: Apache-2.0

// M7 schema tests. These cover the runtime contract between the
// LLM-emitted JSON (parsed by Zod), the D1 row shapes (parsed in
// route layers), and the validators that gate proposals before
// persistence. Failures here indicate drift between the agent's
// system prompt and the surrounding code's enforcement.

import { describe, expect, it } from "vitest";
import {
  IngestAgentResponseSchema,
  IngestProposalSchema,
  IngestRunRowSchema,
  ProposalRowSchema,
  WIKI_BODY_MAX_BYTES,
} from "../index.js";

const VALID_UUID = "01970000-0000-7000-8000-000000000001";
const VALID_UUID_2 = "01970000-0000-7000-8000-000000000002";
const VALID_UUID_3 = "01970000-0000-7000-8000-000000000003";

const VALID_FRONTMATTER_BODY = `---
title: Example
kind: concept
created: 2026-05-04
last_updated: 2026-05-04
status: draft
---

# Example

Body.
`;

const VALID_PROPOSAL = {
  action: "create" as const,
  page_path: "/wiki/concepts/example.md",
  after_content: VALID_FRONTMATTER_BODY,
  rationale: "Two messages introduced this concept; deserves its own page.",
  sources: [{ room_id: VALID_UUID, message_id: VALID_UUID_2, excerpt: "lorem ipsum" }],
};

describe("IngestProposalSchema", () => {
  it("accepts a well-formed proposal", () => {
    const parsed = IngestProposalSchema.parse(VALID_PROPOSAL);
    expect(parsed.action).toBe("create");
    expect(parsed.page_path).toBe("/wiki/concepts/example.md");
  });

  it("rejects unknown actions", () => {
    const result = IngestProposalSchema.safeParse({
      ...VALID_PROPOSAL,
      action: "delete",
    });
    expect(result.success).toBe(false);
  });

  it("rejects uppercase / out-of-allowlist paths", () => {
    expect(
      IngestProposalSchema.safeParse({ ...VALID_PROPOSAL, page_path: "/wiki/Example.md" }).success,
    ).toBe(false);
    expect(
      IngestProposalSchema.safeParse({ ...VALID_PROPOSAL, page_path: "/AGENTS.md" }).success,
    ).toBe(false);
    expect(
      IngestProposalSchema.safeParse({ ...VALID_PROPOSAL, page_path: "/wiki/../etc.md" }).success,
    ).toBe(false);
  });

  it("rejects oversize after_content", () => {
    const oversize = "x".repeat(WIKI_BODY_MAX_BYTES + 1);
    const result = IngestProposalSchema.safeParse({
      ...VALID_PROPOSAL,
      after_content: oversize,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty after_content", () => {
    const result = IngestProposalSchema.safeParse({ ...VALID_PROPOSAL, after_content: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(
      IngestProposalSchema.safeParse({
        action: "create",
        page_path: "/wiki/x.md",
        // after_content missing
        rationale: "r",
        sources: [{ room_id: VALID_UUID, message_id: VALID_UUID_2 }],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty sources array", () => {
    const result = IngestProposalSchema.safeParse({ ...VALID_PROPOSAL, sources: [] });
    expect(result.success).toBe(false);
  });

  it("rejects extra top-level keys (strict)", () => {
    const result = IngestProposalSchema.safeParse({
      ...VALID_PROPOSAL,
      auto_merge: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra keys inside source entries (strict)", () => {
    const result = IngestProposalSchema.safeParse({
      ...VALID_PROPOSAL,
      sources: [
        {
          room_id: VALID_UUID,
          message_id: VALID_UUID_2,
          excerpt: "ok",
          confidence: 0.9, // not allowed
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects rationale > 1000 chars", () => {
    const result = IngestProposalSchema.safeParse({
      ...VALID_PROPOSAL,
      rationale: "x".repeat(1001),
    });
    expect(result.success).toBe(false);
  });
});

describe("IngestAgentResponseSchema", () => {
  it("accepts the empty-batch shape", () => {
    const parsed = IngestAgentResponseSchema.parse({
      summary: "No new messages.",
      proposals: [],
    });
    expect(parsed.proposals).toHaveLength(0);
  });

  it("rejects > 20 proposals", () => {
    const tooMany = Array.from({ length: 21 }, () => VALID_PROPOSAL);
    const result = IngestAgentResponseSchema.safeParse({
      summary: "lots",
      proposals: tooMany,
    });
    expect(result.success).toBe(false);
  });

  it("rejects summary > 280 chars", () => {
    const result = IngestAgentResponseSchema.safeParse({
      summary: "x".repeat(281),
      proposals: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra top-level keys (strict)", () => {
    const result = IngestAgentResponseSchema.safeParse({
      summary: "ok",
      proposals: [],
      free_form_thoughts: "ignore me",
    });
    expect(result.success).toBe(false);
  });
});

describe("IngestRunRowSchema", () => {
  const baseRow = {
    id: VALID_UUID,
    room_id: VALID_UUID_2,
    triggered_by: VALID_UUID_3,
    started_at: 1_700_000_000,
    finished_at: null,
    last_message_id: null,
    status: "running",
    summary: null,
    error: null,
  };

  it("accepts a running run with no bookmarks yet", () => {
    expect(IngestRunRowSchema.parse(baseRow).status).toBe("running");
  });

  it("accepts the cron-triggered shape", () => {
    expect(IngestRunRowSchema.parse({ ...baseRow, triggered_by: "cron" }).triggered_by).toBe(
      "cron",
    );
  });

  it("rejects unknown status values", () => {
    expect(IngestRunRowSchema.safeParse({ ...baseRow, status: "auto_merged" }).success).toBe(false);
  });
});

describe("ProposalRowSchema", () => {
  const baseRow = {
    id: VALID_UUID,
    run_id: VALID_UUID_2,
    page_path: "/wiki/concepts/example.md",
    action: "create",
    before_sha: null,
    after_content: VALID_FRONTMATTER_BODY,
    rationale: "rationale",
    status: "pending",
    created_at: 1_700_000_000,
    reviewed_at: null,
    reviewed_by: null,
    artifacts_commit: null,
  };

  it("accepts a pending row", () => {
    expect(ProposalRowSchema.parse(baseRow).status).toBe("pending");
  });

  it("rejects status='auto_merged' (defense-in-depth — never allowed)", () => {
    expect(ProposalRowSchema.safeParse({ ...baseRow, status: "auto_merged" }).success).toBe(false);
  });

  it("rejects an invalid wiki path on the row (defense-in-depth)", () => {
    expect(ProposalRowSchema.safeParse({ ...baseRow, page_path: "/AGENTS.md" }).success).toBe(
      false,
    );
  });
});
