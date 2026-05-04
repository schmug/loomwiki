// SPDX-License-Identifier: Apache-2.0

// docs/SECURITY.md §3 acceptance: rendering untrusted markdown must
// strip <script>, neutralize javascript: URLs and on* handlers, and
// rewrite external <a> with rel="noopener noreferrer ugc". Each test
// below pins one of those guarantees so a future "minor" sanitizer
// tweak can't silently regress it.

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../markdown-sanitize.js";

describe("renderMarkdown", () => {
  it("renders an empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("renders basic GFM markdown", () => {
    const html = renderMarkdown("**bold** and _italic_");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("renders GFM tables", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    const html = renderMarkdown(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders GFM autolinks", () => {
    const html = renderMarkdown("see https://example.com for details");
    expect(html).toContain('href="https://example.com"');
  });

  it("renders GFM task lists", () => {
    const html = renderMarkdown("- [ ] todo\n- [x] done");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
  });

  it("strips <script> tags entirely", () => {
    // Tag is stripped; the text content between the tags survives as
    // inert text (this is the standard rehype-sanitize behaviour and is
    // the correct outcome — no executable script reaches the DOM).
    const html = renderMarkdown("hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<\/script>/i);
  });

  it("strips <iframe> tags", () => {
    const html = renderMarkdown('<iframe src="https://evil.example"></iframe>');
    expect(html).not.toContain("<iframe");
  });

  it("strips <style> blocks", () => {
    const html = renderMarkdown("<style>body{display:none}</style>");
    expect(html).not.toContain("<style");
  });

  it("strips inline event handlers", () => {
    const html = renderMarkdown('<a href="https://example.com" onclick="alert(1)">x</a>');
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert(1)");
  });

  it("neutralizes javascript: URLs in links", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    // The href attribute must not contain the dangerous scheme.
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("neutralizes javascript: URLs in images", () => {
    const html = renderMarkdown("![alt](javascript:alert(1))");
    expect(html).not.toMatch(/src="javascript:/i);
  });

  it("rewrites external <a> with rel=noopener noreferrer ugc", () => {
    const html = renderMarkdown("[link](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer ugc"');
  });

  it("keeps internal <a> with target=_self and no rel", () => {
    const html = renderMarkdown("[home](/r/general)");
    expect(html).toContain('href="/r/general"');
    expect(html).toContain('target="_self"');
    expect(html).not.toMatch(/rel="/);
  });

  it("strips style attributes from elements", () => {
    // raw HTML inside markdown is escaped/stripped by remark-rehype with
    // allowDangerousHtml:false, so style="" can never reach the output.
    const html = renderMarkdown('<p style="color:red">x</p>');
    expect(html).not.toContain("style=");
  });

  it("preserves code blocks with language className", () => {
    const md = "```ts\nconst x = 1;\n```";
    const html = renderMarkdown(md);
    expect(html).toContain("<code");
    expect(html).toContain("language-ts");
  });
});
