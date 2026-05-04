// SPDX-License-Identifier: Apache-2.0

// Wiki page frontmatter + path validation tests.
// Schema is the wire contract between the editor (M4 web), the worker
// route layer (M4 worker), and the M7 ingest agent — drift between any
// of those will be caught here.

import { LoomwikiError } from "@loomwiki/shared";
import { describe, expect, it } from "vitest";
import { WikiPageFrontmatterSchema, isVaultTopLevelPath, validateWikiPath } from "../index.js";
import { parseWikiFrontmatter } from "../parsers.js";

describe("validateWikiPath", () => {
  it("accepts well-formed wiki paths", () => {
    expect(validateWikiPath("/wiki/dmarc.md")).toBe(true);
    expect(validateWikiPath("/wiki/concepts/spf.md")).toBe(true);
    expect(validateWikiPath("/wiki/decisions/2026-05-rollout.md")).toBe(true);
    expect(validateWikiPath("/wiki/glossary/q2-2026.md")).toBe(true);
  });

  it("accepts system files with leading underscore", () => {
    // SPEC §7.2 / vault-template/AGENTS.md §4.3 reference these paths.
    expect(validateWikiPath("/wiki/_index.md")).toBe(true);
    expect(validateWikiPath("/wiki/_open-questions.md")).toBe(true);
  });

  it("rejects uppercase, traversal, and bad extensions", () => {
    expect(validateWikiPath("/wiki/DMARC.md")).toBe(false);
    expect(validateWikiPath("/wiki/../etc.md")).toBe(false);
    expect(validateWikiPath("/wiki/.hidden.md")).toBe(false);
    expect(validateWikiPath("/wiki/page.txt")).toBe(false);
    expect(validateWikiPath("/wiki/page")).toBe(false);
    expect(validateWikiPath("/wiki/")).toBe(false);
    expect(validateWikiPath("/wiki/page.md/")).toBe(false);
    expect(validateWikiPath("/wiki/a//b.md")).toBe(false);
  });

  it("rejects paths outside /wiki/", () => {
    expect(validateWikiPath("/AGENTS.md")).toBe(false);
    expect(validateWikiPath("/README.md")).toBe(false);
    expect(validateWikiPath("/rooms/ops/log.md")).toBe(false);
    expect(validateWikiPath("wiki/x.md")).toBe(false);
  });

  it("rejects non-string and oversize inputs", () => {
    expect(validateWikiPath("")).toBe(false);
    // 256-char cap; 257 should fail.
    const long = `/wiki/${"a".repeat(260)}.md`;
    expect(validateWikiPath(long)).toBe(false);
  });
});

describe("isVaultTopLevelPath", () => {
  it("admits exactly /AGENTS.md and /README.md", () => {
    expect(isVaultTopLevelPath("/AGENTS.md")).toBe(true);
    expect(isVaultTopLevelPath("/README.md")).toBe(true);
    expect(isVaultTopLevelPath("/agents.md")).toBe(false);
    expect(isVaultTopLevelPath("/wiki/AGENTS.md")).toBe(false);
  });
});

describe("WikiPageFrontmatterSchema", () => {
  const valid = {
    title: "DMARC",
    kind: "concept" as const,
    created: "2026-05-04",
    last_updated: "2026-05-04",
    status: "draft" as const,
  };

  it("accepts a minimal valid frontmatter", () => {
    expect(() => WikiPageFrontmatterSchema.parse(valid)).not.toThrow();
  });

  it("accepts the full optional surface", () => {
    expect(() =>
      WikiPageFrontmatterSchema.parse({
        ...valid,
        status: "superseded",
        superseded_by: "/wiki/decisions/2026-05-replacement.md",
        sources: [{ room: "ops", message_id: "01HX0000000000000000000000", excerpt: "quote" }],
      }),
    ).not.toThrow();
  });

  it("rejects an extra top-level key (strict)", () => {
    expect(() => WikiPageFrontmatterSchema.parse({ ...valid, made_up_field: 1 })).toThrow();
  });

  it("rejects unknown kind", () => {
    expect(() => WikiPageFrontmatterSchema.parse({ ...valid, kind: "unknown" })).toThrow();
  });

  it("rejects malformed dates", () => {
    expect(() => WikiPageFrontmatterSchema.parse({ ...valid, created: "yesterday" })).toThrow();
    expect(() =>
      WikiPageFrontmatterSchema.parse({ ...valid, last_updated: "2026-13-99" }),
    ).toThrow();
  });

  it("rejects empty title", () => {
    expect(() => WikiPageFrontmatterSchema.parse({ ...valid, title: "" })).toThrow();
  });

  it("rejects missing required fields", () => {
    const { kind: _kind, ...withoutKind } = valid;
    expect(() => WikiPageFrontmatterSchema.parse(withoutKind)).toThrow();
  });
});

describe("parseWikiFrontmatter", () => {
  const valid = {
    title: "DMARC",
    kind: "concept",
    created: "2026-05-04",
    last_updated: "2026-05-04",
    status: "draft",
  };

  it("returns the parsed object on success", () => {
    const out = parseWikiFrontmatter(valid);
    expect(out.title).toBe("DMARC");
  });

  it("throws a LoomwikiError on failure with VALIDATION_FAILED + 400", () => {
    try {
      parseWikiFrontmatter({ ...valid, kind: "garbage" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LoomwikiError);
      const e = err as LoomwikiError;
      expect(e.code).toBe("VALIDATION_FAILED");
      expect(e.status).toBe(400);
    }
  });
});
