// SPDX-License-Identifier: Apache-2.0

// Read-only page viewer. `client:load` so the "Edit" toggle to
// WikiEditor is instant. The sanitized markdown render uses the same
// pipeline as chat (renderMarkdown from @loomwiki/shared).

import { Button } from "@/components/ui/button";
import { FrontmatterPill } from "@/components/wiki/FrontmatterPill";
import { SanitizedMarkdown } from "@/components/wiki/SanitizedMarkdown";
import { WikiEditor } from "@/components/wiki/WikiEditor";
import type { WikiPagePayload } from "@/lib/types";
import { Pencil } from "lucide-react";
import { useState } from "react";

export interface WikiViewerProps {
  page: WikiPagePayload;
  /** Whether the current user is allowed to edit. Workspace owner = true for v0.0.1. */
  canEdit?: boolean;
}

export function WikiViewer({ page: initialPage, canEdit = true }: WikiViewerProps) {
  const [page, setPage] = useState<WikiPagePayload>(initialPage);
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <WikiEditor
        initialPage={page}
        onSaved={(next) => {
          setPage(next);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <article className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-background px-6 py-3">
        <h1 className="text-xl font-semibold">{page.frontmatter.title}</h1>
        <FrontmatterPill kind={page.frontmatter.kind} status={page.frontmatter.status} />
        <span className="ml-auto text-xs font-mono text-muted-foreground" data-testid="wiki-path">
          {page.path}
        </span>
        {canEdit && (
          <Button variant="outline" onClick={() => setEditing(true)} data-testid="wiki-edit">
            <Pencil className="size-4" />
            Edit
          </Button>
        )}
      </header>
      <div className="prose max-w-3xl flex-1 px-6 py-6">
        <SanitizedMarkdown source={page.body} />
      </div>
    </article>
  );
}
