// SPDX-License-Identifier: Apache-2.0
// Pre-paint theme application. Reads localStorage and sets `class="dark"`
// on <html> before React hydration so users don't see a flash of wrong
// theme. Served from /public so CSP `script-src 'self'` allows it.
(() => {
  try {
    const stored = localStorage.getItem("loomwiki-theme");
    const dark =
      stored === "dark" ||
      ((stored === "system" || stored === null) &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
  } catch (_e) {
    // localStorage may throw in private mode; fall through with no class.
  }
})();
