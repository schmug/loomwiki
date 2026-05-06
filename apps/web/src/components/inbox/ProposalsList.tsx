// SPDX-License-Identifier: Apache-2.0

// Pending-proposal list. Hydrates server-rendered data so the empty
// and populated states ship without JS, then a lightweight
// rerender-after-action keeps the count fresh after a merge or reject
// performed from the detail page (via a navigation back to /inbox).

import type { ProposalAction, SerializedProposal } from "@/lib/types";
import { FilePen, FilePlus } from "lucide-react";

export interface ProposalsListProps {
  proposals: SerializedProposal[];
}

const ACTION_LABEL: Record<ProposalAction, string> = {
  create: "Create",
  update: "Update",
};

export function ProposalsList({ proposals }: ProposalsListProps) {
  if (proposals.length === 0) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Inbox is empty</h2>
          <p className="text-sm text-muted-foreground">
            No pending proposals. Trigger an ingest run from a chat room or wait for the daily 03:00
            UTC scan.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ul aria-label="Pending proposals" className="divide-y divide-border">
      {proposals.map((p) => (
        <li key={p.id}>
          <a
            href={`/inbox/proposals/${p.id}`}
            className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-secondary/40"
          >
            <span aria-hidden="true" className="mt-0.5 text-muted-foreground">
              {p.action === "create" ? (
                <FilePlus className="size-4" />
              ) : (
                <FilePen className="size-4" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-2 text-sm">
                <span className="font-medium">{ACTION_LABEL[p.action]}</span>
                <code className="truncate font-mono text-xs text-muted-foreground">
                  {p.page_path}
                </code>
              </p>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.rationale}</p>
            </div>
            <time
              className="ml-auto shrink-0 text-[11px] text-muted-foreground"
              dateTime={p.created_at}
            >
              {formatRelative(p.created_at)}
            </time>
          </a>
        </li>
      ))}
    </ul>
  );
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
