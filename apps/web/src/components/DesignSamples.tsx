// SPDX-License-Identifier: Apache-2.0

// Single React component that composes every M3 primitive in one tree.
// Lives as a React component (not split across .astro and .jsx) because
// Radix UI primitives use React context that does NOT cross the
// .astro/.jsx boundary in Astro SSR — Avatar/AvatarFallback, Dialog,
// Tooltip, etc. must share a single React tree.
//
// Used by /design only. Not shipped in production routes.

import { RateLimitBanner } from "@/components/RateLimitBanner";
import { CitationPill } from "@/components/ask/CitationPill";
import { ProposalDetail } from "@/components/inbox/ProposalDetail";
import { ProposalsList } from "@/components/inbox/ProposalsList";
import { SearchResults } from "@/components/search/SearchResults";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { FrontmatterPill } from "@/components/wiki/FrontmatterPill";
import type { SerializedProposal, WikiPagePayload } from "@/lib/types";

export interface DesignSamplesProps {
  mode: "light" | "dark";
}

export function DesignSamples({ mode }: DesignSamplesProps) {
  return (
    <div className="space-y-6 rounded-lg border border-border bg-background p-6 text-foreground">
      <h2 className="text-lg font-medium uppercase tracking-wide text-muted-foreground">{mode}</h2>

      <section className="space-y-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">Buttons</p>
        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="accent">Accent</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
        </div>
      </section>

      <Separator />

      <section className="space-y-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">Inputs</p>
        <Input placeholder="Single-line input" />
        <Textarea placeholder="Multi-line textarea" rows={3} />
      </section>

      <Separator />

      <section className="space-y-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">Avatar &amp; skeleton</p>
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarFallback>L</AvatarFallback>
          </Avatar>
          <Skeleton className="h-9 w-32" />
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <p className="text-xs font-medium uppercase text-muted-foreground">Wiki primitives</p>
        <div className="flex flex-wrap items-center gap-2">
          <FrontmatterPill kind="concept" status="draft" />
          <FrontmatterPill kind="decision" status="published" />
          <FrontmatterPill kind="entity" status="superseded" />
          <FrontmatterPill kind="open-question" status="draft" />
          <FrontmatterPill kind="glossary" status="published" />
        </div>
        <div
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700/50 dark:bg-amber-950/30"
          role="alert"
        >
          <p className="font-medium">Conflict — page changed since you opened it.</p>
          <p className="mt-1 text-muted-foreground">
            Resolve via the 3-way merge picker. v0.0.1 does not auto-merge.
          </p>
        </div>
        <div
          className="flex items-center gap-1 rounded-md border border-border bg-secondary/40 p-1"
          role="toolbar"
          aria-label="Edit toolbar sample"
        >
          <Button size="icon" variant="ghost">
            B
          </Button>
          <Button size="icon" variant="ghost">
            <em>i</em>
          </Button>
          <Button size="icon" variant="ghost">
            &lt;/&gt;
          </Button>
          <Separator orientation="vertical" className="h-6" />
          <Button size="sm" variant="ghost">
            Save
          </Button>
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <p className="text-xs font-medium uppercase text-muted-foreground">Citations</p>
        <div className="flex flex-wrap items-center gap-2">
          <CitationPill
            citation={{
              path: "/wiki/concepts/dmarc.md",
              title: "DMARC",
              kind: "concept",
              heading_slug: "alignment",
            }}
          />
          <CitationPill
            citation={{
              path: "/wiki/decisions/0001-mta-sts.md",
              title: "Adopt MTA-STS for inbound",
              kind: "decision",
              heading_slug: null,
            }}
          />
          <CitationPill
            citation={{
              path: "/wiki/glossary/spf.md",
              title: "SPF",
              kind: "glossary",
              heading_slug: null,
            }}
          />
          <CitationPill
            citation={{
              path: "/wiki/open-questions/dkim-key-rotation.md",
              title: "How often should we rotate DKIM keys?",
              kind: "open-question",
              heading_slug: "context",
            }}
          />
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <p className="text-xs font-medium uppercase text-muted-foreground">Rate limit banners</p>
        <RateLimitBanner
          kind="ask"
          details={{
            limit: 50,
            used: 50,
            scope: "user",
            reset_at: "2026-05-05T00:00:00Z",
          }}
        />
        <RateLimitBanner
          kind="search"
          details={{
            limit: 500,
            used: 500,
            scope: "workspace",
            reset_at: "2026-05-05T00:00:00Z",
          }}
        />
      </section>

      <Separator />

      <section className="space-y-3">
        <p className="text-xs font-medium uppercase text-muted-foreground">
          Inbox — proposals list
        </p>
        <div className="rounded-md border border-border">
          <p className="border-b border-border bg-secondary/30 px-3 py-1 text-[11px] uppercase text-muted-foreground">
            Empty state
          </p>
          <ProposalsList proposals={[]} />
        </div>
        <div className="rounded-md border border-border">
          <p className="border-b border-border bg-secondary/30 px-3 py-1 text-[11px] uppercase text-muted-foreground">
            Populated
          </p>
          <ProposalsList proposals={[CREATE_PROPOSAL_SAMPLE, UPDATE_PROPOSAL_SAMPLE]} />
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <p className="text-xs font-medium uppercase text-muted-foreground">
          Inbox — proposal detail (create)
        </p>
        <div className="h-96 overflow-hidden rounded-md border border-border">
          <ProposalDetail proposal={CREATE_PROPOSAL_SAMPLE} currentPage={null} />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-xs font-medium uppercase text-muted-foreground">
          Inbox — proposal detail (update with current page)
        </p>
        <div className="h-96 overflow-hidden rounded-md border border-border">
          <ProposalDetail proposal={UPDATE_PROPOSAL_SAMPLE} currentPage={CURRENT_PAGE_SAMPLE} />
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <p className="text-xs font-medium uppercase text-muted-foreground">Search empty states</p>
        <div className="rounded-md border border-border">
          <p className="border-b border-border bg-secondary/30 px-3 py-1 text-[11px] uppercase text-muted-foreground">
            mode = hybrid
          </p>
          <SearchResults results={[]} mode="hybrid" onSelect={() => undefined} variant="full" />
        </div>
        <div className="rounded-md border border-border">
          <p className="border-b border-border bg-secondary/30 px-3 py-1 text-[11px] uppercase text-muted-foreground">
            mode = fts5_fallback
          </p>
          <SearchResults
            results={[]}
            mode="fts5_fallback"
            onSelect={() => undefined}
            variant="full"
          />
        </div>
      </section>
    </div>
  );
}

