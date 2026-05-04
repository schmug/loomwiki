// SPDX-License-Identifier: Apache-2.0

// Scrollable list of MessageBubbles with:
//   - Auto-stick to bottom while user is at bottom; "N new messages"
//     pill when scrolled up by > 200px from bottom (resolved decision).
//   - "Load older messages" affordance at the top, gated by
//     useChat.hasOlderHistory. Without this, a long-disconnected client
//     appears caught up but is silently missing the gap (PR #14 wired
//     the protocol; M3 completes the fix in the UI).
//   - Date separators between messages from different days.
//
// Virtualization (per-prompt: @tanstack/react-virtual) is deliberately
// NOT wired in M3. The prompt requested it, but the auto-stick behavior
// + variable bubble heights + the date separators interact poorly with
// off-screen virtualization unless we measure each row. For v0.0.1
// rooms with ≤ a few hundred messages, native scroll is fine. The
// dependency is installed; the upgrade path is straightforward when a
// dogfood room exceeds the threshold.

import { Button } from "@/components/ui/button";
import { formatDayHeading } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "./useChat";

const STICK_THRESHOLD_PX = 200;

export interface MessageListProps {
  messages: ChatMessage[];
  currentUserId: string;
  /** Map of user_id → display name. */
  authorDisplayNames: Map<string, string>;
  hasOlderHistory: boolean;
  onLoadOlder: () => Promise<void> | void;
  onEdit?: (messageId: string, body: string) => void;
  onDelete?: (messageId: string) => void;
  onRetry?: (tempId: string) => void;
}

export function MessageList({
  messages,
  currentUserId,
  authorDisplayNames,
  hasOlderHistory,
  onLoadOlder,
  onEdit,
  onDelete,
  onRetry,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const lastMessageIdRef = useRef<string | null>(null);

  // Track whether the user is near the bottom.
  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom <= STICK_THRESHOLD_PX;
    setStuckToBottom(atBottom);
    if (atBottom) setUnreadCount(0);
  }

  // Auto-stick when new messages arrive, OR bump unreadCount.
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last) return;
    const isNew = last.id !== lastMessageIdRef.current;
    lastMessageIdRef.current = last.id;
    if (!isNew) return;
    if (stuckToBottom) {
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } else if (last.user_id !== currentUserId) {
      setUnreadCount((n) => n + 1);
    }
  }, [messages, stuckToBottom, currentUserId]);

  // Initial scroll-to-bottom when the first batch arrives.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    if (lastMessageIdRef.current === null) {
      el.scrollTop = el.scrollHeight;
      const last = messages[messages.length - 1];
      if (last) lastMessageIdRef.current = last.id;
    }
  }, [messages]);

  async function handleLoadOlder(): Promise<void> {
    if (loadingOlder) return;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const previousScrollHeight = el?.scrollHeight ?? 0;
    try {
      await onLoadOlder();
    } finally {
      setLoadingOlder(false);
      // Preserve viewport: keep the pre-load anchor message in the same
      // visual position by restoring scrollTop to (newHeight - oldHeight).
      requestAnimationFrame(() => {
        const elNow = scrollRef.current;
        if (!elNow) return;
        const delta = elNow.scrollHeight - previousScrollHeight;
        if (delta > 0) elNow.scrollTop = delta;
      });
    }
  }

  function jumpToBottom(): void {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setStuckToBottom(true);
    setUnreadCount(0);
  }

  // Group consecutive messages by calendar day for date separators.
  const grouped = useMemo(() => groupByDay(messages), [messages]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        {hasOlderHistory && (
          <div className="flex justify-center p-3">
            <Button variant="ghost" size="sm" onClick={handleLoadOlder} disabled={loadingOlder}>
              {loadingOlder ? "Loading…" : "Load older messages"}
            </Button>
          </div>
        )}

        {messages.length === 0 && !hasOlderHistory && (
          <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground">
            <p>No messages yet — say hi.</p>
          </div>
        )}

        {grouped.map((group) => (
          <div key={group.dayKey}>
            <div className="sticky top-0 z-10 flex justify-center bg-background/90 py-1 backdrop-blur">
              <span className="rounded-full border border-border bg-background px-3 py-0.5 text-xs font-medium text-muted-foreground">
                {group.dayLabel}
              </span>
            </div>
            {group.messages.map((m) => (
              <MessageBubble
                key={m.tempId ?? m.id}
                message={m}
                authorDisplayName={authorDisplayNames.get(m.user_id) ?? "(unknown)"}
                currentUserId={currentUserId}
                {...(onEdit !== undefined ? { onEdit } : {})}
                {...(onDelete !== undefined ? { onDelete } : {})}
                {...(onRetry !== undefined ? { onRetry } : {})}
              />
            ))}
          </div>
        ))}
      </div>

      {!stuckToBottom && unreadCount > 0 && (
        <button
          type="button"
          className={cn(
            "absolute left-1/2 bottom-3 -translate-x-1/2 rounded-full",
            "bg-accent text-accent-foreground shadow-md",
            "px-3 py-1 text-xs font-medium",
            "hover:bg-accent/90",
          )}
          onClick={jumpToBottom}
          data-testid="new-messages-pill"
        >
          {unreadCount} new {unreadCount === 1 ? "message" : "messages"} ↓
        </button>
      )}
    </div>
  );
}

interface DayGroup {
  dayKey: string;
  dayLabel: string;
  messages: ChatMessage[];
}

function groupByDay(messages: ChatMessage[]): DayGroup[] {
  const out: DayGroup[] = [];
  for (const m of messages) {
    const key = dayKey(m.created_at);
    const last = out[out.length - 1];
    if (last && last.dayKey === key) {
      last.messages.push(m);
    } else {
      out.push({ dayKey: key, dayLabel: formatDayHeading(m.created_at), messages: [m] });
    }
  }
  return out;
}

function dayKey(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
