// SPDX-License-Identifier: Apache-2.0

// Modal: pick slug + kind for a new page. Generates the path under
// /wiki/, navigates to the editor at that path. We do NOT eagerly
// create the page on the worker — the editor's first save creates it
// (the prompt's "default empty body" / "don't pre-populate placeholder
// text" rule).

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { WikiPageKind } from "@/lib/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";

const KIND_TO_PARENT: Record<WikiPageKind, string> = {
  entity: "entities",
  decision: "decisions",
  concept: "concepts",
  "open-question": "questions",
  glossary: "glossary",
};

const KINDS: WikiPageKind[] = ["entity", "decision", "concept", "open-question", "glossary"];

const SLUG_REGEX = /^[a-z][a-z0-9-]{0,59}$/;

// Each path segment in the navigation target must be a known-safe
// kebab-case-or-underscore identifier. Defense-in-depth alongside
// SLUG_REGEX so any future change to the kind→folder map can't
// smuggle uppercase / dots / encoded chars into the URL builder.
const SAFE_PATH_SEGMENT = /^[a-z0-9_][a-z0-9_-]{0,59}$/;

export interface NewPageDialogProps {
  existingPaths: string[];
  trigger: ReactNode;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function NewPageDialog({ existingPaths, trigger }: NewPageDialogProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [kind, setKind] = useState<WikiPageKind>("concept");

  const effectiveSlug = slugTouched ? slug : slugify(title);
  const path = effectiveSlug ? `/wiki/${KIND_TO_PARENT[kind]}/${effectiveSlug}.md` : "";
  const isDuplicate = path !== "" && existingPaths.includes(path);
  const isValid = SLUG_REGEX.test(effectiveSlug);

  function reset(): void {
    setTitle("");
    setSlug("");
    setSlugTouched(false);
    setKind("concept");
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (!isValid) {
      toast.error("Slug must be kebab-case, ≤60 chars");
      return;
    }
    if (isDuplicate) {
      toast.error(`A page already exists at ${path}`);
      return;
    }
    // Navigate to /w/<slug-path>?new=1&… — the [...path] route 404s
    // and renders the create-this-page CTA, opening the editor with
    // the seeded frontmatter.
    //
    // Every user-controlled fragment of the URL is escaped via
    // encodeURIComponent (a CodeQL-recognized sanitizer for
    // js/xss-through-dom). The slug segments are *also* asserted to
    // match SAFE_PATH_SEGMENT first — defense-in-depth so a future
    // change to the kind→folder map can't smuggle uppercase / dots /
    // encoded chars into the URL builder.
    const slugPath = path.replace(/^\/wiki/, "").replace(/\.md$/, "");
    const slugSegments = slugPath.split("/").filter((s) => s.length > 0);
    if (!slugSegments.every((s) => SAFE_PATH_SEGMENT.test(s))) {
      toast.error("Slug path contains unsafe characters");
      return;
    }
    const safePath = slugSegments.map(encodeURIComponent).join("/");
    const safeTitle = encodeURIComponent(title);
    const safeKind = encodeURIComponent(kind);
    const url = `/w/${safePath}?new=1&title=${safeTitle}&kind=${safeKind}`;
    window.location.assign(url);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New wiki page</DialogTitle>
          <DialogDescription>
            Pick a title, slug, and kind. The page is committed to the vault on first save.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="new-title" className="text-sm font-medium">
              Title
            </label>
            <Input
              id="new-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="DMARC"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="new-slug" className="text-sm font-medium">
              Slug
            </label>
            <Input
              id="new-slug"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              placeholder="dmarc"
              pattern="^[a-z][a-z0-9-]{0,59}$"
            />
            <p className="text-xs text-muted-foreground">
              {path ? <code>{path}</code> : "Path appears after you pick a slug"}
              {isDuplicate && <span className="ml-2 text-destructive">— already exists</span>}
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor="new-kind" className="text-sm font-medium">
              Kind
            </label>
            <select
              id="new-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as WikiPageKind)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!isValid || isDuplicate}>
              Create &amp; edit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