// ---------- Inbox sample data (M7) ----------

const CREATE_PROPOSAL_SAMPLE: SerializedProposal = {
  id: "01970000-0000-7000-8000-000000000010",
  run_id: "01970000-0000-7000-8000-000000000020",
  page_path: "/wiki/decisions/2026-05-dmarc-rollout.md",
  action: "create",
  before_sha: null,
  after_content: `---
title: DMARC Rollout
kind: decision
created: 2026-05-04
last_updated: 2026-05-04
status: draft
---

# DMARC Rollout

## Context

The team discussed moving from \`p=none\` to \`p=quarantine\` for K-12 tenants.

## Decision

Approved — staged rollout starting Friday.

## Consequences

- Immediate: spam folders see legitimate-but-misaligned mail.
- Long term: vendor cleanup pressure increases.
`,
  rationale:
    "Two messages established this as an explicit team decision, with rollout date and consequences discussed.",
  status: "pending",
  created_at: new Date(Date.now() - 1000 * 60 * 17).toISOString(),
  reviewed_at: null,
  reviewed_by: null,
  artifacts_commit: null,
};

const UPDATE_PROPOSAL_SAMPLE: SerializedProposal = {
  id: "01970000-0000-7000-8000-000000000011",
  run_id: "01970000-0000-7000-8000-000000000020",
  page_path: "/wiki/concepts/spf.md",
  action: "update",
  before_sha: "deadbeef".repeat(8),
  after_content: `---
title: SPF
kind: concept
created: 2026-04-12
last_updated: 2026-05-04
status: published
---

# SPF

Sender Policy Framework. Authorized-sender allowlist published in DNS.

## Common pitfalls

- 10-lookup limit — flatten with subzones if you exceed.
- Forwarding strips alignment without ARC.
`,
  rationale: "New section on common pitfalls; flagged via two messages this morning.",
  status: "pending",
  created_at: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
  reviewed_at: null,
  reviewed_by: null,
  artifacts_commit: null,
};

const CURRENT_PAGE_SAMPLE: WikiPagePayload = {
  path: "/wiki/concepts/spf.md",
  frontmatter: {
    title: "SPF",
    kind: "concept",
    created: "2026-04-12",
    last_updated: "2026-04-12",
    status: "published",
  },
  body: "# SPF\n\nSender Policy Framework. Authorized-sender allowlist published in DNS.",
  sha: "deadbeef".repeat(8),
};
