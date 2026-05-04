// SPDX-License-Identifier: Apache-2.0

// Inline frontmatter form. Lives inside the WikiEditor surface so the
// editor owns all save state in one component (Radix-context constraint
// from M3 — split components don't share React context across slots).

import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { WikiPageFrontmatter, WikiPageKind, WikiPageStatus } from "@/lib/types";

const KINDS: WikiPageKind[] = ["entity", "decision", "concept", "open-question", "glossary"];
const STATUSES: WikiPageStatus[] = ["draft", "published", "superseded"];

export interface FrontmatterEditorProps {
  value: WikiPageFrontmatter;
  onChange: (next: WikiPageFrontmatter) => void;
}

export function FrontmatterEditor({ value, onChange }: FrontmatterEditorProps) {
  function patch(p: Partial<WikiPageFrontmatter>): void {
    onChange({ ...value, ...p });
  }

  return (
    <div className="space-y-4 rounded-md border border-border bg-secondary/40 p-4">
      <div className="space-y-1">
        <label
          htmlFor="wiki-fm-title"
          className="text-xs font-medium uppercase text-muted-foreground"
        >
          Title
        </label>
        <Input
          id="wiki-fm-title"
          value={value.title}
          onChange={(e) => patch({ title: e.target.value })}
          maxLength={200}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label
            htmlFor="wiki-fm-kind"
            className="text-xs font-medium uppercase text-muted-foreground"
          >
            Kind
          </label>
          <select
            id="wiki-fm-kind"
            value={value.kind}
            onChange={(e) => patch({ kind: e.target.value as WikiPageKind })}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label
            htmlFor="wiki-fm-status"
            className="text-xs font-medium uppercase text-muted-foreground"
          >
            Status
          </label>
          <select
            id="wiki-fm-status"
            value={value.status}
            onChange={(e) => patch({ status: e.target.value as WikiPageStatus })}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {value.status === "superseded" && (
        <div className="space-y-1">
          <label
            htmlFor="wiki-fm-superseded-by"
            className="text-xs font-medium uppercase text-muted-foreground"
          >
            Superseded by (path)
          </label>
          <Input
            id="wiki-fm-superseded-by"
            value={value.superseded_by ?? ""}
            onChange={(e) => patch({ superseded_by: e.target.value || undefined })}
            placeholder="/wiki/decisions/2026-05-replacement.md"
            maxLength={256}
          />
        </div>
      )}

      <Separator />

      <div className="grid grid-cols-2 gap-4 text-xs text-muted-foreground">
        <div>
          <span className="font-medium uppercase">Created</span>
          <span className="ml-2 font-mono">{value.created}</span>
        </div>
        <div>
          <span className="font-medium uppercase">Last updated</span>
          <span className="ml-2 font-mono">{value.last_updated}</span>
        </div>
      </div>
    </div>
  );
}
