#!/usr/bin/env bash
# scripts/seed-milestones.sh
#
# Seeds the Loomwiki POC milestones (M0–M8) as GitHub issues in the current repo.
# Idempotent: skips issues with matching titles that already exist.
#
# Prerequisites:
#   - gh CLI installed and authenticated (gh auth login)
#   - Run from the repo root after `gh repo create` / first push
#
# Optional: create a GitHub milestone first so issues bind to it:
#   gh api repos/:owner/:repo/milestones -f title="Loomwiki POC" \
#     -f description="v0.0.1 dogfood-ready release"

set -euo pipefail

command -v gh >/dev/null \
  || { echo "✗ gh CLI not found. Install: https://cli.github.com/"; exit 1; }
gh auth status >/dev/null 2>&1 \
  || { echo "✗ gh not authenticated. Run: gh auth login"; exit 1; }
gh repo view >/dev/null 2>&1 \
  || { echo "✗ Not in a GitHub repo. Run from repo root."; exit 1; }

MILESTONE="Loomwiki POC"

create_issue() {
  local title="$1" body="$2" extra_label="$3"

  if gh issue list --search "in:title \"$title\"" --state all \
       --json title --jq '.[].title' | grep -qFx "$title"; then
    echo "  ↪ skip (exists): $title"
    return 0
  fi

  echo "  ✓ create: $title"
  # Try with milestone first; fall back without (in case milestone doesn't exist).
  gh issue create --title "$title" --body "$body" \
    --label "milestone,$extra_label" --milestone "$MILESTONE" 2>/dev/null \
  || gh issue create --title "$title" --body "$body" \
    --label "milestone,$extra_label"
}

echo "Seeding Loomwiki POC milestones..."

# ─── M0 ────────────────────────────────────────────────────────────────────
create_issue "M0: Skeleton" "$(cat <<'EOF'
## Milestone
- **ID**: M0 — SPEC §19 milestone M0
- **Estimated**: 1 Claude Code session at xhigh

## Intent
Initialize the pnpm monorepo, wire bindings, and ship a `/api/health` endpoint plus CI. Foundation for everything else.

## Required reading (turn 1)
- `CLAUDE.md`
- `SPEC.md` §4 (architecture), §5 (bindings), §6 (repo structure), §19 → M0

## Deliverables
- [ ] pnpm monorepo per SPEC §6
- [ ] `wrangler.jsonc` per SPEC §5 with placeholder IDs
- [ ] Hono worker with `/api/health` returning `ApiResult<{ status: "ok" }>`
- [ ] vitest config + one passing test
- [ ] `.github/workflows/ci.yml` (lint + typecheck + test)
- [ ] biome config
- [ ] Root `package.json` scripts per CLAUDE.md "Commands"

## Definition of Done
- [ ] Clean clone → `pnpm install` succeeds
- [ ] `pnpm test && pnpm typecheck && pnpm lint` all pass
- [ ] `pnpm dev` serves `/api/health` via `wrangler dev`
- [ ] CI green on push
- [ ] PR opened referencing this issue

## Open questions touched
- Q3 (frontend framework) — `apps/web` skeleton shape depends
- Q21 (license) — `LICENSE` file contents

## Subagent guidance
None. Sequential setup; do not fan out.

## Out of scope
- Auth (M1), DO code (M2), D1 schema (M1), real frontend (M3)
EOF
)" "m0"

# ─── M1 ────────────────────────────────────────────────────────────────────
create_issue "M1: Auth + D1 + base API" "$(cat <<'EOF'
## Milestone
- **ID**: M1 — SPEC §19 milestone M1
- **Estimated**: 1 Claude Code session at xhigh

## Intent
Cloudflare Access JWT auth, D1 schema, and the base resource routes (me/workspace/rooms). After this milestone, a real user can authenticate and the data model exists.

## Required reading (turn 1)
- `CLAUDE.md`
- `SPEC.md` §4, §5, §6, §7.1 (D1 schema), §8 (API surface), §12 (auth), §19 → M1

