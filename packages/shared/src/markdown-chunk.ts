// SPDX-License-Identifier: Apache-2.0

// Per-section markdown chunker for M6 search indexing.
//
// Walks the same mdast AST the sanitizer parses (via
// `createMarkdownAstParser` in markdown-sanitize.ts) so the chunked
// content stays in lockstep with the rendered HTML — drift between
// "what we indexed" and "what we render" is the kind of bug that makes
// search results jump to a heading the page doesn't have.
//
// Splitting rules:
//   - Split on `heading` nodes with `depth ≤ 2` (H1 + H2). H3+ live
//     inside whatever section they fall under.
//   - Content before the first H1/H2 becomes the "prelude" chunk with
//     no heading.
//   - A page with NO headings at all becomes a single full-page chunk.
//   - Code blocks, lists, and tables are NOT split — they stay inside
//     the section that contains them.
//   - Trailing whitespace is trimmed; chunks with empty bodies are
//     dropped (a page section consisting only of `## Heading\n\n` is
//     not indexable).
//
// `sectionPath` accumulates ancestor headings: a page like
//   # A
//   ## B
//   ## C
// emits chunks with sectionPath ["A"], ["A","B"], ["A","C"].

import type { Heading, Root } from "mdast";
import { createMarkdownAstParser } from "./markdown-sanitize.js";

// Tiny mdast-to-string. Pulls leaf-text values out of a heading node so
// `# DMARC **rules**` becomes "DMARC rules". Implemented inline to keep
// the dep tree tight (matches the visit() pattern in markdown-sanitize).
function nodeToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; value?: unknown; children?: unknown };
  if (typeof n.value === "string") return n.value;
  if (Array.isArray(n.children)) {
    return n.children.map(nodeToText).join("");
  }
  return "";
}

export interface WikiChunkInput {
  /** The vault path the chunk came from, e.g. `/wiki/concepts/dmarc.md`. */
  path: string;
  /** Page-level title. Carried through unchanged to every chunk. */
  title: string;
  /** Page-level kind (frontmatter `kind`). Carried through unchanged. */
  kind: string;
}

export interface WikiChunk {
  path: string;
  title: string;
  kind: string;
  /** The H1/H2 heading text for this section, or null for the prelude. */
  heading: string | null;
  /** Ancestor heading chain (H1 outermost, this heading last). */
  sectionPath: string[];
  /** Raw markdown body of the section (heading stripped). */
  body: string;
}

/**
 * Slugify a heading for use as a `#section-slug` anchor. Mirrors the
 * approach the wiki viewer uses: kebab-case, ASCII-fold, lowercase,
 * collapse runs of dashes. Returns the empty string for an
 * all-non-alphanumeric heading.
 */
export function slugifyHeading(heading: string): string {
  return (
    heading
      .normalize("NFKD")
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: stripping combining marks is intentional
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
  );
}

// Bodies are extracted verbatim from the raw markdown source (between
// the end of one heading node and the start of the next H1/H2). We
// don't round-trip through mdast.toMarkdown() because that would
// rewrite code fences, link references, and HTML in ways that break
// byte-stable indexing.
export function chunkPageBySection(markdown: string, input: WikiChunkInput): WikiChunk[] {
  const parser = createMarkdownAstParser();
  const tree = parser.parse(markdown) as Root;

  // Collect H1 + H2 headings with their source offsets. Anything else
  // is just content inside whatever section came last.
  const splits: { heading: Heading; depth: 1 | 2; startOffset: number; endOffset: number }[] = [];
  for (const node of tree.children) {
    if (node.type === "heading" && (node.depth === 1 || node.depth === 2)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      splits.push({ heading: node, depth: node.depth, startOffset: start, endOffset: end });
    }
  }

  // No headings → single full-page chunk.
  if (splits.length === 0) {
    const body = markdown.trim();
    if (body.length === 0) return [];
    return [
      {
        path: input.path,
        title: input.title,
        kind: input.kind,
        heading: null,
        sectionPath: [],
        body,
      },
    ];
  }

  const chunks: WikiChunk[] = [];

  // Prelude — content before the first H1/H2 split.
  const firstSplit = splits[0];
  if (firstSplit && firstSplit.startOffset > 0) {
    const preludeBody = markdown.slice(0, firstSplit.startOffset).trim();
    if (preludeBody.length > 0) {
      chunks.push({
        path: input.path,
        title: input.title,
        kind: input.kind,
        heading: null,
        sectionPath: [],
        body: preludeBody,
      });
    }
  }

  // Track ancestor headings to build sectionPath. Stack indexed by
  // depth: stack[0] = current H1, stack[1] = current H2.
  const stack: (string | null)[] = [null, null];

  for (let i = 0; i < splits.length; i += 1) {
    const split = splits[i];
    if (!split) continue;
    const headingText = nodeToText(split.heading).trim();
    if (split.depth === 1) {
      stack[0] = headingText;
      stack[1] = null;
    } else {
      stack[1] = headingText;
    }

    const sectionPath = stack.filter((s): s is string => s !== null);

    // Body runs from the end of this heading to the start of the next
    // H1/H2 split (or EOF).
    const bodyStart = split.endOffset;
    const next = splits[i + 1];
    const bodyEnd = next ? next.startOffset : markdown.length;
    const body = markdown.slice(bodyStart, bodyEnd).trim();

    if (body.length === 0) continue;

    chunks.push({
      path: input.path,
      title: input.title,
      kind: input.kind,
      heading: headingText,
      sectionPath,
      body,
    });
  }

  return chunks;
}
