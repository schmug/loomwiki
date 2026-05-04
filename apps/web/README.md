# `@loomwiki/web` — frontend

Astro 5 (server-rendered) + React 19 islands + Tailwind v4 +
shadcn-flavored primitives, behind Cloudflare Access. The Astro dev
server proxies `/api/*` to the worker on port 8788; in production both
sides ship via the worker (split-origin or single-origin is documented
in `DEPLOY.md`).

This README is a load-bearing reference for **M4 / M7 / M8** — they
inherit the conventions established here. Read it once before adding a
new surface.

## Commands

```sh
# from repo root
pnpm dev                                  # both worker + web concurrently
pnpm --filter @loomwiki/web dev           # just the Astro dev server (4321)
pnpm --filter @loomwiki/web typecheck     # astro check
pnpm --filter @loomwiki/web test          # vitest (happy-dom)
pnpm --filter @loomwiki/web build         # production bundle
```

For a full E2E loop you also want the worker running:

```sh
pnpm --filter @loomwiki/worker dev   # 8788
```

## Local-dev auth

Cloudflare Access is the production gate. For `wrangler dev` the worker
ships a triple-gated bypass (see `apps/worker/src/middleware/auth.ts`):

1. `NODE_ENV !== "production"`
2. `ALLOW_LOCAL_DEV_AUTH=true` in `.dev.vars`
3. `CF-Connecting-IP` is empty / `127.0.0.1` / `::1`

If all three hold, the worker accepts:

- `X-Local-Dev-Email: alice@example.com` — used on REST `fetch()`.
- `?devEmail=alice@example.com` — used on the WS upgrade. Browsers
  can't set custom headers on the WebSocket constructor, so the
  M3 client appends the email as a query parameter.

The web app sends both whenever `PUBLIC_LOOMWIKI_DEV_EMAIL` is set:

```sh
# apps/web/.env.local
PUBLIC_LOOMWIKI_DEV_EMAIL=alice@example.com
```

Run two browsers (or two profiles) with different `PUBLIC_LOOMWIKI_DEV_EMAIL`
values to simulate two users.

## Hydration convention (load this into your head)

Astro Islands hydration is a discipline, not a default. Every new
component decides how it ships:

| Surface | Directive | Why | Example |
|---|---|---|---|
| Active room view | `client:load` | WS opens immediately on page interactive — anything later is added latency on every room visit | [src/pages/r/[slug].astro](src/pages/r/[slug].astro) → `<RoomView client:load … />` |
| Wiki viewer + editor | `client:load` | The Edit button toggles to the editor in-place; Milkdown / textarea need state in user's hands without a hydration delay | [src/pages/w/[...path].astro](src/pages/w/[...path].astro) → `<WikiViewer client:load … />` |
| Sidebar nav, theme toggle, header | `client:load` for header (theme toggle wired pre-paint), `client:idle` for the sidebar | Idle waits for `requestIdleCallback` so the active surface gets first dibs | [src/pages/index.astro](src/pages/index.astro) → `<RoomList client:idle … />` and `<WikiTree client:idle … />` |
| Page chrome, layout markup, server-fetched data shell | (no directive — server-rendered) | Saves JS payload, plays nice with SSR + Cloudflare adapter | [src/components/AppShell.astro](src/components/AppShell.astro) |
| Below-the-fold widgets | `client:visible` | Wait for IntersectionObserver | (none yet) |

**Radix UI context does NOT cross the .astro / .jsx boundary.** Astro
SSR renders each React component in isolation; nesting
`<Avatar><AvatarFallback /></Avatar>` across a slot fails with "must
be used within Avatar". When a Radix primitive uses a Provider /
Context, compose its tree inside a single React component (see
`src/components/DesignSamples.tsx` and the chat components for
examples).

## Wiki

The wiki surface (M4) lives at `/w` and `/w/<path>`. Three React
components compose the experience, all designed to live inside one
React tree to honor the M3 Radix-context constraint:

- [`WikiTree`](src/components/wiki/WikiTree.tsx) — sidebar, hierarchical
  page listing. Hydrates `client:idle`. Auto-expands the current
  page's ancestors. Refetches on window focus.
- [`WikiViewer`](src/components/wiki/WikiViewer.tsx) — read-only render
  of the page. Sanitized markdown via `@loomwiki/shared`'s
  `renderMarkdown`. The Edit button toggles to:
- [`WikiEditor`](src/components/wiki/WikiEditor.tsx) — split-pane editor
  (textarea on the left, live preview on the right). Saves via
  `PUT /api/wiki/*` carrying `before_sha`. On 409 → opens
  [`MergeDialog`](src/components/wiki/MergeDialog.tsx).

**Editor note**: v0.0.1 uses a textarea + live preview rather than the
Milkdown WYSIWYG editor. The Milkdown deps (`@milkdown/core`,
`@milkdown/react`, etc.) are installed; the swap to Milkdown is tracked
as M4.5 follow-up. The textarea route covers every editing primitive
the M4 prompt asks for (bold, italic, code, headings, lists, quote,
link) and round-trips through the same sanitizer pipeline.

