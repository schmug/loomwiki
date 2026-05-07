<!-- SPDX-License-Identifier: Apache-2.0 -->

# Loomwiki v0.0.1 — Release notes

Release date: **2026-05-07**.

Loomwiki v0.0.1 is the dogfood release: a Cloudflare-native team
workspace where chat is the input and a git-backed wiki is the
output. The reference deploy lives at `loomwiki.cortech.online`
(private; behind Cloudflare Access OTP). Self-hosting follows the
same recipe — see `DEPLOY.md`.

## What's in v0.0.1

The eight milestones from `SPEC.md` §19, all merged to `main`:

- **M0 — Skeleton.** pnpm monorepo, `wrangler.jsonc` per SPEC §5,
  Hono worker with `/api/health`, vitest config, GitHub Actions CI,
  `CLAUDE.md` written.
- **M1 — Auth + D1 + base API** (PR #12). Cloudflare Access JWT
  middleware (`apps/worker/src/lib/auth.ts`), D1 migration
  `0001_init.sql` per SPEC §7.1, JIT user provisioning, `/api/me` /
  `/api/workspaces/:wid` / `/api/rooms/:rid`, Zod schemas in
  `packages/schema`, integration tests per route.
- **M2 — Chat (DO + WebSocket)** (PR #13, follow-up #14).
  `ChatRoom` Durable Object using the Hibernation API
  (`ctx.acceptWebSocket` + `webSocketMessage` + `webSocketClose`),
  WS upgrade route in the worker, DO SQLite + D1 mirror, shared
  `packages/shared/src/ws-protocol.ts`, miniflare-backed DO tests.
  Two `wscat` sessions to the same room exchange messages; reload
  preserves history.
- **M3 — Frontend shell + chat UI** (PR #18). Astro 5 (server-
  rendered) + React 19 islands + Tailwind v4, app shell with Access-
  aware login, room list + room view + WS client, sanitized markdown
  rendering for messages (`packages/shared`'s `markdown-sanitize`).
- **M4 — Wiki R/W + Artifacts integration** (PR #19). Typed
  Artifacts client (`apps/worker/src/lib/artifacts.ts`), wiki page
  CRUD routes, bootstrap-vault script, wiki viewer + textarea
  editor with split-pane preview, gray-matter frontmatter, SHA-256
  optimistic locking with a 3-way merge picker on 409. Persistence
  is `WIKI_KV` for v0.0.1 (M4.5 swaps to git-backed Artifacts; see
  ADR-0003).
- **M5 — Daily chat-log commit cron** (PR #20). Workers cron at
  02:00 UTC aggregates the previous day's messages from D1 and
  commits one file per room to the vault under
  `/rooms/{slug}/log/{YYYY-MM-DD}.md`. Per-room failure isolation;
  re-running for the same date is byte-identical.
- **M6 — AI Search + `/ask` + 3-layer cost guards** (PR #21).
  Hybrid search over `/wiki/**` (AI Search primary, D1 FTS5 fallback;
  ADR-0004). `/api/search` and `/api/ask` (SSE streaming with
  citation pills). Three independent cost-defense layers: per-user
  daily cap, per-workspace daily cap, AI Gateway dashboard cap. UI:
  global ⌘K SearchBar + dedicated `/search` and `/ask` pages.
  AI Search provisioning is **deferred** in the dogfood deploy — see
  "Known limitations" below.
- **M7 — Ingest agent + proposal inbox** (PR #22). The marquee
  feature: chat → wiki proposals → human review → merged wiki. Five
  independent prompt-injection guards (`docs/SECURITY.md` §2.2) ship
  together: input sanitization, structured-output Zod parse + retry,
  path allowlist, secret scrub, admin-merge-only gate. Plus source-
  citation validation (closes A8 citation laundering). D1-row-backed
  per-room run lock, 1h stale-lock recovery. Manual + cron triggers
  converge on the same code. Daily digest at
  `/wiki/_inbox/{YYYY-MM-DD}.md`. UI: `InboxBadge` (sidebar pill),
  `ProposalsList` (`/inbox`), `ProposalDetail` (side-by-side diff +
  Merge / Reject). See ADR-0005.
- **M8 — Release-readiness** (this release). BYOK envelope
  encryption (Anthropic + OpenAI in the UI; Google reserved in the
  schema; ADR-0006). Audit log for owner-only actions (ADR-0007).
  Sentry minimal envelope sender with PII scrubbing (ADR-0008).
  `BYOK_ENCRYPTION_KEY` rotation runbook in `DEPLOY.md`.
  Post-deploy verifier wired into CI. README + `DEPLOY.md` polish.

The dogfood deploy at `loomwiki.cortech.online` (PR #23, #24) is the
reference operator path — single-domain Pages + Worker on a
Cloudflare zone, Access OTP, live smoke (`pnpm smoke:live`)
exercising the full M7 happy path end-to-end.

## Known limitations

These are scope cuts the v0.0.1 release explicitly accepts. Each is
tracked for v0.1.

**From SPEC §17 (out of scope):**

- No threading; messages are flat per room.
- No real-time presence, typing indicators, or read receipts.
- No file uploads, attachments, or image embeds. The R2 binding is
  wired but unused.
- No voice rooms, no transcription.
- No email-to-wiki ingest, no Slack / Teams / Discord ingest.
- No auto-merge of low-risk proposals — every proposal is
  admin-clicked (`docs/SECURITY.md` §M5).
- Single workspace per deploy. Multi-workspace is a v0.1 effort
  that requires a workspace-scoping audit across every query.
- No E2E encryption. Loomwiki's value prop is the LLM ingest, which
  requires the operator's worker to read chat content.
- No mobile-native apps. The web UI is a PWA-in-spirit; an iOS /
  Android wrapper is not on the v0.0.1 path.
- No federation. One Cloudflare account = one Loomwiki.
- No granular RBAC beyond admin / member / viewer. Workspace owner =
  admin in v0.0.1; other roles are stubs.
- No billing, no SaaS hosting story. Self-host or don't.

**From the v0.0.1 deploy reality:**

- **Wiki content is in `WIKI_KV`, not git-pushed.** The Artifacts
  vault is created lazily on first request (the binding works), but
  M4 ships KV-backed persistence (`KvWikiBackend`); M4.5 swaps to
  `GitArtifactsBackend` over isomorphic-git. Until M4.5 lands, a
  `git clone` of the vault returns the seed only — UI edits are not
  reflected in the cloned repo. See ADR-0003.
- **AI Search is deferred for the dogfood deploy.** Wrangler 4.x
  `ai-search create` doesn't accept the Artifacts source, and
  dashboard provisioning requires the Artifacts allowlist. The
  dogfood runs on the FTS5 fallback (`AI_SEARCH_ENABLED: "false"`).
  Search is keyword-only; ranking is FTS5 BM25. Operators with the
  Artifacts allowlist can flip the var to `"true"` and provision via
  dashboard. See `DEPLOY.md` §3 of the dogfood section.
- **Email digest delivery is not shipped.** The `DigestDelivery`
  interface exists (`apps/worker/src/lib/digest-delivery.ts`); only
  the wiki-page implementation (`WikiPageDigestDelivery`) ships in
  v0.0.1. M7's daily digest renders to `/wiki/_inbox/{date}.md` via
  the same M4 sanitizer + viewer.
- **Audit log has no web UI.** Reads via `GET /api/_admin/audit`
  (JSON only) or `wrangler d1 execute` SQL. The web viewer is a
  v0.1 deliverable (ADR-0007).
- **No "Deploy to Cloudflare" button.** Self-hosters follow
  `DEPLOY.md`'s prose recipe. The button is a v0.1 deliverable.
- **No automated dep scanning beyond Dependabot.** `pnpm audit` runs
  in CI as warn-only; promoting it to a CI fail is a v0.1
  follow-up. See `docs/SECURITY.md` §11.
- **Master-key rotation (`BYOK_ENCRYPTION_KEY`) is a manual
  runbook.** Documented in `DEPLOY.md`. Automation is v0.1
  (ADR-0006).
- **Lint workflow** (the second-agent role from Karpathy's
  `llm-wiki.md` gist — drift detection across pages) is not
  shipped. The structured-output contract from M7 is the template
  when it lands. See `vault-template/AGENTS.md` §12.
- **Editor is textarea + live preview, not Milkdown WYSIWYG.** The
  Milkdown deps are installed; the swap is M4.5 follow-up.
  Wikilinks (`[[page-name]]`) render as code-fenced text in v0.0.1.

**Operator caveats:**

- The smoke script (`pnpm smoke:live`) requires a service token
  whose email matches the workspace owner — v0.0.1's single-tenant
  model assigns ownership to the first user that hits `/api/me`.
  See `DEPLOY.md` §10 for the workaround.
- Workers AI hits the real service in local dev (unlike Artifacts,
  it doesn't have a miniflare local). `pnpm dev` against the
  default Llama model spends free-tier neurons.

## Roadmap to v0.1

Ordered roughly by user-visible impact:

1. **M4.5 — Artifacts swap.** Move wiki content from `WIKI_KV` to
   git-backed Artifacts via isomorphic-git. `git clone` returns
   what the UI shows. The `WikiBackend` interface is in place; the
   swap is one file plus a deps bump.
2. **AI Search re-enable.** Either the Artifacts allowlist opens up
   for self-hosters or wrangler picks up `--data-source artifacts`.
   Until then, FTS5 keyword search is the operator path.
3. **Email digest delivery.** `EmailDigestDelivery` behind the
   existing `DigestDelivery` interface. Per-user opt-in; preference
   UI in `/settings`.
4. **Audit log web UI.** Filterable by action / actor / time range,
   side-by-side before/after diff render, expand-on-click. Schema
   is ergonomic for it (ADR-0007 §e).
5. **Deploy-to-Cloudflare button.** One-click self-host from a
   GitHub README badge. Pulls `wrangler.jsonc` defaults, prompts
   the operator for Access team and AUD, mints all bindings.
6. **Lint workflow.** Karpathy's `llm-wiki.md` gist describes a
   second agent role: drift detection across pages, glossary
   consistency, dead-link checking. Sandboxed (Cloudflare
   Sandboxes, no network egress) so it can run code-execution
   tooling safely. See `vault-template/AGENTS.md` §12.
7. **Mobile considerations.** Loomwiki ships as a web app; the v0.1
   pass is "make the chat + wiki + inbox surfaces usable on a
   320px viewport," not a native wrapper.
8. **Multi-workspace per deploy.** The single-tenant assumption is
   threaded through every D1 query; the v0.1 effort is an explicit
   workspace-scoping audit plus UI for switching workspaces.
9. **Operational glue.** `pnpm audit` as a CI fail; SIEM integration
   via Workers Analytics Engine → log push to R2; `BYOK_ENCRYPTION_KEY`
   rotation automation; a real `security.txt` published.
10. **Performance / scale work.** None of the v0.0.1 milestones were
    scale-tuned; the dogfood's < 10 users keeps numbers small. v0.1
    profiling pass: DO message-history scrollback, AI Search
    re-index throughput, FTS5 index size growth.

The v0.1 effort is roughly the same size as v0.0.1 — it's the
"second album" pass, where shipped features get the polish and the
deferred decisions resolve.

## How to deploy

The full operator runbook lives in [`DEPLOY.md`](../DEPLOY.md). The
dogfood-specific reference deploy (single-domain Pages + Worker on a
Cloudflare zone, Access OTP, live smoke) is in the
"Dogfood deploy (`loomwiki.cortech.online`) + live smoke" section
near the bottom of that file. Replace the hostname and zone with
your own to follow the same recipe.

For first-time operators:

1. `pnpm install` from a fresh clone.
2. Provision D1 + KV bindings per `DEPLOY.md` §1.
3. Configure Cloudflare Access (one-time PIN works) per `DEPLOY.md` §2.
4. `pnpm migrate:remote` to apply all four D1 migrations (M1–M8).
5. Set the four Worker secrets per `DEPLOY.md` §4.
6. `pnpm deploy:all`.
7. Sign in via browser, run `/api/_admin/wiki/bootstrap-vault`.
8. (Optional) Run `pnpm smoke:live` against the deploy with a
   service token configured per `DEPLOY.md` §5 of the dogfood
   section.

The `RELEASE-CHECKLIST.md` at the repo root is the operator's
pre-tag checklist for shipping a release of their own fork.

## Acknowledgements

Loomwiki stands on three shoulders, in order of how directly each
shaped the v0.0.1 design:

- **Andrej Karpathy's [`llm-wiki.md`](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
  gist** — the chat-as-input, wiki-as-output pattern is operationalized
  here. The gist's two-agent split (ingest + lint) is Loomwiki's
  v0.0.1 (ingest) and v0.1 (lint) roadmap. The vault schema in
  `vault-template/AGENTS.md` reads as a direct descendant.
- **The Cloudflare developer-platform team** — Workers, Durable
  Objects (especially the WebSocket Hibernation API; ADR-0001 §c is
  load-bearing on `workerd #4864`), D1, R2, KV, Workers AI, AI
  Gateway, AI Search, and Artifacts together make the
  one-Cloudflare-account, one-bill, one-deploy story possible. The
  `cloudflare/workers-chat-demo` reference informed M2's DO
  hibernation pattern.
- **Anthropic** — the Claude SDK is BYOK provider #1, and Claude
  Code (Opus 4.7 at `xhigh` effort) is the development environment
  the milestones were sized for. The `CLAUDE.md` convention, the
  per-milestone subagent fan-out guidance, and the
  spec-and-architecture-first prompting style all come from
  building inside the harness.

Vulnerability researchers who responsibly disclose issues per
`docs/SECURITY.md` §12 are credited here unless they request
anonymity.

The v0.0.1 dogfood team — internal — gets the implicit thanks of
having patiently lived with the bugs that ended up in PR #24.
