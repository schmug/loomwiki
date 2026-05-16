// SPDX-License-Identifier: Apache-2.0

// Top bar React island. Owns the mobile-sidebar toggle (which mutates
// a CSS variable on <html>), the workspace name, and the theme toggle.
// Hydrates with client:load alongside the sidebar so the toggle works
// on first paint.

import { ThemeToggle } from "@/components/ThemeToggle";
import { SearchBar } from "@/components/search/SearchBar";
import { Button } from "@/components/ui/button";
import { Menu } from "lucide-react";
import { useEffect, useState } from "react";

export interface AppShellHeaderProps {
  workspaceName: string;
  userDisplayName: string;
}

const SIDEBAR_OPEN_ATTR = "data-sidebar-open";

export function AppShellHeader({ workspaceName, userDisplayName }: AppShellHeaderProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute(SIDEBAR_OPEN_ATTR, open ? "true" : "false");
  }, [open]);

  // Keep React state in sync when external code (backdrop/nav-link handler)
  // sets data-sidebar-open directly on <html> without going through setOpen.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const observer = new MutationObserver(() => {
      const val = document.documentElement.getAttribute(SIDEBAR_OPEN_ATTR);
      setOpen(val === "true");
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [SIDEBAR_OPEN_ATTR],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border bg-background px-3 py-2">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Toggle navigation"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="md:hidden"
      >
        <Menu className="size-4" />
      </Button>
      <a
        href="/"
        className="flex items-center gap-2 text-sm font-semibold focus-visible:outline-hidden"
      >
        <span className="size-2 rounded-full bg-accent" aria-hidden="true" />
        Loomwiki
      </a>
      <span className="hidden text-xs text-muted-foreground sm:inline">{workspaceName}</span>
      <div className="hidden flex-1 px-4 md:block lg:max-w-md">
        <SearchBar />
      </div>
      <div className="ml-auto flex items-center gap-3">
        <span className="hidden text-xs text-muted-foreground sm:inline">
          Signed in as <span className="text-foreground">{userDisplayName}</span>
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}
