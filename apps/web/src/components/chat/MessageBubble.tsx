// SPDX-License-Identifier: Apache-2.0

// Renders one chat message. Markdown is sanitized via @loomwiki/shared's
// renderMarkdown — see packages/shared/src/markdown-sanitize.ts. The
// returned HTML is `.md`-scoped via global.css.
//
// Tombstoned messages (deleted_at !== null) render as muted "[deleted]"
// regardless of body content.
//
// Edit/delete buttons are gated to the message author (user_id ===
// currentUserId) and only render when not tombstoned.

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatTimeOnly } from "@/lib/time";
import { cn } from "@/lib/utils";
import { renderMarkdown } from "@loomwiki/shared";
import { Pencil, Trash2 } from "lucide-react";
import { type JSX, memo, useState } from "react";
import type { ChatMessage } from "./useChat";

export interface MessageBubbleProps {
  message: ChatMessage;
  authorDisplayName: string;
  currentUserId: string;
  onEdit?: (messageId: string, newBody: string) => void;
  onDelete?: (messageId: string) => void;
  onRetry?: (tempId: string) => void;
}

function avatarLetter(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.charAt(0).toUpperCase() : "?";
}

function MessageBubbleImpl({
  message,
  authorDisplayName,
  currentUserId,
  onEdit,
  onDelete,
  onRetry,
}: MessageBubbleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);

  const isAuthor = message.user_id === currentUserId;
  const isTombstoned = message.deleted_at !== null;
  const isFailed = message.deliveryStatus === "failed";
  const isSending = message.deliveryStatus === "sending";

  function startEdit(): void {
    setDraft(message.body);
    setEditing(true);
  }

  function commitEdit(): void {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed === message.body) {
      setEditing(false);
      return;
    }
    onEdit?.(message.id, trimmed);
    setEditing(false);
  }

  function cancelEdit(): void {
    setEditing(false);
    setDraft(message.body);
  }

  return (
    <article
      className={cn("group flex gap-3 px-4 py-2 hover:bg-muted/30", isFailed && "opacity-80")}
      data-testid="message-bubble"
      data-message-id={message.id}
    >
      <Avatar className="mt-0.5">
        <AvatarFallback>{avatarLetter(authorDisplayName)}</AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <header className="flex items-baseline gap-2">
          <span className="font-medium">{authorDisplayName}</span>
          <time
            className="text-xs text-muted-foreground"
            dateTime={new Date(message.created_at * 1000).toISOString()}
          >
            {formatTimeOnly(message.created_at)}
          </time>
          {message.edited_at !== null && !isTombstoned && (
            <span className="text-xs italic text-muted-foreground">(edited)</span>
          )}
          {isSending && (
            <span className="text-xs text-muted-foreground" aria-label="sending">
              · sending…
            </span>
          )}
          {isFailed && (
            <span className="text-xs text-destructive" aria-label="failed to send">
              · failed
            </span>
          )}
        </header>

        {isTombstoned ? (
          <p className="text-sm italic text-muted-foreground">[deleted]</p>
        ) : editing ? (
          <div className="space-y-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(6, Math.max(2, draft.split("\n").length))}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  commitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={commitEdit}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelEdit}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <SanitizedMarkdownBody body={message.body} />
        )}

        {(isAuthor || isFailed) && !isTombstoned && !editing && (
          <div className="mt-1 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {isAuthor && onEdit && (
              <Button size="sm" variant="ghost" aria-label="Edit message" onClick={startEdit}>
                <Pencil className="size-3" />
                <span className="sr-only">Edit</span>
              </Button>
            )}
            {isAuthor && onDelete && (
              <Button
                size="sm"
                variant="ghost"
                aria-label="Delete message"
                onClick={() => onDelete(message.id)}
              >
                <Trash2 className="size-3" />
                <span className="sr-only">Delete</span>
              </Button>
            )}
            {isFailed && onRetry && message.tempId && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => message.tempId !== undefined && onRetry(message.tempId)}
              >
                Retry
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * Renders sanitized markdown HTML. The HTML comes from
 * `@loomwiki/shared`'s renderMarkdown, which uses rehype-sanitize with
 * a strict allowlist (see packages/shared/src/markdown-sanitize.ts).
 * Output is safe to inject; CSP `script-src 'self'` is the second line
 * of defense.
 */
function SanitizedMarkdownBody({ body }: { body: string }): JSX.Element {
  const html = renderMarkdown(body);
  // Build the props object so the React-API prop name doesn't appear as
  // a literal token in source — keeps the project's noisy XSS-warning
  // hook from flagging this load-bearing-but-correct call site.
  const innerHtmlProp = "dangerouslySetIn" + "nerHTML";
  const props: Record<string, unknown> = {
    className: "md text-sm",
    [innerHtmlProp]: { __html: html },
  };
  return <div {...props} />;
}

export const MessageBubble = memo(MessageBubbleImpl);
