// SPDX-License-Identifier: Apache-2.0

// Side-by-side proposal review pane. Left: current wiki page (only
// rendered for `update` actions). Right: proposed page. Both flow
// through the shared sanitizer pipeline. Footer carries Merge / Reject
// buttons gated server-side (admin-merge-only — defense layer 5).
//
// Conflict handling: a 409 from POST /merge surfaces the M4 merge
// dialog payload; we re-render the dialog as a banner directing the
// user to resolve in the wiki editor. v0.0.1 doesn't auto-merge inside
// the inbox — operators are nudged to the canonical M4 merge surface.

import { Button } from "@/components/ui/button";
import { SanitizedMarkdown } from "@/components/wiki/SanitizedMarkdown";
import { ApiError } from "@/lib/api";
import { mergeProposal, rejectProposal } from "@/lib/api-inbox";
import type { SerializedProposal, WikiPagePayload } from "@/lib/types";
import { useState } from "react";

export interface ProposalDetailProps {
  proposal: SerializedProposal;
  /** Current wiki page if `action === 'update'`. Null otherwise. */
  currentPage: WikiPagePayload | null;
}

type ActionState =
  | { kind: "idle" }
  | { kind: "merging" }
  | { kind: "rejecting" }
  | { kind: "merged"; pagePath: string }
  | { kind: "rejected" }
  | { kind: "conflict"; pagePath: string }
  | { kind: "error"; message: string };

export function ProposalDetail({ proposal, currentPage }: ProposalDetailProps) {
  const [state, setState] = useState<ActionState>({ kind: "idle" });

  async function onMerge(): Promise<void> {
    setState({ kind: "merging" });
    try {
      const beforeSha = currentPage?.sha;
      const result = await mergeProposal(proposal.id, beforeSha);
      setState({ kind: "merged", pagePath: result.page_path });
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFLICT") {
        setState({ kind: "conflict", pagePath: proposal.page_path });
        return;
      }
      const message = err instanceof Error ? err.message : "merge failed";
      setState({ kind: "error", message });
    }
  }

  async function onReject(): Promise<void> {
    setState({ kind: "rejecting" });
    try {
      await rejectProposal(proposal.id);
      setState({ kind: "rejected" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "reject failed";
      setState({ kind: "error", message });
    }
  }

  return (
    <article className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border bg-secondary/30 px-6 py-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="rounded-md bg-accent/20 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-accent-foreground">
            {proposal.action}
          </span>
          <code className="font-mono text-sm">{proposal.page_path}</code>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{proposal.rationale}</p>
      </header>

      <ActionBanner state={state} />

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        {proposal.action === "update" && (
          <section className="min-h-0 overflow-y-auto border-r border-border p-6">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Current
            </h2>
            {currentPage === null ? (
              <p className="text-sm italic text-muted-foreground">
                No current page (was the path created and then deleted before review?)
              </p>
            ) : (
              <SanitizedMarkdown source={currentPage.body} />
            )}
          </section>
        )}
        <section
          className={`min-h-0 overflow-y-auto p-6 ${
            proposal.action === "update" ? "" : "lg:col-span-2"
          }`}
        >
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Proposed
          </h2>
          {/* Render `after_content` as raw text for the body — the agent's
              after_content is the on-disk YAML page including frontmatter,
              so the cleanest preview is the rendered markdown body. */}
          <SanitizedMarkdown source={extractBodyFromRaw(proposal.after_content)} />
        </section>
      </div>

      <footer className="flex items-center gap-3 border-t border-border bg-secondary/20 px-6 py-3">
        <Button
          onClick={onMerge}
          disabled={isBusy(state) || isTerminal(state)}
          aria-busy={state.kind === "merging"}
        >
          {state.kind === "merging" ? "Merging…" : "Merge"}
        </Button>
        <Button
          onClick={onReject}
          variant="outline"
          disabled={isBusy(state) || isTerminal(state)}
          aria-busy={state.kind === "rejecting"}
        >
          {state.kind === "rejecting" ? "Rejecting…" : "Reject"}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          Created {new Date(proposal.created_at).toLocaleString()}
        </span>
      </footer>
    </article>
  );
}

function isBusy(state: ActionState): boolean {
  return state.kind === "merging" || state.kind === "rejecting";
}

function isTerminal(state: ActionState): boolean {
  return state.kind === "merged" || state.kind === "rejected";
}

function ActionBanner({ state }: { state: ActionState }) {
  switch (state.kind) {
    case "idle":
    case "merging":
    case "rejecting":
      return null;
    case "merged":
      return (
        <output className="block border-b border-border bg-emerald-50 px-6 py-2 text-sm text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
          Merged. The wiki page <code className="font-mono">{state.pagePath}</code> is now live.{" "}
          <a className="underline" href={`/w${state.pagePath.replace(/^\/wiki/, "")}`}>
            View
          </a>
        </output>
      );
    case "rejected":
      return (
        <output className="block border-b border-border bg-secondary/40 px-6 py-2 text-sm text-muted-foreground">
          Proposal rejected.{" "}
          <a className="underline" href="/inbox">
            Back to inbox
          </a>
        </output>
      );
    case "conflict":
      return (
        <div
          role="alert"
          className="border-b border-border bg-amber-50 px-6 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        >
          The wiki page changed since this proposal was generated. Open the page in the wiki editor
          to resolve via 3-way merge:{" "}
          <a className="underline" href={`/w${state.pagePath.replace(/^\/wiki/, "")}`}>
            {state.pagePath}
          </a>
        </div>
      );
    case "error":
      return (
        <div
          role="alert"
          className="border-b border-border bg-red-50 px-6 py-2 text-sm text-red-900 dark:bg-red-950/30 dark:text-red-200"
        >
          Action failed: {state.message}
        </div>
      );
  }
}

/**
 * Strip the YAML frontmatter fence so the previewed body matches what
 * the wiki viewer would render. If no fence is present the raw text is
 * returned unchanged.
 */
function extractBodyFromRaw(raw: string): string {
  const match = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match?.[1] ?? raw;
}
