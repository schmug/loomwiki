// SPDX-License-Identifier: Apache-2.0

// Sanitized GFM markdown → HTML pipeline. Single source of truth for
// every Loomwiki surface that renders untrusted markdown — chat bubbles
// (M3), wiki pages (M4), proposal diffs (M7). Drift between client and
// server renderers is a CSP-bypass class of bug, so the pipeline lives
// in @loomwiki/shared and both sides import it.
//
// Allowlist (per docs/SECURITY.md §3 / M14–M18):
//   - <script>, <iframe>, <style>, <object>, <embed>, <form> and
//     similar interactive/scripting tags are stripped.
//   - on* event handlers stripped from all elements.
//   - href / src URLs gated to a safe protocol set
//     (http, https, mailto, tel, /-relative). The "javascript" pseudo
//     scheme, the "data" scheme, and "vbscript" are dropped.
//   - <a> retains href, title, target, rel ONLY. External hrefs (those
//     that parse to a URL with a host different from the rendering page,
//     OR any absolute http(s) URL — we treat absolute as external from
//     a sanitizer perspective because we have no notion of "this origin"
//     in a stateless package) are forced to target="_blank" plus
//     rel="noopener noreferrer ugc".
//   - <img> retains src, alt, title, width, height. <img src=...> with
//     a non-http(s) protocol is dropped by the protocol allowlist.

import type { Element, Root } from "hast";
import type { Schema } from "hast-util-sanitize";
import { defaultSchema } from "rehype-sanitize";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/**
 * Tightened sanitize schema. Starts from rehype-sanitize's default
 * (already strict — drops <script>, on*, javascript:, etc.) and removes
 * the few HTML5 elements/attributes Loomwiki does not want even from a
 * trusted-author POV.
 */
export const defaultSanitizeSchema: Schema = (() => {
  // Deep clone via JSON since the schema is a plain JSON-shaped object.
  // Avoids relying on globalThis.structuredClone (DOM lib in TS) and
  // keeps @loomwiki/shared free of platform-specific deps.
  const base = JSON.parse(JSON.stringify(defaultSchema)) as Schema;

  // Disallow `class` and `style` everywhere. (default already disallows
  // `style`; we additionally block `class` to keep CSS scoped to the
  // sanitizer's caller — the shipped .md stylesheet — instead of letting
  // user content escape the scope.)
  base.attributes = base.attributes ?? {};
  base.attributes["*"] = ["ariaDescribedBy", "ariaLabel", "ariaLabelledBy", "id", "lang", "title"];

  // <a>: allow href, title, target (set by the rewriter), rel (set by
  // the rewriter). Strip everything else.
  base.attributes.a = ["href", "title", "target", "rel"];

  // <img>: standard set; src is gated by protocols below.
  base.attributes.img = ["src", "alt", "title", "width", "height"];

  // Code blocks may carry a language class (e.g., `language-ts`) so
  // syntax-highlighter integrations work in M4+. Allow `className` only
  // on <code> and <pre>.
  base.attributes.code = ["className"];
  base.attributes.pre = ["className"];

  // Protocol allowlist for href (links) and src (images).
  base.protocols = base.protocols ?? {};
  base.protocols.href = ["http", "https", "mailto", "tel"];
  base.protocols.src = ["http", "https"];
  base.protocols.cite = ["http", "https"];

  return base;
})();

/**
 * hast (HTML AST) plugin that hardens link targets:
 *   - Internal links (relative paths starting with `/`, `#`, or `?`)
 *     keep target="_self" so navigation feels native.
 *   - Everything else is treated as external: target="_blank" plus
 *     rel="noopener noreferrer ugc".
 *
 * Runs AFTER rehype-sanitize so the protocol gate has already dropped
 * dangerous URLs before we touch the tree.
 */
function rehypeRewriteLinks() {
  return (tree: Root): void => {
    visit(tree, (node) => {
      if (node.type !== "element") return;
      const el = node as Element;
      if (el.tagName !== "a") return;
      const href = el.properties?.href;
      if (typeof href !== "string") return;
      const isInternal = href.startsWith("/") || href.startsWith("#") || href.startsWith("?");
      el.properties = el.properties ?? {};
      if (isInternal) {
        el.properties.target = "_self";
        el.properties.rel = undefined;
      } else {
        el.properties.target = "_blank";
        el.properties.rel = "noopener noreferrer ugc";
      }
    });
  };
}

// Inline tree walker — avoids pulling unist-util-visit when we only need
// element nodes. Keeps the dep tree tighter (M3 budget).
function visit(node: Root | Element, fn: (n: Root | Element) => void): void {
  fn(node);
  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      if (child && typeof child === "object" && "type" in child && child.type === "element") {
        visit(child as Element, fn);
      }
    }
  }
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeSanitize, defaultSanitizeSchema)
  .use(rehypeRewriteLinks)
  .use(rehypeStringify);

/**
 * Build a fresh remark-parse + remark-gfm processor that returns the
 * mdast tree. Exported so the M6 chunker can walk the same AST the
 * sanitizer parses without forking the plugin chain — drift between
 * "what the sanitizer saw" and "what the chunker chunked" would mean
 * a search hit that doesn't render. Returns a NEW unified() each call
 * so callers don't share parser state across invocations.
 */
export function createMarkdownAstParser() {
  return unified().use(remarkParse).use(remarkGfm);
}

/**
 * Render untrusted markdown to a sanitized HTML string. Safe to inject
 * into the DOM via React's HTML-injection prop once the caller wraps it
 * in `.md`-scoped styles (see apps/web/src/styles/global.css).
 *
 * Pure synchronous: the unified processor we use is configured with
 * sync-only plugins, and `processSync` throws if a plugin returns a
 * Promise — desirable because rendering on the chat hot path must be
 * synchronous.
 */
export function renderMarkdown(input: string): string {
  if (input.length === 0) return "";
  const file = processor.processSync(input);
  return String(file);
}
