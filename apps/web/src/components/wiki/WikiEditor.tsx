// SPDX-License-Identifier: Apache-2.0

// Wiki page editor — `client:load` island. v0.0.1 uses a textarea +
// live preview rather than Milkdown's WYSIWYG editor (Astro-island
// hydration of Milkdown's React adapter has SSR friction; the deps
// are installed for the M4.5 swap). Toolbar surface stays minimal:
// bold, italic, code, h1/h2/h3, ul/ol, blockquote, link.
//
// State machine:
//   1. Render with initial { frontmatter, body, sha }.
//   2. Track dirty (edits diverged from initial).
//   3. Save → PUT with before_sha. On 200, swap to the new sha.
//   4. On 409 → MergeDialog with the conflict payload.

import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { FrontmatterEditor } from "@/components/wiki/FrontmatterEditor";
import { FrontmatterPill } from "@/components/wiki/FrontmatterPill";
import { MergeDialog } from "@/components/wiki/MergeDialog";
import { SanitizedMarkdown } from "@/components/wiki/SanitizedMarkdown";
import { ApiError } from "@/lib/api";
import { WikiConflictError, saveWikiPage } from "@/lib/api-wiki";
import type { WikiConflictDetails, WikiPageFrontmatter, WikiPagePayload } from "@/lib/types";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Save,
} from "lucide-react";
import { type ChangeEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export interface WikiEditorProps {
  initialPage: WikiPagePayload;
  onSaved?: (page: WikiPagePayload) => void;
  onCancel?: () => void;
}

function nowIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function WikiEditor({ initialPage, onSaved, onCancel }: WikiEditorProps) {
  const [frontmatter, setFrontmatter] = useState<WikiPageFrontmatter>(initialPage.frontmatter);
  const [body, setBody] = useState(initialPage.body);
  const [sha, setSha] = useState(initialPage.sha);
  const [conflict, setConflict] = useState<WikiConflictDetails | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const dirty = body !== initialPage.body || frontmatter !== initialPage.frontmatter;

  // beforeunload guard — only fires when there are unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  function wrapSelection(prefix: string, suffix = prefix): void {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const next = `${body.slice(0, start)}${prefix}${body.slice(start, end)}${suffix}${body.slice(end)}`;
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + prefix.length, end + prefix.length);
    });
  }

  function prefixLine(prefix: string): void {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const before = body.slice(0, start);
    const lineStart = before.lastIndexOf("\n") + 1;
    const next = `${body.slice(0, lineStart)}${prefix}${body.slice(lineStart)}`;
    setBody(next);
  }

  async function handleSave(): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    try {
      // Empty `sha` ⇒ this is a brand-new page being saved for the
      // first time. Omitting before_sha tells the worker route to
      // treat the request as a create.
      const updated = await saveWikiPage(initialPage.path, {
        frontmatter: { ...frontmatter, last_updated: nowIsoDate() },
        body,
        ...(sha.length > 0 ? { before_sha: sha } : {}),
      });
      setSha(updated.sha);
      setFrontmatter(updated.frontmatter);
      setBody(updated.body);
      onSaved?.(updated);
      toast.success(`Saved ${updated.path}`);
    } catch (err) {
      if (err instanceof WikiConflictError) {
        setConflict(err.details);
      } else {
        const msg =
          err instanceof ApiError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : "Save failed";
        toast.error(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSave();
    }
  }

  async function handleResolve(mergedRaw: string, currentSha: string): Promise<void> {
    // The merged raw is YAML-fenced frontmatter + body — the on-disk
    // shape. Send it as a `raw` write; the worker's gray-matter parser
    // validates the YAML and applies the same Zod schema as the
    // structured path. Malformed YAML surfaces as a 400 with code
    // VALIDATION_FAILED, never a silent corruption.
    try {
      const updated = await saveWikiPage(initialPage.path, {
        raw: mergedRaw,
        before_sha: currentSha,
      });
      setSha(updated.sha);
      setFrontmatter(updated.frontmatter);
      setBody(updated.body);
      setConflict(null);
      onSaved?.(updated);
      toast.success("Conflict resolved");
    } catch (err) {
      if (err instanceof WikiConflictError) {
        setConflict(err.details);
        toast.error("Page changed again — resolve once more");
      } else {
        const msg = err instanceof Error ? err.message : "Save failed";
        toast.error(msg);
      }
    }
  }

  return (
    <article className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-background px-6 py-3">
        <h1 className="text-xl font-semibold">{frontmatter.title || "Untitled"}</h1>
        <FrontmatterPill kind={frontmatter.kind} status={frontmatter.status} />
        <span className="ml-auto text-xs font-mono text-muted-foreground">{initialPage.path}</span>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <Button onClick={handleSave} disabled={submitting} data-testid="wiki-save">
          <Save className="size-4" />
          {submitting ? "Saving…" : "Save"}
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden md:grid-cols-2">
        <section className="flex min-h-0 flex-col overflow-y-auto border-r border-border bg-background p-4">
          <FrontmatterEditor value={frontmatter} onChange={setFrontmatter} />
          <div
            className="mt-4 flex items-center gap-1 rounded-md border border-border bg-secondary/40 p-1"
            role="toolbar"
            aria-label="Editor toolbar"
          >
            <Button size="icon" variant="ghost" onClick={() => wrapSelection("**")} title="Bold">
              <Bold className="size-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => wrapSelection("*")} title="Italic">
              <Italic className="size-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => wrapSelection("`")} title="Code">
              <Code className="size-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => prefixLine("# ")} title="H1">
              <Heading1 className="size-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => prefixLine("## ")} title="H2">
              <Heading2 className="size-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => prefixLine("### ")} title="H3">
              <Heading3 className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => prefixLine("- ")}
              title="Bullet list"
            >
              <List className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => prefixLine("1. ")}
              title="Numbered list"
            >
              <ListOrdered className="size-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => prefixLine("> ")} title="Quote">
              <Quote className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => wrapSelection("[", "](https://)")}
              title="Link"
            >
              <LinkIcon className="size-4" />
            </Button>
          </div>
          <Textarea
            ref={textareaRef}
            value={body}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setBody(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={20}
            className="mt-2 min-h-0 flex-1 font-mono text-sm"
            placeholder="Markdown body…"
            aria-label="Markdown body editor"
            data-testid="wiki-body-input"
          />
        </section>
        <section className="min-h-0 overflow-y-auto bg-background p-6">
          <SanitizedMarkdown source={body} />
          <p className="mt-4 text-xs italic text-muted-foreground">
            Wikilinks like <code>[[page]]</code> render as code-fenced text in v0.0.1; resolvable
            links land in v0.1.
          </p>
        </section>
      </div>

      <MergeDialog details={conflict} onResolve={handleResolve} onClose={() => setConflict(null)} />
      <Toaster />
    </article>
  );
}
