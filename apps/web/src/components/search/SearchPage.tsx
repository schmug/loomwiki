// SPDX-License-Identifier: Apache-2.0

// Full-page search at /search. Same data flow as the header SearchBar
// (debounced POST /api/search) but with breathing room and the rate-limit
// banner inline (the header dropdown only shows a one-line error since
// the dropdown is too cramped for the full banner).

import { Input } from "@/components/ui/input";
import { ApiError, AuthRequiredError } from "@/lib/api";
import { searchWiki } from "@/lib/api-search";
import type { RateLimitDetails, WikiSearchMode, WikiSearchResult } from "@/lib/types";
import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { RateLimitBanner } from "../RateLimitBanner";
import { SearchResults } from "./SearchResults";

const DEBOUNCE_MS = 200;

export function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WikiSearchResult[]>([]);
  const [mode, setMode] = useState<WikiSearchMode>("hybrid");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimitDetails | null>(null);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setSearched(false);
      setErrorMsg(null);
      setRateLimit(null);
      return;
    }
    const mySeq = ++requestSeqRef.current;
    setLoading(true);
    setErrorMsg(null);
    setRateLimit(null);
    try {
      const data = await searchWiki(trimmed);
      if (mySeq !== requestSeqRef.current) return;
      setResults(data.results);
      setMode(data.mode);
      setSearched(true);
    } catch (err) {
      if (mySeq !== requestSeqRef.current) return;
      if (err instanceof AuthRequiredError) {
        setErrorMsg("Sign in to search.");
      } else if (err instanceof ApiError && err.code === "RATE_LIMITED") {
        const details = err.details as RateLimitDetails | undefined;
        if (details && typeof details.limit === "number") {
          setRateLimit(details);
        } else {
          setErrorMsg("Search rate limit reached.");
        }
      } else if (err instanceof ApiError) {
        setErrorMsg(err.message || "Search failed.");
      } else {
        setErrorMsg("Search failed.");
      }
      setResults([]);
    } finally {
      if (mySeq === requestSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const onChange = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const next = ev.target.value;
    setQuery(next);
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

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Search</h1>
        <p className="text-sm text-muted-foreground">
          Find pages by title, content, or concept. Hybrid semantic + keyword search when AI Search
          is online; keyword-only otherwise.
        </p>
      </header>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          autoFocus
          type="search"
          aria-label="Search wiki"
          placeholder="Search the wiki…"
          value={query}
          onChange={onChange}
          className="pl-9"
          data-testid="search-page-input"
        />
      </div>
      {rateLimit && <RateLimitBanner details={rateLimit} kind="search" />}
      {errorMsg && (
        <p className="text-sm text-destructive" role="alert">
          {errorMsg}
        </p>
      )}
      {loading && results.length === 0 && (
        <p className="text-sm text-muted-foreground">Searching…</p>
      )}
      {searched && !errorMsg && !rateLimit && (
        <div className="rounded-md border border-border">
          <SearchResults results={results} mode={mode} onSelect={onSelect} variant="full" />
        </div>
      )}
    </div>
  );
}
