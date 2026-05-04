// SPDX-License-Identifier: Apache-2.0

// Live room view. Hydrates with `client:load` so the WS opens as soon
// as the page is interactive. Owns the chat plumbing (useChat) and
// composes MessageList + MessageComposer + ConnectionBadge.

import { Toaster } from "@/components/ui/sonner";
import type { SerializedRoom, SerializedUser } from "@/lib/types";
import { useEffect, useMemo } from "react";
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

export function RoomView({ room, currentUser, members }: RoomViewProps) {
  const chat = useChat({ roomId: room.id, currentUserId: currentUser.id });

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

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">#{room.slug}</h1>
          {room.topic && <p className="truncate text-xs text-muted-foreground">{room.topic}</p>}
        </div>
        <ConnectionBadge status={chat.status} />
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
