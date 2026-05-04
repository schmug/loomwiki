// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  AskRequestSchema,
  LlmUsageRowSchema,
  LlmUsageScopeIdSchema,
  WikiSearchRequestSchema,
  WikiSearchResponseSchema,
  WikiSearchResultSchema,
} from "../index.js";

const VALID_UUID = "01890000-0000-7000-8000-000000000001";
const VALID_WORKSPACE = "00000000-0000-7000-8000-000000000000";

describe("LlmUsageRowSchema", () => {
  it("accepts a per-user row", () => {
    expect(
      LlmUsageRowSchema.parse({
        workspace_id: VALID_WORKSPACE,
        day: "2026-05-04",
        scope_type: "user",
        scope_id: VALID_UUID,
        ask_count: 5,
        search_count: 22,
        updated_at: 1_730_000_000,
      }),
    ).toBeTruthy();
  });

  it("accepts the workspace sentinel", () => {
    expect(
      LlmUsageRowSchema.parse({
        workspace_id: VALID_WORKSPACE,
        day: "2026-05-04",
        scope_type: "workspace",
        scope_id: "_workspace",
        ask_count: 0,
        search_count: 0,
        updated_at: 1_730_000_000,
      }),
    ).toBeTruthy();
  });

  it("rejects negative counters", () => {
    expect(
      LlmUsageRowSchema.safeParse({
        workspace_id: VALID_WORKSPACE,
        day: "2026-05-04",
        scope_type: "user",
        scope_id: VALID_UUID,
        ask_count: -1,
        search_count: 0,
        updated_at: 1_730_000_000,
      }).success,
    ).toBe(false);
  });

  it("rejects non-ISO day strings", () => {
    expect(
      LlmUsageRowSchema.safeParse({
        workspace_id: VALID_WORKSPACE,
        day: "2026-5-4",
        scope_type: "user",
        scope_id: VALID_UUID,
        ask_count: 0,
        search_count: 0,
        updated_at: 1_730_000_000,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown scope_type", () => {
    expect(
      LlmUsageRowSchema.safeParse({
        workspace_id: VALID_WORKSPACE,
        day: "2026-05-04",
        scope_type: "global",
        scope_id: "_workspace",
        ask_count: 0,
        search_count: 0,
        updated_at: 1_730_000_000,
      }).success,
    ).toBe(false);
  });
});

describe("LlmUsageScopeIdSchema", () => {
  it("accepts UUIDv7 and the workspace sentinel; rejects anything else", () => {
    expect(LlmUsageScopeIdSchema.safeParse(VALID_UUID).success).toBe(true);
    expect(LlmUsageScopeIdSchema.safeParse("_workspace").success).toBe(true);
    expect(LlmUsageScopeIdSchema.safeParse("hello").success).toBe(false);
    expect(LlmUsageScopeIdSchema.safeParse("01890000-0000-4000-8000-000000000001").success).toBe(
      false,
    );
  });
});

describe("WikiSearchResultSchema", () => {
  it("accepts a hybrid result", () => {
    expect(
      WikiSearchResultSchema.parse({
        path: "/wiki/concepts/dmarc.md",
        title: "DMARC",
        kind: "concept",
        snippet: "DMARC stands for…",
        score: 0.92,
        source: "ai_search",
      }),
    ).toBeTruthy();
  });

  it("rejects a non-wiki path", () => {
    expect(
      WikiSearchResultSchema.safeParse({
        path: "/etc/passwd",
        title: "x",
        kind: "concept",
        snippet: "",
        score: 1,
        source: "ai_search",
      }).success,
    ).toBe(false);
  });

  it("rejects the wiki uppercase path", () => {
    expect(
      WikiSearchResultSchema.safeParse({
        path: "/wiki/Concepts/dmarc.md",
        title: "x",
        kind: "concept",
        snippet: "",
        score: 1,
        source: "ai_search",
      }).success,
    ).toBe(false);
  });
});

describe("WikiSearchResponseSchema", () => {
  it("accepts an empty hybrid response", () => {
    expect(
      WikiSearchResponseSchema.parse({ results: [], mode: "hybrid" }),
    ).toEqual({ results: [], mode: "hybrid" });
  });

  it("accepts the fts5 fallback mode", () => {
    expect(
      WikiSearchResponseSchema.parse({ results: [], mode: "fts5_fallback" }),
    ).toEqual({ results: [], mode: "fts5_fallback" });
  });

  it("rejects an unknown mode", () => {
    expect(
      WikiSearchResponseSchema.safeParse({ results: [], mode: "bm25" }).success,
    ).toBe(false);
  });
});

describe("WikiSearchRequestSchema", () => {
  it("accepts an empty query (the orchestrator returns [])", () => {
    expect(WikiSearchRequestSchema.parse({ query: "" })).toEqual({ query: "" });
  });

  it("rejects topK outside [1, 50]", () => {
    expect(WikiSearchRequestSchema.safeParse({ query: "x", topK: 0 }).success).toBe(false);
    expect(WikiSearchRequestSchema.safeParse({ query: "x", topK: 51 }).success).toBe(false);
    expect(WikiSearchRequestSchema.parse({ query: "x", topK: 5 })).toEqual({ query: "x", topK: 5 });
  });
});

describe("AskRequestSchema", () => {
  it("accepts a typical question", () => {
    expect(AskRequestSchema.parse({ question: "What is DMARC?" })).toBeTruthy();
  });

  it("rejects empty and oversized questions", () => {
    expect(AskRequestSchema.safeParse({ question: "" }).success).toBe(false);
    expect(AskRequestSchema.safeParse({ question: "x".repeat(4001) }).success).toBe(false);
  });
});
