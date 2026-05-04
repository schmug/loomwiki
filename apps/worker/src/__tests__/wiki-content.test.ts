// SPDX-License-Identifier: Apache-2.0

// Tests for the wiki-content lib (serialize / deserialize / validate).
// Lives in the worker test pool so crypto.subtle is available.

import { LoomwikiError } from "@loomwiki/shared";
import { describe, expect, it } from "vitest";
import {
  deserializePage,
  serializePage,
  validatePagePayload,
} from "../lib/wiki-content.js";

const VALID_FRONTMATTER = {
  title: "DMARC",
  kind: "concept" as const,
  created: "2026-05-04",
  last_updated: "2026-05-04",
  status: "draft" as const,
};

describe("serializePage / deserializePage", () => {
  it("round-trips frontmatter and body byte-stably", async () => {
    const body = "# DMARC\n\nDomain-based Message Authentication.\n";
    const first = await serializePage(VALID_FRONTMATTER, body);
    const parsed = await deserializePage(first.raw);
    expect(parsed.frontmatter).toEqual(VALID_FRONTMATTER);
    expect(parsed.body).toBe(body);
    expect(parsed.sha).toBe(first.sha);

    // Re-serializing the round-tripped result should be byte-identical.
    const second = await serializePage(parsed.frontmatter, parsed.body);
    expect(second.raw).toBe(first.raw);
    expect(second.sha).toBe(first.sha);
  });

  it("computes a different SHA when the body changes", async () => {
    const a = await serializePage(VALID_FRONTMATTER, "first");
    const b = await serializePage(VALID_FRONTMATTER, "second");
    expect(a.sha).not.toBe(b.sha);
    expect(a.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects malformed YAML frontmatter on deserialize", async () => {
    const bad = "---\ntitle: ok\nkind: [unclosed\n---\nbody\n";
    await expect(deserializePage(bad)).rejects.toBeInstanceOf(LoomwikiError);
  });

  it("rejects frontmatter that violates the strict schema", async () => {
    const bad = "---\ntitle: ok\nkind: bogus\ncreated: 2026-05-04\nlast_updated: 2026-05-04\nstatus: draft\n---\nbody";
    await expect(deserializePage(bad)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("validatePagePayload", () => {
  it("accepts a stub page (empty body)", () => {
    expect(() => validatePagePayload({ frontmatter: VALID_FRONTMATTER, body: "" })).not.toThrow();
  });

  it("accepts a normal markdown body", () => {
    expect(() =>
      validatePagePayload({ frontmatter: VALID_FRONTMATTER, body: "**bold** and a `link` " }),
    ).not.toThrow();
  });

  it("rejects a body that exceeds the 64 KB cap", () => {
    const big = "a".repeat(64 * 1024 + 1);
    expect(() => validatePagePayload({ frontmatter: VALID_FRONTMATTER, body: big })).toThrow(
      LoomwikiError,
    );
  });

  it("rejects a body that sanitizes to empty (only stripped tags)", () => {
    // The sanitizer drops <script> wholesale; a body that contains only
    // a script tag renders to "" which is the load-bearing failure
    // mode this guard catches.
    const onlyScript = "<script>alert(1)</script>";
    expect(() => validatePagePayload({ frontmatter: VALID_FRONTMATTER, body: onlyScript })).toThrow(
      /blank HTML/,
    );
  });

  it("rejects malformed frontmatter with VALIDATION_FAILED", () => {
    try {
      validatePagePayload({ frontmatter: { ...VALID_FRONTMATTER, kind: "garbage" }, body: "ok" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LoomwikiError);
      expect((err as LoomwikiError).code).toBe("VALIDATION_FAILED");
      expect((err as LoomwikiError).status).toBe(400);
    }
  });
});