## Deliverables
- [ ] `packages/schema/d1-migrations/0001_init.sql` per SPEC §7.1
- [ ] Zod schemas in `packages/schema/src/` for User, Workspace, Room, Message
- [ ] `apps/worker/src/lib/auth.ts` — Access JWT validation w/ JWKS cached in KV
- [ ] `apps/worker/src/middleware/auth.ts` — Hono middleware
- [ ] Routes: `/api/me`, `/api/workspaces/:wid`, `/api/workspaces/:wid/rooms` (GET/POST), `/api/rooms/:rid` (GET)
- [ ] Integration tests for each route (vitest + miniflare)
- [ ] `.dev.vars` template for local Access stub

## Definition of Done
- [ ] Hitting `/api/me` with a valid Access JWT returns the JIT-created user
- [ ] All routes reject 401 without JWT
- [ ] D1 migration runs cleanly on a fresh DB
- [ ] All routes return `ApiResult<T>` shape
- [ ] `pnpm test && pnpm typecheck && pnpm lint` pass
- [ ] PR opened, CI green

## Open questions touched
- Q19 (dogfood team size) — affects whether multi-workspace matters; POC default is single

## Subagent guidance
None. Schema → routes is sequential; tests can be written alongside each route.

## Out of scope
- WebSocket / chat (M2)
- Wiki routes (M4)
- BYOK keys (M8)
EOF
)" "m1"

# ─── M2 ────────────────────────────────────────────────────────────────────
create_issue "M2: ChatRoom DO + WebSocket Hibernation" "$(cat <<'EOF'
## Milestone
- **ID**: M2 — SPEC §19 milestone M2
- **Estimated**: 1 Claude Code session at xhigh

## Intent
The `ChatRoom` Durable Object with WebSocket Hibernation, DO SQLite for hot state, D1 mirror for queryable history. After this, two clients in the same room exchange messages in real time.

## Required reading (turn 1)
- `CLAUDE.md`
- `SPEC.md` §4, §5, §6, §7 (data model), §9 (full ChatRoom spec), §19 → M2
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Reference repo: `cloudflare/workers-chat-demo`

## Deliverables
- [ ] `packages/shared/src/ws-protocol.ts` — `ClientMsg` and `ServerMsg` types per SPEC §9
- [ ] `apps/worker/src/do/ChatRoom.ts` using Hibernation API (`ctx.acceptWebSocket`)
- [ ] DO SQLite `messages_local` table; write-through to D1 via `env.DB`
- [ ] `apps/worker/src/routes/rooms.ts` — `GET /api/rooms/:rid/ws` upgrade
- [ ] `apps/worker/src/routes/messages.ts` — `GET /api/rooms/:rid/messages` with `before` cursor
- [ ] Backpressure: 100 msg/sec per room, 4096 char/msg cap
- [ ] DO unit tests (miniflare); integration test for WS round-trip

## Definition of Done
- [ ] Two `wscat` (or browser tab) sessions to the same room exchange messages
- [ ] Disconnect/reconnect resumes from `sinceMessageId`
- [ ] DO hibernates after 30s idle (verified via `wrangler tail`)
- [ ] D1 mirror consistent within 1s of DO insert
- [ ] Killing the DO mid-write does not lose acknowledged messages
- [ ] All tests pass; CI green

## Open questions touched
- Q10 (threading) — POC default is no threading; `parent_id` exists in schema but is not used

## Subagent guidance
**Fan out**: once `packages/shared/src/ws-protocol.ts` is committed, split into two parallel subagents — one for the DO + WS server, one for the WS client utilities in `apps/web/src/lib/ws.ts` (even before M3 ships full UI). The protocol is the contract; both sides can build against it concurrently.

## Out of scope
- Frontend chat UI (M3)
- Threading UX
- Presence / typing indicators
- File uploads
EOF
)" "m2"

# ─── M3 ────────────────────────────────────────────────────────────────────
create_issue "M3: Frontend shell + chat UI" "$(cat <<'EOF'
## Milestone
- **ID**: M3 — SPEC §19 milestone M3
- **Estimated**: 1–2 Claude Code sessions at xhigh

## Intent
The first user-facing surface. App shell, Access-aware login flow, room list, room view with the WebSocket client wired up. After this, you can chat in a real browser.

## Required reading (turn 1)
- `CLAUDE.md`
- `SPEC.md` §4, §6, §11 (wiki surface), §19 → M3
- ❗ Resolve SPEC Q3 (frontend framework) and Q4 (editor) before starting

