// SPDX-License-Identifier: Apache-2.0

// AGENTS.md editor. Plain <textarea> — Milkdown is overkill for a
// config file the operator hand-tunes maybe once a quarter, and the
// resolved-decisions table accepts the textarea variant for v0.0.1.
//
// The save flow forces a confirm dialog because AGENTS.md drives the
// ingest agent's behavior wholesale; an unintended edit could change
// proposal quality on the next run. The dialog is the authoritative
// "yes, I meant that" moment, so the API helper is only called from
// inside the dialog's Save button.

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { getAgentsMd, setAgentsMd } from "@/lib/api-settings";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export function AgentsMdEditor() {
  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAgentsMd()
      .then((data) => {
        if (cancelled) return;
        setContent(data.content);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load AGENTS.md");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleConfirm(): Promise<void> {
    if (content === null) return;
    setSubmitting(true);
    try {
      await setAgentsMd(content, true);
      setConfirmOpen(false);
      toast.success("AGENTS.md updated");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save AGENTS.md";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <div className="p-6 text-sm text-destructive" role="alert">
        Failed to load AGENTS.md: {loadError}
      </div>
    );
  }

  if (content === null) {
    return (
      <div className="p-6 text-sm text-muted-foreground" aria-busy="true">
        Loading…
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">AGENTS.md</h1>
        <p className="text-sm text-muted-foreground">
          The schema and conventions the ingest agent follows when turning chat into wiki proposals.
          Lives in your vault repo. Changes apply on the next ingest run.
        </p>
      </header>

      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={24}
        className="font-mono text-xs"
        aria-label="AGENTS.md content"
      />

      <div className="flex justify-end">
        <Button type="button" onClick={() => setConfirmOpen(true)}>
          Save changes
        </Button>
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!submitting) setConfirmOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update AGENTS.md?</DialogTitle>
            <DialogDescription>
              This file controls how the ingest agent processes chat into wiki proposals. Changes
              apply on the next ingest run.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={submitting}
              onClick={() => {
                void handleConfirm();
              }}
            >
              {submitting ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Toaster />
    </div>
  );
}
