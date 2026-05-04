// SPDX-License-Identifier: Apache-2.0

// Tiny inline indicator showing a page's kind + status. Rendered in
// the page header and reused by the design samples so the palette is
// auditable in /design.

import type { WikiPageKind, WikiPageStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<WikiPageKind, string> = {
  entity: "entity",
  decision: "decision",
  concept: "concept",
  "open-question": "open-question",
  glossary: "glossary",
};

const STATUS_CLASS: Record<WikiPageStatus, string> = {
  draft: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  published: "bg-amber-200 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  superseded: "bg-muted text-muted-foreground line-through",
};

export interface FrontmatterPillProps {
  kind: WikiPageKind;
  status: WikiPageStatus;
  className?: string;
}

export function FrontmatterPill({ kind, status, className }: FrontmatterPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border px-2 py-0.5 text-xs font-medium",
        STATUS_CLASS[status],
        className,
      )}
      data-testid="frontmatter-pill"
    >
      <span className="opacity-70">{KIND_LABEL[kind]}</span>
      <span aria-hidden="true">·</span>
      <span>{status}</span>
    </span>
  );
}