## Deliverables
- [ ] `apps/web` skeleton in chosen framework (Q3)
- [ ] Routes: `/` (workspace home), `/r/:slug` (room), `/login`
- [ ] Access cookie-aware fetch wrapper in `apps/web/src/lib/api.ts`
- [ ] WebSocket client (`apps/web/src/lib/ws.ts`) w/ exponential reconnect
- [ ] Room list sidebar + room view + message composer
- [ ] Markdown rendering for messages (GFM minimum)
- [ ] Cloudflare Pages deploy config

## Definition of Done
- [ ] Browser end-to-end: log in, pick a room, send a message, see it echo
- [ ] Reload preserves history (calls `GET /messages` then opens WS)
- [ ] WS reconnects gracefully after `wrangler dev` restart
- [ ] No console errors on happy path
- [ ] PR opened, CI green

## Open questions touched
- **Q3 (frontend framework)** — must be answered first
- **Q4 (editor)** — only the message composer here; full editor lands in M4

## Subagent guidance
**Fan out**: routes, components, and the WS client utilities are largely independent — three parallel subagents are reasonable once the framework choice and project structure are committed.

## Out of scope
- Wiki UI (M4)
- Search bar (M6)
- Proposal inbox (M7)
- Mobile-specific layout (defer)
EOF
)" "m3"

# ─── M4 ────────────────────────────────────────────────────────────────────
create_issue "M4: Wiki R/W + Artifacts integration" "$(cat <<'EOF'
## Milestone
- **ID**: M4 — SPEC §19 milestone M4
- **Estimated**: 1 Claude Code session at xhigh

## Intent
Read/write markdown wiki pages backed by Cloudflare Artifacts. Edits in the UI commit to the vault repo; `git clone` shows the same content.

## Required reading (turn 1)
- `CLAUDE.md`
- `SPEC.md` §4, §6, §7.2 (vault layout), §8 (API surface), §11, §19 → M4
- https://blog.cloudflare.com/artifacts-git-for-agents-beta/

## Deliverables
- [ ] `apps/worker/src/lib/artifacts.ts` — typed Artifacts client (use binding if available, REST API otherwise)
- [ ] `scripts/bootstrap-vault.ts` — copies `vault-template/` into a fresh Artifacts repo
- [ ] `vault-template/AGENTS.md` per SPEC §10.1
- [ ] `vault-template/README.md` and `vault-template/wiki/_index.md`
- [ ] Routes: `GET /api/wiki/*`, `PUT /api/wiki/*`, `DELETE /api/wiki/*`, `GET /api/wiki-tree`
- [ ] Frontmatter parsing (gray-matter or remark-frontmatter)
- [ ] Wiki page viewer + editor in `apps/web` (editor per Q4)
- [ ] Conflict detection (409 on stale write); 3-way merge UI

## Definition of Done
- [ ] Edit a page in UI → commit appears in Artifacts repo within 2s
- [ ] `git clone` of the vault shows the same content as the UI
- [ ] Concurrent edit returns 409 with both versions
- [ ] Wiki tree loads in < 200ms from cold cache
- [ ] Tests cover read, write, delete, conflict
- [ ] PR opened, CI green

## Open questions touched
- **Q4 (editor)** — must be answered
- Q5 (markdown flavor) — affects link parsing
- Q9 (direct human edits) — POC default is yes

## Subagent guidance
None for the worker side (sequential — client → routes → tests). Editor wiring in `apps/web` can be a parallel subagent once the routes are fixed.

## Out of scope
- AI-generated proposals (M7)
- AI search over the wiki (M6)
- Image / attachment uploads
- Per-page permissions
EOF
)" "m4"

# ─── M5 ────────────────────────────────────────────────────────────────────
create_issue "M5: Daily chat-log commit cron" "$(cat <<'EOF'
## Milestone
- **ID**: M5 — SPEC §19 milestone M5
- **Estimated**: half a Claude Code session

## Intent
Every day at 02:00 UTC, aggregate the previous day's messages per room from D1 and commit them as markdown files to the Artifacts vault under `/rooms/{slug}/log/{date}.md`.

## Required reading (turn 1)
- `CLAUDE.md`
- `SPEC.md` §4, §5 (cron trigger), §7.2 (vault layout), §19 → M5

