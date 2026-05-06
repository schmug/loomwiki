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

## Search + Ask (M6)

The header carries a global search box; `/search` is the full-page
version; `/ask` is the streamed-answer surface.

- **SearchBar** ([src/components/search/SearchBar.tsx](src/components/search/SearchBar.tsx))
  hydrates `client:idle` (deferred until the active surface settles).
  - Hotkey: `⌘K` / `Ctrl+K` focuses the input from anywhere on the page.
  - Debounced 200ms; cancels stale in-flight responses via a sequence
    counter so a slow first request can't overwrite a faster second.
  - Esc closes the dropdown; click-outside also closes.
  - Click → `/w/<slug>` navigation (full-page nav, not SPA).
- **SearchPage** ([src/components/search/SearchPage.tsx](src/components/search/SearchPage.tsx))
  hydrates `client:load` and renders the same `SearchResults` list with
  a full inline `RateLimitBanner` on 429.
- **AskBox** ([src/components/ask/AskBox.tsx](src/components/ask/AskBox.tsx))
  hydrates `client:load` (the SSE stream needs to be live on first
  paint of `/ask`). Submit with `⌘+Enter` from the textarea, or click
  the button. The Stop button calls `AbortController.abort()`. History
  is in-memory only — reload clears it (M6 does not persist Q/A pairs).
- **CitationPill** ([src/components/ask/CitationPill.tsx](src/components/ask/CitationPill.tsx))
  is `inline-flex` so a list of pills wraps cleanly. Mirrors the
  `FrontmatterPill` look but is an `<a>` with an `ArrowUpRight` icon.
  Links to `/w/<slug>` plus `#<heading_slug>` when set.

### `/api/ask` SSE wire format

The route emits Server-Sent Events:

```
data: {"text": "incremental token"}\n\n
event: citations\ndata: [{...}]\n\n
event: done\ndata: {}\n\n
```

The consumer lives in [src/lib/api-ask.ts](src/lib/api-ask.ts). It uses
`fetch` (not `EventSource`) because:

1. `EventSource` is GET-only; `/api/ask` is POST.
2. We need `credentials: include` (Access cookie) and the local-dev
   `X-Local-Dev-Email` header.
3. We want a real `AbortController` for the Stop button.

When the worker rejects before any SSE frame (401, 429, 400 schema), it
returns a normal JSON `ApiResult<err>`; we sniff `Content-Type` and
surface an `ApiError` (or `AuthRequiredError`) to `onError`. A 429
`RATE_LIMITED` carries `details: { limit, used, scope, reset_at }` which
the AskBox unwraps and hands to `RateLimitBanner` directly.

### Search snippet rendering

`/api/search` returns FTS5 snippets with `<mark>...</mark>` tags around
matched terms. We **do not** inject the snippet via the React HTML-prop
escape hatch — [`SearchResults`](src/components/search/SearchResults.tsx)
parses the snippet manually, treating only `<mark>` and `</mark>` as
React `<mark>` elements and everything else as literal text. Any other
tag (including a `<script>`) renders as visible text. This is the same
defense-in-depth posture as the markdown sanitizer.

### Local-dev fallback messaging

When AI Search is unavailable (no `ai_search_id` on the workspace yet,
or the index hasn't been built), the worker returns
`mode: "fts5_fallback"`. The UI shows a small amber notice
("Showing keyword matches only — semantic search is unavailable.") at
the top of the result list and on the empty state. This is expected on
fresh local dev environments before the operator runs the AI Search
provisioning flow — point users at the M6 setup section of `DEPLOY.md`
when they ask why ranking feels keyword-y.

## Inbox + proposals (M7)

The inbox is the human-review surface for the ingest agent's
proposals. Three new web pieces ship in M7:

- [`InboxBadge`](src/components/inbox/InboxBadge.tsx) — sidebar pill
  showing the pending-proposal count. Hydrates `client:idle` (it's a
  derived nav element, not the active surface). Polls
  `/api/proposals?count=true&status=pending` every 60s; renders nothing
  when the count is 0 so the chrome stays clean.
- [`ProposalsList`](src/components/inbox/ProposalsList.tsx) —
  list view at `/inbox`. SSR-fetches `/api/proposals?status=pending`
  and renders without JS; the inbox page is a real navigation, not an
  island.
- [`ProposalDetail`](src/components/inbox/ProposalDetail.tsx) — review
  pane at `/inbox/proposals/:id`. Hydrates `client:load` (Merge /
  Reject buttons need to be live on first paint). Side-by-side: left
  shows the current wiki page (only for `update` actions), right shows
  the proposed page. Both panes flow through the shared
  `SanitizedMarkdown` component — same allowlist as chat + wiki, no
  drift.

### Inbox route conventions

| Surface | Directive | Why |
|---|---|---|
| `<InboxBadge>` in AppShell sidebar | `client:idle` | derived chrome; not on the latency hot path |
| `<ProposalsList>` on `/inbox` | (no directive) | server-rendered; the list is static after SSR fetch |
| `<ProposalDetail>` on `/inbox/proposals/:id` | `client:load` | Merge / Reject buttons need to be live on first paint, and the conflict-banner state lives in the component |

### Conflict handling on merge

`POST /api/proposals/:id/merge` calls into the same wiki write path as
M4's `PUT /api/wiki/*`, so the conflict-detection model is identical.
On 409 the worker returns the M4 merge-payload shape; the
`ProposalDetail` component renders a conflict banner pointing the user
at the wiki editor (`/w/<path>`) where the existing
[`MergeDialog`](src/components/wiki/MergeDialog.tsx) handles the
resolution. The inbox does NOT inline the merge dialog — operators
resolve conflicts in the canonical M4 surface so they get the full
3-way picker.

### M8 plug-in points

- `DigestDelivery` interface (`apps/worker/src/lib/digest-delivery.ts`)
  — M8 adds `EmailDigestDelivery` behind the same contract. The wiki
  page renders unchanged; email becomes a per-user opt-in addition.
- Per-user inbox notifications (Slack/email/web push) — none in M7.
  The badge + the daily digest wiki page are the only notifications.
- Bulk merge / reject — defer; v0.0.1 enforces one-at-a-time review.

### Manual ingest trigger from chat

Tracked as a follow-up — the M7 prompt's "Things to surface" list
includes ⌘K command-palette integration; deferred. Operators trigger
manually via `curl POST /api/rooms/:rid/ingest` for now (see
`DEPLOY.md` for the smoke recipe).
