// SPDX-License-Identifier: Apache-2.0

// Sidebar wiki tree. `client:idle` — sidebar isn't on the latency hot
// path. Pages are rendered as a flat list grouped by their first path
// segment under /wiki/. New-page button opens NewPageDialog.

import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { NewPageDialog } from "@/components/wiki/NewPageDialog";
import { ApiError } from "@/lib/api";
import { fetchWikiTree } from "@/lib/api-wiki";
import { cn } from "@/lib/utils";
import { ChevronRight, FileText, FolderOpen, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

export interface WikiTreeProps {
  /** Initial tree from SSR; the component refetches on focus. */
  initialPaths: string[];
  /** Path of the current page so we can highlight + auto-expand. */
  currentPath?: string;
}

interface FolderNode {
  type: "folder";
  name: string;
  fullPath: string;
  children: TreeNode[];
}

interface FileNode {
  type: "file";
  name: string;
  fullPath: string;
}

type TreeNode = FolderNode | FileNode;

function buildTree(paths: string[]): TreeNode[] {
  // paths look like "/wiki/concepts/dmarc.md" — strip the leading
  // "/wiki/" so the tree root is the wiki itself.
  const root: FolderNode = { type: "folder", name: "wiki", fullPath: "/wiki", children: [] };
  for (const path of paths) {
    const stripped = path.replace(/^\/wiki\//, "");
    const parts = stripped.split("/");
    let cursor: FolderNode = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === undefined) continue;
      const isLast = i === parts.length - 1;
      if (isLast) {
        cursor.children.push({ type: "file", name: part, fullPath: path });
      } else {
        let next = cursor.children.find(
          (c): c is FolderNode => c.type === "folder" && c.name === part,
        );
        if (!next) {
          next = {
            type: "folder",
            name: part,
            fullPath: `${cursor.fullPath}/${part}`,
            children: [],
          };
          cursor.children.push(next);
        }
        cursor = next;
      }
    }
  }
  // Sort: folders first, then files, both alphabetical.
  function sort(node: FolderNode): void {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of node.children) {
      if (child.type === "folder") sort(child);
    }
  }
  sort(root);
  return root.children;
}

function pathHrefFor(vaultPath: string): string {
  // "/wiki/concepts/dmarc.md" → "/w/concepts/dmarc"
  return `/w${vaultPath.replace(/^\/wiki/, "").replace(/\.md$/, "")}`;
}

export function WikiTree({ initialPaths, currentPath }: WikiTreeProps) {
  const [paths, setPaths] = useState<string[]>(initialPaths);
  const [open, setOpen] = useState<Set<string>>(() => {
    // Auto-expand the ancestors of the current page.
    const init = new Set<string>(["/wiki"]);
    if (currentPath) {
      const stripped = currentPath.replace(/^\/wiki\//, "");
      const parts = stripped.split("/");
      let cursor = "/wiki";
      for (const part of parts.slice(0, -1)) {
        cursor = `${cursor}/${part}`;
        init.add(cursor);
      }
    }
    return init;
  });

  const tree = useMemo(() => buildTree(paths), [paths]);

  useEffect(() => {
    function refetch(): void {
      void fetchWikiTree()
        .then((res) => setPaths(res.paths))
        .catch((err) => {
          if (err instanceof ApiError) toast.error(err.message);
        });
    }
    window.addEventListener("focus", refetch);
    return () => window.removeEventListener("focus", refetch);
  }, []);

  function toggle(path: string): void {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <nav
      aria-label="Wiki pages"
      className="flex h-full min-h-0 flex-col bg-secondary text-secondary-foreground"
    >
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Wiki
        </h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tree.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            No pages yet. Click "New page" below to create the first one.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {tree.map((node) => (
              <TreeNodeView
                key={node.fullPath}
                node={node}
                depth={0}
                openSet={open}
                toggle={toggle}
                currentPath={currentPath}
              />
            ))}
          </ul>
        )}
      </div>
      <footer className="border-t border-border p-2">
        <NewPageDialog
          existingPaths={paths}
          trigger={
            <Button variant="ghost" size="sm" className="w-full justify-start">
              <Plus className="size-4" />
              New page
            </Button>
          }
        />
      </footer>
      <Toaster />
    </nav>
  );
}

interface TreeNodeViewProps {
  node: TreeNode;
  depth: number;
  openSet: Set<string>;
  toggle: (path: string) => void;
  currentPath: string | undefined;
}

function TreeNodeView({ node, depth, openSet, toggle, currentPath }: TreeNodeViewProps) {
  if (node.type === "folder") {
    const isOpen = openSet.has(node.fullPath);
    return (
      <li>
        <button
          type="button"
          onClick={() => toggle(node.fullPath)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-background/60"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          aria-expanded={isOpen}
        >
          <ChevronRight
            className={cn("size-3 shrink-0 transition-transform", isOpen && "rotate-90")}
          />
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen && (
          <ul className="space-y-0.5">
            {node.children.map((child) => (
              <TreeNodeView
                key={child.fullPath}
                node={child}
                depth={depth + 1}
                openSet={openSet}
                toggle={toggle}
                currentPath={currentPath}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }
  const isActive = node.fullPath === currentPath;
  return (
    <li>
      <a
        href={pathHrefFor(node.fullPath)}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors",
          isActive ? "bg-accent/20 font-medium text-accent-foreground" : "hover:bg-background/60",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        aria-current={isActive ? "page" : undefined}
      >
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{node.name.replace(/\.md$/, "")}</span>
      </a>
    </li>
  );
}