## Deliverables
- [ ] Cron handler in `apps/worker/src/scheduled.ts`
- [ ] Per-room aggregator: `messages WHERE room_id=:rid AND created_at BETWEEN :start AND :end`
- [ ] Markdown formatter producing the file shape from SPEC §7.2
- [ ] Frontmatter with room, date, message_count, ingest_run_ids (empty until M7)
- [ ] Idempotent: re-running for the same date overwrites cleanly
- [ ] Test using `wrangler triggers cron` locally

## Definition of Done
- [ ] Local cron trigger produces the expected file in a test Artifacts repo
- [ ] File matches SPEC §7.2 schema exactly
- [ ] Re-running produces the same content (deterministic ordering)
- [ ] PR opened, CI green

## Open questions touched
- Q7 (ingest cadence) — POC ingest is manual; this is the *log archive* cron, separate concern

## Subagent guidance
None. Single sequential job.

## Out of scope
- AI ingest (M7)
- Real-time log streaming
- Log compression / archival policy
EOF
)" "m5"

# ─── M6 ────────────────────────────────────────────────────────────────────
create_issue "M6: AI Search + /ask" "$(cat <<'EOF'
## Milestone
- **ID**: M6 — SPEC §19 milestone M6
- **Estimated**: 1 Claude Code session at xhigh

## Intent
Hybrid (BM25 + vector) search over `/wiki/**` via Cloudflare AI Search, and the `/ask` RAG endpoint that returns cited answers. The wiki becomes queryable.

## Required reading (turn 1)
- `CLAUDE.md`
- `SPEC.md` §4, §5 (vars: AI_SEARCH_INSTANCE), §7.3, §8 (search/ask routes), §13 (observability), §19 → M6
- https://developers.cloudflare.com/ai-search/

## Deliverables
- [ ] `DEPLOY.md` section: one-time AI Search instance bootstrap (manual, doc'd)
- [ ] `apps/worker/src/lib/ai-search.ts` — typed client
- [ ] `apps/worker/src/lib/llm.ts` — AI Gateway-aware LLM client (Workers AI default; BYOK fallback)
- [ ] `POST /api/search` — returns ranked hits with snippets
- [ ] `POST /api/ask` — RAG: search top-k + LLM synthesis with citations, **streamed**
- [ ] Search bar in `apps/web`
- [ ] `/ask` UI with streaming + citation pills
- [ ] AI Gateway proxy wired; verify spend visible in dashboard

## Definition of Done
- [ ] 3-word query returns results in < 500ms p50 against ≥ 100-page test corpus
- [ ] `/api/ask` returns a streamed answer with ≥ 2 citations in < 5s p50
- [ ] Citations link to wiki pages and resolve correctly
- [ ] AI Gateway shows the calls
- [ ] PR opened, CI green

## Open questions touched
- **Q12 (default LLM)** — must be answered
- Q11 (BYOK storage) — adjacent; POC can stub BYOK lookup, full impl in M8

## Subagent guidance
None for the worker side. Search bar and `/ask` UI in `apps/web` can be parallel subagents.

## Out of scope
- Ingest agent (M7)
- BYOK key management UI (M8)
- Search ranking customization
- Federated / multi-source search
EOF
)" "m6"

# ─── M7 ────────────────────────────────────────────────────────────────────
create_issue "M7: Ingest agent + proposal inbox" "$(cat <<'EOF'
## Milestone
- **ID**: M7 — SPEC §19 milestone M7
- **Estimated**: 1–2 Claude Code sessions at xhigh

## Intent
The marquee feature. An AI agent reads recent chat, references the vault's `AGENTS.md` schema, and produces wiki page proposals. Humans review and merge via a UI.

## Required reading (turn 1)
- `CLAUDE.md`
- `SPEC.md` §4, §6, §7.1 (proposals table), §10 (full ingest spec, including AGENTS.md template), §11 (proposal UX), §19 → M7
- Karpathy's `llm-wiki.md` gist: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

## Deliverables
- [ ] `apps/worker/src/agents/IngestAgent.ts` (Cloudflare Agents SDK)
- [ ] `packages/agents-prompts/src/ingest.ts` — system prompt builder
- [ ] Structured-output schema (Zod) for the LLM response
- [ ] `POST /api/rooms/:rid/ingest` — manual trigger (returns run id + proposal count)
- [ ] `GET /api/runs/:id`, `GET /api/proposals?status=pending`, `GET /api/proposals/:id`
- [ ] `POST /api/proposals/:id/merge` — commits to Artifacts; `POST .../reject`
- [ ] Golden-file tests: `packages/agents-prompts/__fixtures__/`
- [ ] Proposal inbox UI: list, diff view, merge / reject buttons

