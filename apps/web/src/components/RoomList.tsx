// SPDX-License-Identifier: Apache-2.0

// Sidebar room list. Reads /api/me's `rooms` (passed in as a prop so
// the parent owns the source-of-truth list and can refresh it).
//
// Hydrates with `client:idle` — the sidebar isn't on the latency hot
// path. Active room is detected from `location.pathname` so the
// highlight survives navigations done via a real <a> link.

import { CreateRoomDialog } from "@/components/CreateRoomDialog";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import type { SerializedRoom } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Hash, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

export interface RoomListProps {
  workspaceId: string;
  rooms: SerializedRoom[];
}

function currentSlug(): string | null {
  if (typeof location === "undefined") return null;
  const m = location.pathname.match(/^\/r\/([^/]+)/);
  return m?.[1] ?? null;
}

export function RoomList({ workspaceId, rooms: initialRooms }: RoomListProps) {
  const [rooms, setRooms] = useState<SerializedRoom[]>(initialRooms);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [navigatingTo, setNavigatingTo] = useState<string | null>(null);

  useEffect(() => {
    setActiveSlug(currentSlug());
  }, []);

  function handleCreated(room: SerializedRoom): void {
    // Optimistically prepend; the next /api/me hydration will reconcile.
    setRooms((prev) => [room, ...prev.filter((r) => r.id !== room.id)]);
  }

  return (
    <nav
      aria-label="Rooms"
      className="flex h-full min-h-0 flex-col bg-secondary text-secondary-foreground"
    >
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Rooms
        </h2>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {rooms.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            No rooms yet. Create one to get started.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {rooms.map((room) => {
              const isActive = activeSlug === room.slug;
              const isNavigating = navigatingTo === room.slug;
              return (
                <li key={room.id}>
                  <a
                    href={`/r/${room.slug}`}
                    onClick={() => setNavigatingTo(room.slug)}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                      isActive
                        ? "bg-accent/20 font-medium text-accent-foreground"
                        : "hover:bg-background/60",
                    )}
                    aria-current={isActive ? "page" : undefined}
                  >
                    {isNavigating ? (
                      <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                    ) : (
                      <Hash className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                    <span className="truncate">{room.name}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="border-t border-border p-2">
        <CreateRoomDialog workspaceId={workspaceId} onCreated={handleCreated} />
      </footer>

      <Toaster />
    </nav>
  );
}

// Sidebar-only fallback for the SSR path (no JS yet). Not used by the
// hydrated island; provided for completeness.
export function RoomListSkeleton() {
  return (
    <nav className="flex h-full min-h-0 flex-col bg-secondary p-2">
      <Button variant="ghost" size="sm" disabled className="w-full justify-start opacity-50">
        Loading rooms…
      </Button>
    </nav>
  );
}
