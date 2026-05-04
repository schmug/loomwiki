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
| Sidebar nav, theme toggle, header | `client:load` for header (theme toggle wired pre-paint), `client:idle` for the sidebar (not on the latency hot path) | Idle waits for `requestIdleCallback` so the chat surface gets first dibs | [src/pages/index.astro](src/pages/index.astro) → `<RoomList client:idle … />` |
| Page chrome, layout markup, server-fetched data shell | (no directive — server-rendered) | Saves JS payload, plays nice with SSR + Cloudflare adapter | [src/components/AppShell.astro](src/components/AppShell.astro) |
| Below-the-fold widgets | `client:visible` | Wait for IntersectionObserver | (none in M3; M4 wiki TOC may use it) |

**Radix UI context does NOT cross the .astro / .jsx boundary.** Astro
SSR renders each React component in isolation; nesting
`<Avatar><AvatarFallback /></Avatar>` across a slot fails with "must
be used within Avatar". When a Radix primitive uses a Provider /
Context, compose its tree inside a single React component (see
`src/components/DesignSamples.tsx` and the chat components for
examples).

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
