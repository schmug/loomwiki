# CLAUDE.md

> Auto-loaded by Claude Code every session. Keep this file under 200 lines.
> SPEC.md is the master spec — this file is the operating manual.

## Project

**Loomwiki** is a Cloudflare-native team workspace where chat is the input and a git-backed wiki is the output. Operationalizes [Karpathy's `llm-wiki.md` pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Open-source, one-click self-hostable, Apache 2.0.

## Source of truth

- **SPEC.md** is the master spec. Before any non-trivial task, read the relevant milestone section in SPEC §19 *plus* §4 (architecture), §5 (bindings), and §6 (repo structure). Bindings doc prevents binding-shape guesses.
- **Open questions** live in SPEC §20. If an unanswered Q blocks your task, stop and surface it with a suggested default + one-line rationale.
- **Decisions** go to `docs/ADR/NNNN-{slug}.md`. Use ADR-lite format (context, decision, consequences).
- The wiki content schema (`AGENTS.md`) lives in the **vault** repo, not this repo. Seed version is in `vault-template/`.

## Stack

- TypeScript strict + `noUncheckedIndexedAccess`
- Hono on Cloudflare Workers (`apps/worker`)
- pnpm workspaces, monorepo
- vitest + `@cloudflare/vitest-pool-workers`
- biome for lint + format
- wrangler 4+
- Frontend: ❓ SPEC Q3
- Editor: ❓ SPEC Q4

## Commands

```sh
pnpm install                     # bootstrap
pnpm dev                         # worker (wrangler dev) + web concurrently
pnpm test                        # vitest, all packages
pnpm test --filter @loomwiki/worker
pnpm typecheck
pnpm lint                        # biome check
pnpm format                      # biome format --write
pnpm build                       # production bundle
pnpm deploy                      # wrangler deploy + d1 migrations apply
pnpm migrate:new <name>          # scaffold a new d1 migration
pnpm seed                        # populate dev D1 with test corpus
```

Run `pnpm test && pnpm typecheck && pnpm lint` before any commit. CI runs the same.

## Cloudflare conventions

- **DO WebSockets**: ALWAYS use the Hibernation API (`ctx.acceptWebSocket(ws)` + `webSocketMessage()` + `webSocketClose()`). Never the legacy `ws.addEventListener` pattern. Reference: `cloudflare/workers-chat-demo`.
- **DO storage**: use `ctx.storage.sql` (SQLite-backed). Do not use the legacy KV-style `ctx.storage.put/get` API.
- **D1 migrations**: forward-only. To roll back, write a new migration. Never edit a committed migration file.
- **DO migrations** (`wrangler.jsonc` → `migrations`): append-only. Never edit historical entries.
- **Secrets**: `wrangler secret put`. Never commit `.env`. `.env.example` may document expected names only.
- **Compatibility date**: pinned in `wrangler.jsonc`. Bumping requires an ADR.
- **nodejs_compat** is on. Prefer Web-standard APIs (`crypto.subtle`, `fetch`, `URL`) over Node equivalents where they overlap.
- **No `localStorage` / `sessionStorage`** in shared packages — they don't exist in Workers and break SSR/edge code paths.
- **Outbound WebSockets from a DO do not hibernate** (workerd #4864). Don't proxy LLM streams via a long-lived outbound socket from inside the DO; open a fresh `fetch` per request and stream the response.

## Code conventions

- All API routes return `ApiResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }`. Defined in `packages/shared`. Use it everywhere.
- IDs: UUIDv7 (sortable). Helper in `packages/shared/src/id.ts`.
- Times: store as unix epoch **seconds** (integer) in D1. Convert at the edge.
- Zod schemas live in `packages/schema`; types are `z.infer<typeof X>`. Frontend imports the same schemas.
- Workspace deps use `workspace:*` protocol.
- File names: `kebab-case.ts` for modules, `PascalCase.ts` for files exporting a single class/type (e.g., `ChatRoom.ts`).
- Public exports from `packages/*` need explicit return types. App-internal functions can infer.
- Errors: throw a typed `LoomwikiError` (in `packages/shared`) with a `code`. Catch at the route layer and map to `ApiResult` errors.

## Testing

- New route → at least one integration test in `apps/worker/src/routes/__tests__/`.
- DO change → at least one miniflare-backed test exercising the WS protocol.
- Prompt change → update the golden fixture in `packages/agents-prompts/__fixtures__/` and assert structural invariants (don't assert exact text).
- Coverage target: ≥ 60% on `apps/worker/src` (not a hard CI gate).

## Do not touch (without explicit instruction)

- `vault-template/` — operator-customizable surface; changing it changes the default for every self-hoster.
- Historical entries in `wrangler.jsonc` `migrations` array.
- Committed files in `packages/schema/d1-migrations/`.
- `LICENSE` and `NOTICE`.
- Anything in `docs/ADR/` — append new ADRs; do not edit existing ones.

## When to ask vs proceed

- **Blocking SPEC §20 Q**: stop, surface, suggest default, ask.
- **Adjacent SPEC §20 Q**: proceed with a documented assumption — leave a `// TODO(QNN):` comment and note the assumption in the PR description.
- **SPEC contradicts itself**: stop and flag. Don't pick a side silently.
- **A "small" change in a file marked do-not-touch**: stop and ask, even if the diff is one line.

## Subagent guidance

Opus 4.7 is conservative about subagent fan-out by default. Override that conservatism explicitly when:

- Editing many independent files in parallel (e.g., adding a new field across schema + API + UI).
- Running prompt-engineering golden tests in parallel with the agent code that uses them.
- Building both sides of a fixed protocol (DO + WS client) once `packages/shared/src/ws-protocol.ts` is committed.

Each milestone in SPEC §19 has explicit fan-out guidance. Follow it. **Don't spawn a subagent for work you can complete directly in a single response** (e.g., refactoring a function you can already see).

## Tool-use guidance

- Use Read aggressively for file context — it's cheap. Reading the relevant SPEC sections + the touched files in turn one is the right move.
- Use Bash for: tests, typecheck, biome, wrangler commands. Do not use Bash for ad-hoc curl against production.
- Use Glob / Grep before guessing — the codebase is small enough that a 1-second search beats a 10-second hallucination.

## Effort and thinking

- Default effort: **xhigh** (set globally — do not change per-task unless told).
- For typo fixes, dependency bumps, simple renames: prompt for less thinking ("respond directly, this is mechanical").
- For schema changes, prompt design, the ingest agent, anything that touches the ratchet/proposal flow: leave at xhigh.
- Adaptive thinking is on; you don't need a fixed budget.

## Commit hygiene

- Branch naming: `m{N}-{short-description}` for milestones (`m2-do-hibernation`), `fix-{description}` for bugs, `chore-{description}` for housekeeping.
- Imperative commit messages ("add ChatRoom DO", not "added").
- One logical change per commit. Tests that go with the change live in the same commit.
- PR title mirrors the commit. PR description references the milestone (`Refs #M2`) and lists any SPEC §20 assumptions made.
- CI must pass before merge. No exceptions for "trivial" changes.

## Where state lives (mental model)

- **Code** → this repo.
- **The wiki itself** (markdown pages) → a separate Artifacts repo, one per workspace. Not in this repo.
- **Hot data** (users, rooms, messages, proposals) → D1.
- **Live chat state** → ChatRoom DO (hibernating between messages).
- **Cache** → KV (`CACHE` binding).
- **File uploads** → R2 (`ATTACHMENTS`).
- **BYOK keys** → D1, envelope-encrypted with `BYOK_ENCRYPTION_KEY` (Worker secret).

## Reference docs

Read once when relevant; don't re-fetch every session.

- `SPEC.md` — master spec
- `docs/RATIONALE.md` — design rationale (deep-research artifact)
- `docs/SECURITY.md` — threat model (prompt injection via chat is the marquee threat)
- `vault-template/AGENTS.md` — ingest schema; the canonical reference for how the agent thinks
- [Cloudflare DO WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/)
- [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/)
- [Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/)
