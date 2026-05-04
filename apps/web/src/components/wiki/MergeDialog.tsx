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
import type { WikiConflictDetails } from "@/lib/types";
import { useEffect, useState } from "react";

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
      // Initial local pane = the user's attempted content,
      // reconstructed from frontmatter + body. The user edits this
      // pane; we never auto-merge.
      const fm = JSON.stringify(details.attempted_frontmatter, null, 2);
      setDraft(`---\n${fm}\n---\n\n${details.attempted_body}`);
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
