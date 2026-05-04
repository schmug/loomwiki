// SPDX-License-Identifier: Apache-2.0

// Inline-flex pill that links to a wiki page (and optional in-page anchor)
// from an /ask answer. Visual mirror of FrontmatterPill so the substrate
// reads as one design system, but it's an `<a>` not a `<span>` and it
// gets the external-arrow icon to telegraph "this navigates."

import type { AskCitation } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ArrowUpRight } from "lucide-react";

export interface CitationPillProps {
  citation: AskCitation;
  className?: string;
}

export function CitationPill({ citation, className }: CitationPillProps) {
  const href = buildHref(citation);
  return (
    <a
      href={href}
      data-testid="citation-pill"
      data-citation-path={citation.path}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-xs font-medium text-foreground no-underline transition-colors hover:bg-accent/20 hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <span className="truncate max-w-[14rem]">{citation.title}</span>
      <span aria-hidden="true" className="opacity-60">
        ·
      </span>
      <span className="opacity-70">{citation.kind}</span>
      <ArrowUpRight aria-hidden="true" className="size-3" />
    </a>
  );
}

function buildHref(citation: AskCitation): string {
  // Vault paths look like `/wiki/concepts/dmarc.md`. The web routes
  // live at `/w/<slug>` (no leading `/wiki/`, no trailing `.md`).
  const slug = citation.path.replace(/^\/wiki\//, "").replace(/\.md$/, "");
  const anchor = citation.heading_slug ? `#${citation.heading_slug}` : "";
  return `/w/${slug}${anchor}`;
}
