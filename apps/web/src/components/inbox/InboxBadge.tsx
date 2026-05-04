// SPDX-License-Identifier: Apache-2.0

// Sidebar badge surfacing the count of pending proposals. Polls the
// `count=true` shape every 60s — small enough to feel live, infrequent
// enough that an idle workspace doesn't burn worker invocations. The
// badge renders nothing when count is 0 so the sidebar stays clean.

import { ApiError } from "@/lib/api";
import { countProposals } from "@/lib/api-inbox";
import { useEffect, useState } from "react";

const POLL_MS = 60_000;

export interface InboxBadgeProps {
  /** Optional initial count provided by the SSR pass. */
  initialCount?: number;
}

export function InboxBadge({ initialCount }: InboxBadgeProps) {
  const [count, setCount] = useState<number | null>(
    typeof initialCount === "number" ? initialCount : null,
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick(): Promise<void> {
      try {
        const result = await countProposals("pending");
        if (cancelled) return;
        setCount(result.count);
      } catch (err) {
        // 401 → AuthRequiredError; let the page-level redirect handle.
        // Other errors → leave the previous count in place so the
        // badge doesn't blink on a transient blip.
        if (cancelled) return;
        if (err instanceof ApiError && err.code !== "RATE_LIMITED") {
          // Quiet — the inbox tab still shows.
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(tick, POLL_MS);
        }
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  if (count === null || count === 0) return null;

  return (
    <output
      aria-label={`${count} pending proposal${count === 1 ? "" : "s"}`}
      className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-medium text-accent-foreground"
    >
      {count > 99 ? "99+" : count}
    </output>
  );
}
