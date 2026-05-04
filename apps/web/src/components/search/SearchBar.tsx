// SPDX-License-Identifier: Apache-2.0

// Header dropdown search. ⌘K / Ctrl+K focuses the input from anywhere on
// the page; Esc closes the dropdown. The query is debounced 200ms before
// hitting /api/search so a fast typist doesn't fire one request per
// keystroke. Click (or Enter on a focused result) navigates to the wiki
// page.
//
// Hydrates `client:idle` — the search box doesn't need to be interactive
// before the active surface is on screen.

import { Input } from "@/components/ui/input";
import { ApiError, AuthRequiredError } from "@/lib/api";
import { searchWiki } from "@/lib/api-search";
import type { WikiSearchMode, WikiSearchResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SearchResults } from "./SearchResults";

const DEBOUNCE_MS = 200;

export interface SearchBarProps {
  className?: string;
}

export function SearchBar({ className }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WikiSearchResult[]>([]);
  const [mode, setMode] = useState<WikiSearchMode>("hybrid");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Sequence number guards against an in-flight request resolving after
  // a newer request — without it, a slow first response could overwrite
  // a faster second.
  const requestSeqRef = useRef(0);

  // Global ⌘K / Ctrl+K hotkey.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const isMeta = ev.metaKey || ev.ctrlKey;
      if (isMeta && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    const onClick = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(ev.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setErrorMsg(null);
      return;
    }
    const mySeq = ++requestSeqRef.current;
    setLoading(true);
    setErrorMsg(null);
    try {
      const data = await searchWiki(trimmed);
      if (mySeq !== requestSeqRef.current) return;
      setResults(data.results);
      setMode(data.mode);
    } catch (err) {
      if (mySeq !== requestSeqRef.current) return;
      if (err instanceof AuthRequiredError) {
        setErrorMsg("Sign in to search.");
      } else if (err instanceof ApiError) {
        if (err.code === "RATE_LIMITED") {
          setErrorMsg("Search rate limit reached — try again later.");
        } else {
          setErrorMsg(err.message || "Search failed.");
        }
      } else {
        setErrorMsg("Search failed.");
      }
      setResults([]);
    } finally {
      if (mySeq === requestSeqRef.current) setLoading(false);
    }
  }, []);

  const onChange = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const next = ev.target.value;
    setQuery(next);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runSearch(next);
    }, DEBOUNCE_MS);
  };

  const onSelect = (path: string) => {
    if (typeof window === "undefined") return;
    const slug = path.replace(/^\/wiki\//, "").replace(/\.md$/, "");
    window.location.href = `/w/${slug}`;
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const showDropdown = open && query.trim().length > 0;

  return (
    <div ref={containerRef} className={cn("relative", className)} data-testid="search-bar">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          type="search"
          aria-label="Search wiki"
          aria-expanded={showDropdown}
          placeholder="Search the wiki  (⌘K)"
          value={query}
          onChange={onChange}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="pl-8"
          data-testid="search-bar-input"
        />
      </div>
      {showDropdown && (
        <div className="absolute right-0 left-0 top-full z-30 mt-1 max-h-[60vh] overflow-y-auto rounded-md border border-border bg-background shadow-lg">
          {loading && results.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">Searching…</p>
          )}
          {errorMsg && (
            <p className="px-3 py-2 text-xs text-destructive" role="alert">
              {errorMsg}
            </p>
          )}
          {!errorMsg && (
            <SearchResults results={results} mode={mode} onSelect={onSelect} variant="compact" />
          )}
        </div>
      )}
    </div>
  );
}
