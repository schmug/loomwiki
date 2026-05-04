// SPDX-License-Identifier: Apache-2.0

// Surfaced when /api/ask or /api/search returns 429 RATE_LIMITED. Reads
// the typed `details` payload off the ApiError. Two scopes (user vs
// workspace) get distinct copy because operator-shared budgets are a
// different mental model from a personal cap.

import type { RateLimitDetails } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface RateLimitBannerProps {
  details: RateLimitDetails;
  /** What the user was trying to do — selects the noun in the copy. */
  kind?: "ask" | "search";
  className?: string;
}

export function RateLimitBanner({ details, kind = "ask", className }: RateLimitBannerProps) {
  const noun = kind === "ask" ? "ask" : "search";
  const scopeLabel = details.scope === "workspace" ? "workspace-wide" : "personal";
  const resetLocal = formatResetTime(details.reset_at);

  return (
    <div
      role="alert"
      data-testid="rate-limit-banner"
      className={cn(
        "rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-100",
        className,
      )}
    >
      <p className="font-medium">
        You've reached your daily limit of {details.limit} {scopeLabel} {noun} queries.
      </p>
      <p className="mt-1 text-amber-900/80 dark:text-amber-200/80">
        Resets at midnight UTC ({resetLocal}).
      </p>
    </div>
  );
}

function formatResetTime(isoOrNumeric: string): string {
  const d = new Date(isoOrNumeric);
  if (Number.isNaN(d.getTime())) return isoOrNumeric;
  return d.toLocaleString();
}
