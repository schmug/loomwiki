// SPDX-License-Identifier: Apache-2.0

// Plain-textarea composer (Milkdown lands in M4 with the wiki editor).
//
// Keys:
//   - Cmd/Ctrl+Enter: send
//   - Enter: newline
//   - Shift+Enter: newline
//
// Body cap (4096 chars; MAX_BODY_CHARS in @loomwiki/shared):
//   - Soft warning at 4000 (counter turns amber)
//   - Hard reject at 4096 (counter turns destructive, send disabled)

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MAX_BODY_CHARS } from "@loomwiki/shared";
import { Send } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

const SOFT_LIMIT = 4000;

export interface MessageComposerProps {
  onSend: (body: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function MessageComposer({
  onSend,
  disabled = false,
  placeholder = "Send a message…",
}: MessageComposerProps) {
  const [draft, setDraft] = useState("");
  const trimmed = draft.trim();
  const tooLong = draft.length > MAX_BODY_CHARS;
  const canSend = !disabled && trimmed.length > 0 && !tooLong;

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  }

  function send(): void {
    if (!canSend) return;
    onSend(trimmed);
    setDraft("");
  }

  return (
    <div className="border-t border-border bg-background p-3">
      <div className="flex items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={Math.min(6, Math.max(1, draft.split("\n").length))}
          className="resize-none"
          aria-label="Message composer"
          aria-describedby="composer-hint"
        />
        <Button
          variant="accent"
          size="icon"
          onClick={send}
          disabled={!canSend}
          aria-label="Send message"
        >
          <Send className="size-4" />
        </Button>
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
        <span id="composer-hint">
          <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-[0.7rem]">⌘</kbd> +{" "}
          <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-[0.7rem]">
            Enter
          </kbd>{" "}
          to send
        </span>
        <span
          className={cn(
            tooLong && "text-destructive",
            !tooLong && draft.length > SOFT_LIMIT && "text-amber-600 dark:text-amber-400",
          )}
          aria-live="polite"
        >
          {draft.length} / {MAX_BODY_CHARS}
        </span>
      </div>
    </div>
  );
}
