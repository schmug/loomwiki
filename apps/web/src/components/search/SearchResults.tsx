// SPDX-License-Identifier: Apache-2.0

// Shared result list for the header SearchBar dropdown and the full
// SearchPage. Renders title + kind pill + path + snippet. The snippet
// arrives with `<mark>...</mark>` tags around matched terms (FTS5
// emits these); we convert them to React `<mark>` elements via a
// string→fragment helper so we never touch innerHTML.

import { FrontmatterPill } from "@/components/wiki/FrontmatterPill";
import type { WikiSearchMode, WikiSearchResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Fragment } from "react";

export interface SearchResultsProps {
  results: WikiSearchResult[];
  mode: WikiSearchMode;
  /** Called with the wiki path (`/wiki/...md`) when a result is activated. */
  onSelect: (path: string) => void;
  /** Optional className on the outer list. */
  className?: string;
  /** Compact = header dropdown, full = SearchPage. */
  variant?: "compact" | "full";
}

export function SearchResults({
  results,
  mode,
  onSelect,
  className,
  variant = "compact",
}: SearchResultsProps) {
  if (results.length === 0) {
    return <EmptyState mode={mode} className={cn(variant === "full" ? "p-6" : "p-3", className)} />;
  }

  return (
    <ul className={cn("divide-y divide-border", className)} data-testid="search-results">
      {mode === "fts5_fallback" && (
        <li className="bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Showing keyword matches only — semantic search is unavailable.
        </li>
      )}
      {results.map((r) => (
        <li key={r.path}>
          <button
            type="button"
            data-testid="search-result"
            data-path={r.path}
            onClick={() => onSelect(r.path)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onSelect(r.path);
              }
            }}
            className="flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-hidden"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{r.title}</span>
              <FrontmatterPill kind={r.kind} status="published" className="opacity-80" />
              <span className="ml-auto text-[11px] font-mono text-muted-foreground">{r.path}</span>
            </div>
            <p className="text-xs text-muted-foreground">{renderSnippet(r.snippet)}</p>
          </button>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ mode, className }: { mode: WikiSearchMode; className?: string }) {
  return (
    <div
      className={cn("text-center text-xs text-muted-foreground", className)}
      data-testid="search-empty"
    >
      <p>No matches.</p>
      {mode === "fts5_fallback" && (
        <p className="mt-1 text-[11px]">
          Showing keyword matches only — semantic search is unavailable.
        </p>
      )}
    </div>
  );
}

/**
 * Convert `Hello <mark>DMARC</mark> world` → `[ "Hello ", <mark>DMARC</mark>, " world" ]`
 * without touching innerHTML. We accept ONLY `<mark>` and `</mark>`; any
 * other tag in the snippet renders as literal text. This is intentional —
 * the snippet field is the only place the worker ships HTML, and it ships
 * exactly that one tag.
 */
function renderSnippet(snippet: string) {
  if (!snippet.includes("<mark>")) return snippet;
  const parts: Array<string | { mark: string }> = [];
  let cursor = 0;
  // Manual scan: cheaper + more predictable than regex on snippets that
  // could contain stray angle brackets in code samples.
  while (cursor < snippet.length) {
    const openIdx = snippet.indexOf("<mark>", cursor);
    if (openIdx === -1) {
      parts.push(snippet.slice(cursor));
      break;
    }
    if (openIdx > cursor) parts.push(snippet.slice(cursor, openIdx));
    const closeIdx = snippet.indexOf("</mark>", openIdx + "<mark>".length);
    if (closeIdx === -1) {
      // Unterminated mark — treat the rest as plain text rather than
      // dropping it.
      parts.push(snippet.slice(openIdx));
      break;
    }
    parts.push({ mark: snippet.slice(openIdx + "<mark>".length, closeIdx) });
    cursor = closeIdx + "</mark>".length;
  }
  return parts.map((part, i) => {
    // Compose a stable key from the segment kind, index, and a content
    // prefix. The parts array is the result of a deterministic parse on
    // a static `snippet` string — order doesn't shift, but combining
    // index + content avoids the `noArrayIndexKey` false positive while
    // remaining unique enough for repeated identical segments.
    if (typeof part === "string") {
      const key = `t-${i}-${part.slice(0, 8)}`;
      return <Fragment key={key}>{part}</Fragment>;
    }
    const key = `m-${i}-${part.mark.slice(0, 8)}`;
    return (
      <mark
        key={key}
        className="rounded bg-amber-200 px-0.5 text-amber-950 dark:bg-amber-700/50 dark:text-amber-100"
      >
        {part.mark}
      </mark>
    );
  });
}