## Definition of Done
- [ ] Manual trigger on a room with ≥ 50 messages of substantive discussion produces ≥ 1 proposal
- [ ] Merging a proposal creates a commit in the Artifacts vault
- [ ] Rejecting marks the proposal `status='rejected'` and never re-proposes the same content next run
- [ ] Failed runs leave a `failed` row, never a stuck `running` row (use `step.do`)
- [ ] Run with no new messages exits in < 1s with 0 proposals
- [ ] LLM calls visible in AI Gateway
- [ ] Golden tests pass
- [ ] PR opened, CI green

## Open questions touched
- **Q12 (default LLM)** — must be answered
- Q8 (proposal mechanism) — POC default: D1 status field, commit on merge
- Q17 (AGENTS.md user-editable) — POC default: yes
- Q20 (auto-merge tier) — POC default: human-merge only

## Subagent guidance
**Fan out** into three parallel subagents once §10.2 lifecycle is committed:
1. `IngestAgent` core (worker)
2. Prompt + golden fixtures (`packages/agents-prompts`)
3. Proposal inbox UI (`apps/web`)

## Out of scope
- Cron-driven ingest (defer to v0.1)
- Auto-merge of low-risk proposals
- Lint / nightly synthesis workflow (Karpathy's "lint" pass — defer to v0.1)
EOF
)" "m7"

# ─── M8 ────────────────────────────────────────────────────────────────────
create_issue "M8: BYOK + observability + polish" "$(cat <<'EOF'
## Milestone
- **ID**: M8 — SPEC §19 milestone M8
- **Estimated**: 1 Claude Code session at xhigh

## Intent
Ship-ready polish. BYOK key management with envelope encryption, Sentry, AI Gateway dashboards, smoke checklist, README, DEPLOY.md. After this, the POC is dogfood-ready and §18 (whole-product DoD) passes.

## Required reading (turn 1)
- `CLAUDE.md`
- `SPEC.md` §11 (settings UX), §13 (observability), §17 (out of scope), §18 (whole-product DoD), §19 → M8
- `docs/SECURITY.md`

## Deliverables
- [ ] `apps/worker/src/lib/crypto.ts` — envelope encryption with `BYOK_ENCRYPTION_KEY`
- [ ] BYOK key CRUD: `GET/POST/DELETE /api/workspaces/:wid/byok/:provider`
- [ ] BYOK settings UI under `/settings/byok`
- [ ] AGENTS.md viewer/editor under `/settings/agents`
- [ ] Sentry init in worker (`@sentry/cloudflare`); request ID propagation
- [ ] Workers Analytics Engine emit per SPEC §13
- [ ] `docs/SMOKE.md` — manual smoke checklist matching SPEC §18 DoD
- [ ] `DEPLOY.md` — one-click + manual instructions, three auth tiers per §12
- [ ] `README.md` polish (Q1 name resolved)
- [ ] Deploy-to-Cloudflare button assets

## Definition of Done
- [ ] Every line of SPEC §18 (whole-product DoD) passes
- [ ] Smoke checklist runs clean end-to-end
- [ ] Sentry captures a deliberate test error
- [ ] AI Gateway dashboard shows < $0.50 spend across smoke run
- [ ] Monthly cost projection (with dogfood team active) < $10
- [ ] README has the Deploy-to-Cloudflare button rendered
- [ ] PR opened, CI green
- [ ] Tag `v0.0.1` after merge

## Open questions touched
- **Q1 (name)** — README needs the final name
- **Q19 (dogfood team size)** — affects whether team-tier auth docs are needed in DEPLOY.md
- Q11 (BYOK storage model) — implementation lands here
- Q14 (telemetry) — POC default: none

## Subagent guidance
**Fan out**: BYOK encryption (worker), BYOK UI (web), and the docs (`README.md`, `DEPLOY.md`, `SMOKE.md`) are independent — three parallel subagents.

## Out of scope (strictly defer)
- Anything in SPEC §17
- Mobile native wrappers
- Multi-workspace
- Auto-merge proposals
EOF
)" "m8"

echo ""
echo "Done. View: gh issue list --label milestone"
