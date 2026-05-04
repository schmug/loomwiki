// SPDX-License-Identifier: Apache-2.0

// 3-way merge picker. v0.0.1 doesn't auto-merge; it shows incoming
// (read-only) and local (editable) side-by-side with the base text in
// a collapsed details element. Saving sends the local pane back as a
// fresh PUT with `before_sha = current_sha` from the conflict payload.

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { WikiConflictDetails, WikiPageFrontmatter } from "@/lib/types";
import { useEffect, useState } from "react";

/**
 * Render a frontmatter + body pair to the YAML-fenced on-disk shape
 * that the worker stores. We hand-write the YAML rather than pulling
 * in `js-yaml` — frontmatter is a fixed strict shape (Zod-validated
 * by the worker on submit), and key:value lines suffice.
 */
function toYamlPage(fm: WikiPageFrontmatter, body: string): string {
  const lines: string[] = ["---"];
  lines.push(`title: ${yamlScalar(fm.title)}`);
  lines.push(`kind: ${fm.kind}`);
  lines.push(`created: ${fm.created}`);
  lines.push(`last_updated: ${fm.last_updated}`);
  lines.push(`status: ${fm.status}`);
  if (fm.superseded_by !== undefined) {
    lines.push(`superseded_by: ${yamlScalar(fm.superseded_by)}`);
  }
  if (fm.sources && fm.sources.length > 0) {
    lines.push("sources:");
    for (const s of fm.sources) {
      lines.push(`  - room: ${yamlScalar(s.room)}`);
      lines.push(`    message_id: ${yamlScalar(s.message_id)}`);
      if (s.excerpt !== undefined) {
        lines.push(`    excerpt: ${yamlScalar(s.excerpt)}`);
      }
    }
  }
  lines.push("---", "", body);
  return lines.join("\n");
}

function yamlScalar(value: string): string {
  // Quote any scalar that contains characters YAML would otherwise
  // misinterpret (colons, leading dashes, hashes, brackets). Keep it
  // simple: always quote and escape backslashes + double quotes.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export interface MergeDialogProps {
  details: WikiConflictDetails | null;
  /**
   * Called when the user picks a resolution. The body is the merged
   * page raw (frontmatter + body); the caller re-parses it for the
   * write request and submits with `before_sha = details.current_sha`.
   */
  onResolve: (mergedRaw: string, currentSha: string) => Promise<void>;
  onClose: () => void;
}

export function MergeDialog({ details, onResolve, onClose }: MergeDialogProps) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (details) {
      // Initial local pane = the user's attempted content rendered as
      // YAML (the on-disk shape). YAML keeps "Use this" symmetric with
      // the incoming pane's `current_raw`, and the worker re-parses
      // with gray-matter so a YAML-fenced submit just works.
      setDraft(toYamlPage(details.attempted_frontmatter, details.attempted_body));
    } else {
      setDraft("");
    }
  }, [details]);

  async function submit(): Promise<void> {
    if (!details) return;
    setSubmitting(true);
    try {
      await onResolve(draft, details.current_sha);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={details !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Resolve conflict</DialogTitle>
          <DialogDescription>
            This page changed since you opened it. Pick or hand-edit a resolution. v0.0.1 does not
            auto-merge — you decide what wins.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <section className="space-y-2">
            <header className="flex items-center justify-between">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Incoming (saved by someone else)
              </h3>
              <Button
                size="sm"
                variant="ghost"
                disabled={!details}
                onClick={() => {
                  if (details) setDraft(details.current_raw);
                }}
              >
                Use this
              </Button>
            </header>
            <Textarea
              readOnly
              value={details?.current_raw ?? ""}
              rows={18}
              className="font-mono text-xs"
            />
          </section>

          <section className="space-y-2">
            <header className="flex items-center justify-between">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Local (your draft)
              </h3>
              <Button size="sm" variant="ghost" onClick={() => setDraft("")}>
                Clear
              </Button>
            </header>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={18}
              className="font-mono text-xs"
              data-testid="merge-local"
            />
          </section>
        </div>

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Base (the version you started from)</summary>
          <pre className="mt-2 overflow-auto rounded-md bg-secondary p-3 font-mono">
            {details?.base_raw ?? ""}
          </pre>
        </details>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!details || submitting}>
            {submitting ? "Saving…" : "Save resolution"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
