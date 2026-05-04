// SPDX-License-Identifier: Apache-2.0

// Small status pill for the room header. Connected = stone-200/amber
// border, Reconnecting = amber, Disconnected = destructive.

import { cn } from "@/lib/utils";
import type { ConnectionStatus } from "./useChat";

export interface ConnectionBadgeProps {
  status: ConnectionStatus;
}

const COPY: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

export function ConnectionBadge({ status }: ConnectionBadgeProps) {
  return (
    <output
      aria-live="polite"
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        status === "connected" && "border-border bg-secondary text-secondary-foreground",
        status === "connecting" &&
          "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100",
        status === "reconnecting" &&
          "border-amber-400 bg-amber-100 text-amber-900 dark:border-amber-600 dark:bg-amber-900 dark:text-amber-50",
        status === "disconnected" && "border-destructive bg-destructive/10 text-destructive",
      )}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          status === "connected" && "bg-emerald-500",
          (status === "connecting" || status === "reconnecting") && "animate-pulse bg-amber-500",
          status === "disconnected" && "bg-destructive",
        )}
        aria-hidden="true"
      />
      {COPY[status]}
    </output>
  );
}