**Wikilinks**: `[[page-name]]` syntax renders as plain code-fenced text
(no link) in v0.0.1 — they become resolvable links in v0.1 once a
`remark` plugin lands that knows about the wiki tree.

**Conflict resolution**: optimistic locking via SHA-256 of the on-disk
page bytes. Each read returns the SHA; each write submits
`before_sha`. On mismatch the worker returns a 409 with a typed
`details` payload (`current_sha`, `current_raw`, `base_sha`,
`base_raw`, `attempted_*`). The client surfaces a side-by-side picker;
v0.0.1 does not algorithmically merge.

**Persistence**: pages live in the `WIKI_KV` namespace in v0.0.1 (see
[ADR-0003](../../docs/ADR/0003-artifacts-as-vault.md)). M4.5 swaps the
KV backend for git-backed Artifacts persistence using the
`/_admin/wiki/vault-token` route to clone/push. The vault repo is
created lazily on first request via `env.ARTIFACTS.create()`.

## Markdown sanitization

Everything that renders untrusted markdown — chat bubbles, wiki pages
(M4), proposal diffs (M7) — calls
[`renderMarkdown`](../../packages/shared/src/markdown-sanitize.ts)
from `@loomwiki/shared`. Drift between client and server renders is
a CSP-bypass class of bug, so the pipeline lives in `@loomwiki/shared`
and both sides import it.

The output is HTML-injection-prop-safe **for the documented allowlist
only**. Always wrap in a `.md`-scoped `<div>` so the typography rules
in `src/styles/global.css` style the result.

What gets stripped: `<script>`, `<iframe>`, `<style>`, `on*` event
handlers, the `javascript:`/`data:`/`vbscript:` URL schemes,
`class`/`style` attributes (except `language-*` on code blocks).
External `<a>` gets `rel="noopener noreferrer ugc"` + `target="_blank"`.
Internal `<a>` (paths starting with `/`, `#`, `?`) keeps `target="_self"`.

## Time formatting

Two wire formats are load-bearing and not unified:

- **Messages** (M2 WS protocol + REST scrollback) — `created_at` etc.
  are unix epoch seconds as `number`.
- **Users / workspaces / rooms** (M1) — `created_at` etc. are
  ISO-8601 `string`s.

Use `formatEpochSeconds(n)` for the former and `formatIsoString(s)`
for the latter (both in `src/lib/time.ts`). Both render relative
("3m ago") for ≤24h, then locale-formatted absolute thereafter.

## API access

- Browser-side: `apiGet` / `apiPost` / `apiDelete` from `@/lib/api` —
  cookie-aware (`credentials: include`), throws `AuthRequiredError` on
  401, throws `ApiError(code, status)` on typed errors.
- SSR-side: `ssrApiGet` from `@/lib/ssr-api` — forwards the incoming
  `Cookie` header and the local-dev email so the worker auth gate
  sees the same identity it would on a browser hop. Throws
  `SsrAuthRequiredError` on 401; the page redirects to `/login`.

Don't import the browser-side helpers from inside an `.astro`
frontmatter block — they read `document` and will crash SSR. The two
modules are deliberately separate.

## CSP

Set in `src/middleware.ts` on every HTML response:

```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
connect-src 'self' ws: wss:;
font-src 'self' data:;
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
object-src 'none'
```

`script-src 'unsafe-inline'` is a M3-time deviation. Astro 5.1.5 emits
inline hydration shims with variable content that can only be allowed
under CSP via 'unsafe-inline', a nonce, or per-page hashes. Astro's
built-in nonce injection landed in 5.9 (`experimental.csp`). Bumping
Astro and tightening to a nonce is tracked as a follow-up; the
primary XSS defense is the markdown sanitizer above.

`/public/theme-init.js` runs before React hydrates and applies the
`dark` class to `<html>` from `localStorage`. It's a static asset so
`script-src 'self'` covers it without 'unsafe-inline' growth.

## Path aliases

`@/*` resolves to `src/*` (configured in `tsconfig.json` and
`astro.config.mjs` Vite resolve aliases). Use it everywhere. Don't
write `../../components/...`.

## Testing

- `vitest run` with happy-dom for everything (component tests +
  the existing `ws.test.ts`, which already injects a fake WebSocket
  constructor so it doesn't depend on `globalThis.WebSocket`).
- `@testing-library/jest-dom` matchers and explicit `cleanup()` in
  `src/test/setup.ts` (we run `globals: false` so auto-cleanup
  doesn't fire).
- Component tests: import from `@testing-library/react`. Wrap state
  updates in `act()` if not already inside `fireEvent`.
- Hook tests: use `renderHook`. For chat-style hooks that own
  long-lived sockets, inject a fake via the `createClient` option to
  drive open/close/server events directly (see `useChat.test.tsx`).
