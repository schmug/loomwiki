// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { chunkPageBySection, slugifyHeading } from "../markdown-chunk.js";

const INPUT = {
  path: "/wiki/concepts/dmarc.md",
  title: "DMARC",
  kind: "concept",
};

describe("chunkPageBySection", () => {
  it("emits a single full-page chunk when there are no headings", () => {
    const out = chunkPageBySection("Just a paragraph.\n\nAnother one.\n", INPUT);
    expect(out).toEqual([
      {
        path: INPUT.path,
        title: INPUT.title,
        kind: INPUT.kind,
        heading: null,
        sectionPath: [],
        body: "Just a paragraph.\n\nAnother one.",
      },
    ]);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(chunkPageBySection("   \n\n  \t\n", INPUT)).toEqual([]);
  });

  it("captures a prelude before the first heading", () => {
    const md = "Top intro paragraph.\n\n# Heading\n\nBody.\n";
    const out = chunkPageBySection(md, INPUT);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ heading: null, sectionPath: [], body: "Top intro paragraph." });
    expect(out[1]).toMatchObject({
      heading: "Heading",
      sectionPath: ["Heading"],
      body: "Body.",
    });
  });

  it("splits on H1 and H2; H3 stays inside its parent section", () => {
    const md = [
      "# A",
      "",
      "Body of A.",
      "",
      "## B",
      "",
      "Body of B.",
      "",
      "### C-not-split",
      "",
      "Body of C, still inside B.",
      "",
      "## D",
      "",
      "Body of D.",
      "",
    ].join("\n");

    const out = chunkPageBySection(md, INPUT);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ heading: "A", sectionPath: ["A"], body: "Body of A." });
    expect(out[1]).toMatchObject({
      heading: "B",
      sectionPath: ["A", "B"],
      body: "Body of B.\n\n### C-not-split\n\nBody of C, still inside B.",
    });
    expect(out[2]).toMatchObject({ heading: "D", sectionPath: ["A", "D"], body: "Body of D." });
  });

  it("does NOT split inside fenced code blocks even when they contain `#`", () => {
    const md = ["# Real heading", "", "```ts", "// # not a heading", "x = 1", "```", ""].join("\n");
    const out = chunkPageBySection(md, INPUT);
    expect(out).toHaveLength(1);
    expect(out[0]?.heading).toBe("Real heading");
    expect(out[0]?.body).toContain("```ts");
    expect(out[0]?.body).toContain("// # not a heading");
  });

  it("drops empty sections (heading with no body)", () => {
    const md = ["# Empty", "", "## Has body", "", "Hello."].join("\n");
    const out = chunkPageBySection(md, INPUT);
    expect(out).toHaveLength(1);
    expect(out[0]?.heading).toBe("Has body");
  });

  it("inherits H1 ancestor across multiple H2 siblings", () => {
    const md = "# Top\n\n## L\n\nleft\n\n## R\n\nright\n";
    const out = chunkPageBySection(md, INPUT);
    expect(out.map((c) => c.sectionPath)).toEqual([["Top", "L"], ["Top", "R"]]);
  });

  it("preserves frontmatter-context fields verbatim on every chunk", () => {
    const md = "# Heading\n\nBody.\n";
    const out = chunkPageBySection(md, {
      path: "/wiki/decisions/2026-05-x.md",
      title: "May X decision",
      kind: "decision",
    });
    expect(out[0]).toMatchObject({
      path: "/wiki/decisions/2026-05-x.md",
      title: "May X decision",
      kind: "decision",
    });
  });

  it("strips inline emphasis from heading text", () => {
    const md = "# **DMARC** explained\n\nBody.\n";
    const out = chunkPageBySection(md, INPUT);
    expect(out[0]?.heading).toBe("DMARC explained");
  });

  it("chunks a long page into several bodies", () => {
    const sections = Array.from({ length: 8 }, (_, i) => `## Section ${i}\n\nBody of section ${i}.`);
    const out = chunkPageBySection(sections.join("\n\n"), INPUT);
    expect(out).toHaveLength(8);
    for (let i = 0; i < 8; i += 1) {
      expect(out[i]?.heading).toBe(`Section ${i}`);
    }
  });
});

describe("slugifyHeading", () => {
  it("kebab-cases ASCII", () => {
    expect(slugifyHeading("Hello World")).toBe("hello-world");
  });

  it("strips punctuation", () => {
    expect(slugifyHeading("DMARC, SPF, & DKIM!")).toBe("dmarc-spf-dkim");
  });

  it("collapses whitespace and dashes", () => {
    expect(slugifyHeading("  too   many   spaces  ---  here  ")).toBe("too-many-spaces-here");
  });

  it("returns empty string for an all-symbol heading", () => {
    expect(slugifyHeading("!!!")).toBe("");
  });
});
