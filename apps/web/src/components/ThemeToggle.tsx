// SPDX-License-Identifier: Apache-2.0

// Light / dark / system toggle. Persists to localStorage. The "system"
// option follows prefers-color-scheme via a media-query listener.
//
// CLAUDE.md forbids localStorage in shared/worker code. Browser-only
// react components are explicitly OK to use it (per the M3 prompt's
// "Resolved decisions" → Dark mode).

import { Button } from "@/components/ui/button";
import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";
const KEY = "loomwiki-theme";

function readStoredTheme(): Theme {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(KEY);
  if (v === "light" || v === "dark" || v === "system") return v;
  return "system";
}

function systemPrefersDark(): boolean {
  if (typeof matchMedia === "undefined") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const stored = readStoredTheme();
    setTheme(stored);
    applyTheme(stored);
  }, []);

  // Re-apply on system pref change while the user has theme=system.
  useEffect(() => {
    if (theme !== "system" || typeof matchMedia === "undefined") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  function set(next: Theme): void {
    setTheme(next);
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, next);
    applyTheme(next);
  }

  return (
    <fieldset
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5"
    >
      <Button
        variant={theme === "light" ? "secondary" : "ghost"}
        size="icon"
        aria-label="Light theme"
        aria-pressed={theme === "light"}
        onClick={() => set("light")}
      >
        <Sun className="size-4" />
      </Button>
      <Button
        variant={theme === "system" ? "secondary" : "ghost"}
        size="icon"
        aria-label="System theme"
        aria-pressed={theme === "system"}
        onClick={() => set("system")}
      >
        <Monitor className="size-4" />
      </Button>
      <Button
        variant={theme === "dark" ? "secondary" : "ghost"}
        size="icon"
        aria-label="Dark theme"
        aria-pressed={theme === "dark"}
        onClick={() => set("dark")}
      >
        <Moon className="size-4" />
      </Button>
    </fieldset>
  );
}
