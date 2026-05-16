// SPDX-License-Identifier: Apache-2.0

// Live room view. Hydrates with `client:load` so the WS opens as soon
// as the page is interactive. Owns the chat plumbing (useChat) and
// composes MessageList + MessageComposer + ConnectionBadge.

import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { ApiError } from "@/lib/api";
import { getRunStatus, triggerIngest } from "@/lib/api-inbox";
import type { SerializedRoom, SerializedUser } from "@/lib/types";
import { Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConnectionBadge } from "./ConnectionBadge";
import { MessageComposer } from "./MessageComposer";
import { MessageList } from "./MessageList";
import { useChat } from "./useChat";

export interface RoomViewProps {
  room: SerializedRoom;
  currentUser: SerializedUser;
  /** Pre-fetched workspace members for display-name resolution. */
  members?: SerializedUser[];
}

const POLL_MAX_ATTEMPTS = 15;
const POLL_INTERVAL_MS = 2_000;

// Polls GET /api/runs/:id until the run reaches a terminal state, then
// shows the appropriate toast. Runs fire-and-forget after the trigger
// returns so the ingest button re-enables immediately.
async function pollRunOutcome(runId: string): Promise<void> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    try {
      const { run } = await getRunStatus(runId);
      if (run.status === "succeeded") {
        toast.success("Ingest completed — check Inbox for proposals.");
        return;
      }
      if (run.status === "failed") {
        toast.error(
          run.error
            ? `Ingest failed: ${run.error}`
            : "Ingest failed — check worker logs for details.",
        );
        return;
      }
    } catch {
      // transient fetch error — keep retrying
    }
  }
  toast.info("Ingest is still running — check Inbox for proposals shortly.");
}

export function RoomView({ room, currentUser, members }: RoomViewProps) {
  const chat = useChat({ roomId: room.id, currentUserId: currentUser.id });
  const [ingestPending, setIngestPending] = useState(false);

  // Author display-name lookup. Includes the current user as a baseline
  // so own messages render without a network round-trip. Workspace
  // members are layered in if the page provides them; unknown users
  // fall back to "(unknown)" in MessageBubble.
  const authorDisplayNames = useMemo(() => {
    const m = new Map<string, string>();
    m.set(currentUser.id, currentUser.display_name);
    for (const u of members ?? []) m.set(u.id, u.display_name);
    return m;
  }, [currentUser, members]);

  // Surface non-fatal errors as toasts. Auth errors are handled at the
  // page chrome level (api.ts throws AuthRequiredError, which the page
  // SSR converts to an Access redirect). Errors here are wire-level.
  useEffect(() => {
    if (chat.lastError) toast.error(chat.lastError.message);
  }, [chat.lastError]);

  async function handleRunIngest(): Promise<void> {
    setIngestPending(true);
    try {
      const res = await triggerIngest(room.id);
      if (res.status === "lock_held") {
        toast.info("An ingest run is already in progress for this room.");
        return;
      }
      // Fire-and-forget: poll for the run outcome in the background so
      // the button re-enables immediately. The toast updates when done.
      void pollRunOutcome(res.run_id);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Failed to start ingest";
      toast.error(msg);
    } finally {
      setIngestPending(false);
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">#{room.slug}</h1>
          {room.topic && <p className="truncate text-xs text-muted-foreground">{room.topic}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRunIngest}
            disabled={ingestPending}
            title="Extract wiki proposals from recent chat (requires AI config)"
            className="gap-1.5"
          >
            <Play className="size-3.5" aria-hidden="true" />
            {ingestPending ? "Starting…" : "Run ingest"}
          </Button>
          <ConnectionBadge status={chat.status} />
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <MessageList
          messages={chat.messages}
          currentUserId={currentUser.id}
          authorDisplayNames={authorDisplayNames}
          hasOlderHistory={chat.hasOlderHistory}
          onLoadOlder={chat.loadOlder}
          onEdit={chat.edit}
          onDelete={chat.remove}
          onRetry={chat.retry}
        />
      </div>

      <MessageComposer
        onSend={(body) => chat.send(body)}
        disabled={chat.status === "disconnected"}
        placeholder={`Message #${room.slug}`}
      />

      <Toaster />
    </section>
  );
}
