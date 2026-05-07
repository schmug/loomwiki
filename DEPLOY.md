# Loomwiki — Deployment

> Operator guide for self-hosting Loomwiki on a Cloudflare account. The full
> deploy story rounds out across M1–M8; this file grows with each milestone.
> M1 covers auth + the data layer.

## Quick path: dogfood deploy on `loomwiki.cortech.online`

The reference deploy is a single-domain setup:

- **Worker** (`loomwiki-api`) handles `/api/*` on `loomwiki.cortech.online`.
- **Pages** project (`loomwiki-web`) serves everything else on the same hostname (Astro SSR).
- Workers route patterns take precedence over Pages custom domains for overlapping paths, so both coexist on one hostname without subdomain splits.

The full setup is in this file's section-by-section flow — DNS → bindings → Access → secrets → deploy. The cortech-specific pattern is in §M7-dogfood at the bottom; the rest of the file is generic and works for any operator's domain.

## Prerequisites

- A Cloudflare account (free tier is fine for the dogfood deploy).
- `wrangler` CLI authenticated (`wrangler login`).
- pnpm 10.x and Node 22.x.

## One-time setup

### 1. Create the D1 database and KV namespaces

```sh
wrangler d1 create loomwiki
wrangler kv namespace create CACHE
wrangler kv namespace create WIKI_KV   # M4 wiki content storage
```

Copy the `database_id` and `id` values into `wrangler.jsonc` (replace the
`<TBD>` placeholders).

The `WIKI_KV` namespace is the v0.0.1 wiki content store; M4.5 will swap
it for git-backed persistence against the Artifacts vault repo. See
`docs/ADR/0003-artifacts-as-vault.md`.

### 2. Set up Cloudflare Access

Loomwiki's auth is Cloudflare Access (free tier, email OTP). The worker
verifies the `CF-Access-Jwt-Assertion` header on every authenticated request
(see `apps/worker/src/lib/auth.ts`). Without Access in front, the worker is
inaccessible — **the local-dev bypass is the only escape hatch and is
disabled by default**.

#### a. Create the Zero Trust team

If you don't already have one: open the Cloudflare dashboard → **Zero Trust**
→ accept the free plan. Pick a team name; the resulting subdomain is
`<team>.cloudflareaccess.com`. That `<team>` value is your `ACCESS_TEAM`.

#### b. Create the Access application

In **Zero Trust → Access → Applications → Add an application**:

- **Type**: Self-hosted.
- **Application domain**: the public domain you'll route the worker on (per
  `wrangler.jsonc` `routes`, e.g. `api.loomwiki.com`).
- **Identity providers**: enable **One-time PIN** for the simplest setup. Add
  GitHub OAuth or Google Workspace if you want SSO.
- **Policy**: create one **Allow** policy with the email addresses (or
  domains) you want to grant access. Service tokens, if any, must use the
  separate **Service Auth** policy action — never **Allow**.

Save. On the application overview, copy the **Application Audience (AUD)**
tag — that's your `ACCESS_AUD`.

#### c. Plumb the values into the worker

Two options:

- **Recommended (production)**: set `ACCESS_TEAM` and `ACCESS_AUD` as vars in
  the Cloudflare dashboard under **Workers → loomwiki-api → Settings →
  Variables**. They override the defaults in `wrangler.jsonc`.
- **Alternative (single-deploy fork)**: edit the `vars` block in
  `wrangler.jsonc` to replace the dev placeholders. Commit only if your fork
  is private — these aren't secrets but they identify your tenant.

The dev placeholders in `wrangler.jsonc` (`loomwiki-dev`, `loomwiki-dev-aud`)
are wrong on purpose: a fresh deploy fails closed if the operator forgets to
set real values.

### 3. Apply the D1 migrations

```sh
pnpm migrate:remote      # against the production DB
```

Run this once at deploy time and again whenever you pull new migrations.
Migrations are forward-only — a new migration is a new file in
`packages/schema/d1-migrations/`, never an edit to a committed file.

For local development:

```sh
pnpm migrate:local       # against the local miniflare DB at .wrangler/state/v3/d1
```

To verify the schema applied:

```sh
wrangler d1 execute loomwiki --local --config wrangler.jsonc \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

You should see `byok_keys, ingest_runs, messages, proposals, room_members, rooms, users, workspaces` (plus the wrangler-internal `d1_migrations` and `sqlite_*`).

### 4. Set Worker secrets (M8 will use these; M1 doesn't)

```sh
wrangler secret put SENTRY_DSN
wrangler secret put BYOK_ENCRYPTION_KEY     # openssl rand -base64 32
wrangler secret put ARTIFACTS_TOKEN
wrangler secret put AI_GATEWAY_TOKEN
```

### 5. Deploy

```sh
pnpm deploy:worker
```

(Note: `pnpm deploy` without `run` collides with pnpm's built-in
"deploy a workspace package" command. Use `deploy:worker` /
`deploy:web` / `deploy:all` — the colon disambiguates.)

## Local development

```sh
cp .dev.vars.example .dev.vars
# edit .dev.vars — set LOCAL_DEV_EMAIL, leave ALLOW_LOCAL_DEV_AUTH=true
pnpm dev
```

The worker boots on `http://127.0.0.1:8788`. Hit `/api/me` with the
`X-Local-Dev-Email` header instead of an Access JWT:

```sh
curl -s -H "X-Local-Dev-Email: cory@example.com" http://127.0.0.1:8788/api/me | jq .
```

### How the local-dev bypass is gated

The `X-Local-Dev-Email` header is honored only when **all three** conditions
hold:

1. `process.env.NODE_ENV !== "production"` — symbolic check; `NODE_ENV` is
   undefined in the production Workers runtime, so this passes by default.
   Mostly a tripwire for accidental builds-with-NODE_ENV-set.
2. `env.ALLOW_LOCAL_DEV_AUTH === "true"` — operator must explicitly opt in.
   Default is `"false"` in `wrangler.jsonc`. Production deployments must
   leave it that way.
3. `CF-Connecting-IP` is absent or one of `127.0.0.1` / `::1`. In production
   Cloudflare always sets this header to the real client IP, so the bypass
   is unreachable from the public internet.

Failing any one gate causes the worker to fall back to JWT validation, which
then fails closed with `AUTH_REQUIRED` since no Access JWT was supplied.
There is no single-flag bypass.

If you suspect the bypass is leaking in production, search `wrangler tail`
for `LOCAL DEV AUTH ENABLED` — the worker logs that warning the first time
the gate trips per isolate.

### Invalidating the JWKS cache during dev

The Access JWKS is cached in KV for 24 hours. If you rotate Access keys
(rare) and want to force a refresh:

```sh
curl -X POST http://127.0.0.1:8788/api/_debug/invalidate-jwks
```

This route returns `404` unless `ALLOW_LOCAL_DEV_AUTH=true`.

## Migration runbook (operator)

```sh
# Add a new migration:
pnpm migrate:new add_audit_log

# Apply locally:
pnpm migrate:local

# Apply to production after the change merges:
pnpm migrate:remote
```

Migrations are idempotent: re-running `migrate:remote` after a successful
apply is a no-op. To roll back, write a forward migration that undoes the
change — never edit a committed migration file (CLAUDE.md "Do not touch").

## Wiki vault (M4)

Loomwiki uses Cloudflare Artifacts for the workspace's vault repo
(SPEC §7.2; ADR-0003). The Workers binding is declared in
`wrangler.jsonc` as:

```jsonc
"artifacts": [{ "binding": "ARTIFACTS", "namespace": "default" }]
```

The vault repo is **created lazily on first request** that needs it
(`env.ARTIFACTS.create(env.ARTIFACTS_REPO)`). No one-time setup is
needed beyond having the binding wired and your account on the
Artifacts allowlist.

### Verifying Artifacts is provisioned

The simplest check is to call the bootstrap admin route once
post-deploy:

```sh
curl -X POST -H "X-Local-Dev-Email: cory@example.com" \
  http://127.0.0.1:8788/api/_admin/wiki/bootstrap-vault | jq .
```

The first response contains `bootstrap.repoName` and
`bootstrap.remote` — the public HTTPS git endpoint of your vault.
Subsequent calls are no-ops (idempotent).

### Cloning the vault from outside

To `git clone` your vault repo for backup or external editing, mint a
short-lived token via the admin route:

```sh
TOKEN_PAYLOAD=$(curl -s -X POST -H "X-Local-Dev-Email: cory@example.com" \
  -H "Content-Type: application/json" \
  -d '{"scope":"read","ttl_seconds":3600}' \
  http://127.0.0.1:8788/api/_admin/wiki/vault-token)

ARTIFACTS_TOKEN=$(echo "$TOKEN_PAYLOAD" | jq -r '.data.token')
ARTIFACTS_REMOTE=$(echo "$TOKEN_PAYLOAD" | jq -r '.data.remote')

git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" \
  clone "$ARTIFACTS_REMOTE" /tmp/loomwiki-vault
```

The token is workspace-owner-only and never logged. It expires after
the requested TTL (default 1 hour, max 1 year).

> **v0.0.1 caveat**: in M4 the wiki **content** is persisted in
> `WIKI_KV` rather than pushed to the git remote. A fresh `git clone`
> returns an empty (or seed-only) repo today. M4.5 starts pushing wiki
> content via `repo.createToken("write")` and isomorphic-git so
> `git clone` returns the same content the UI shows.

### Local-dev limitation

Miniflare does not currently host the Artifacts binding — calling the
`bootstrap-vault` or `vault-token` routes against `wrangler dev
--local` will fail because the binding is "remote-only." Two options:

1. **Run the route tests** in vitest — they use a typed in-memory fake
   binding (`apps/worker/src/__tests__/__fixtures__/fake-artifacts.ts`)
   and a `KvWikiBackend` against miniflare's KV. Full backend
   coverage, no network.
2. **Use `wrangler dev --remote`** to talk to real Artifacts on
   Cloudflare's network. Acceptable for live smoke tests; expect
   real billing.

### Recovering from a corrupted vault

If a vault repo gets into a bad state:

1. `git clone` it locally with a write-scoped token.
2. Fix the content; `git push --force` to the same remote.
3. The next UI read will reflect the new state (the M4.5 git backend
   reads via the same remote; the M4 KV backend is independent and
   needs a separate `WIKI_KV` reset via `wrangler kv key delete --prefix wiki:`).

For a clean start: delete the repo via `env.ARTIFACTS.delete(name)` (or
the dashboard) and call the bootstrap admin route again.

## Daily chat-log archival cron (M5)

Loomwiki runs a Workers cron at **02:00 UTC daily** that aggregates the
previous calendar day's chat messages from D1 and writes one markdown
file per room to the vault under `/rooms/{slug}/log/{YYYY-MM-DD}.md`.
The schedule is declared in `wrangler.jsonc`:

```jsonc
"triggers": { "crons": ["0 2 * * *"] }
```

The handler lives in [`apps/worker/src/scheduled.ts`](apps/worker/src/scheduled.ts)
and calls `archiveDay()` from [`apps/worker/src/lib/chat-log.ts`](apps/worker/src/lib/chat-log.ts).
Re-running for the same date is a no-op at the content level — the
formatter is deterministic and the backend writes are last-write-wins,
so byte-identical output overwrites the previous file cleanly.

### Verifying the cron is firing in production

Cloudflare dashboard → **Workers & Pages → loomwiki-api → Triggers**
shows the cron schedule and the last few invocation results. The
handler emits a structured log line on each successful run; tail it
with:

```sh
wrangler tail --format pretty | grep archive_run_complete
```

### Manual backfill (operator)

To archive an arbitrary past day (e.g. for a fresh deploy that has
existing chat history, or after a vault reset):

```sh
DATE=2026-05-03
curl -s -X POST -H "X-Local-Dev-Email: cory@example.com" \
  "http://127.0.0.1:8788/api/_admin/cron/archive-day?date=$DATE" | jq .
# Expected: { ok: true, data: { date: "...", files_written: N, rooms_processed: M, errors: [] } }
```

In production, swap the `X-Local-Dev-Email` header for the Access JWT
the operator's logged-in browser session uses (the route is
workspace-owner-only). The endpoint is idempotent — re-running for
the same date overwrites the file cleanly and is safe to invoke
repeatedly.

### Local-dev path

`wrangler dev --test-scheduled` exposes a `/__scheduled` endpoint that
fires the handler synchronously without waiting for the cron to tick:

```sh
pnpm --filter @loomwiki/worker dev --test-scheduled --port 8788
# in another shell:
curl -s "http://127.0.0.1:8788/__scheduled?cron=0+2+*+*+*"
```

Watch `wrangler tail` for the `archive_run_complete` log line.

## AI Search + /ask + cost guards (M6)

M6 wires hybrid search over `/wiki/**` and the `/ask` RAG endpoint. Two
pieces of operator setup beyond the standard deploy: provisioning the
AI Search instance and configuring the AI Gateway daily cap.

### 1. Provision the AI Search instance

```sh
# One-time per workspace deploy. The instance name is what
# wrangler.jsonc references in the ai_search binding block.
wrangler ai-search create loomwiki-search \
  --data-source artifacts \
  --filter "path: /wiki/**"
```

The dashboard equivalent: **AI → AI Search → Create instance →
Source: Artifacts → Repo: <your loomwiki vault> → Filter: path glob
`/wiki/**`**.

After creation, the binding in `wrangler.jsonc` (`ai_search.binding =
"AI_SEARCH"`, `instance_name = "loomwiki-search"`) wires it to the
worker. Auto-detect: if the binding is missing or the instance name is
wrong, search auto-falls-back to the D1 FTS5 index — the worker logs a
warning and the web UI shows "Showing keyword matches only — semantic
search is unavailable." See `docs/ADR/0004-search-rag-layering.md` for
the rationale.

### 2. Bootstrap the index

After the AI Search instance is provisioned and the worker is deployed,
trigger an initial index of the existing wiki via the admin route:

```sh
curl -s -X POST -H "X-Local-Dev-Email: cory@example.com" \
  http://127.0.0.1:8788/api/_admin/search/reindex | jq .
# Expected: { ok: true, data: { pages_indexed: N, errors: [] } }
```

In production, swap the dev header for the Access JWT from a
workspace-owner browser session. The route walks
`WikiBackend.listPaths('/wiki/')`, reads each page, and upserts it into
both AI Search and the D1 FTS5 index. Per-page failures are logged but
don't abort the whole run (matches the M5 archive isolation pattern).

The route is idempotent — re-running it after a partial failure or
schema migration is safe. Subsequent wiki edits via `PUT /api/wiki/*`
re-upsert automatically; the admin route is only for backfill.

### 3. Configure the AI Gateway daily cap (third layer of cost defense)

The cost guards in `lib/cost-guard.ts` enforce per-user and
per-workspace daily caps inside the worker. The third layer — a hard
cap that survives a worker bug — lives in the AI Gateway dashboard:

1. Open **AI → AI Gateway → Create gateway** (skip if you already
   have one).
2. Note the gateway slug (the path segment in
   `https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{SLUG}/...`).
3. **Settings → Logs & Costs → Daily request cap**: set to the
   per-deploy ceiling. Recommended starting value: **5000 ask
   requests/day per workspace deploy**. Adjust to match the
   per-workspace ask cap in `wrangler.jsonc` plus headroom for cache
   hits and embedding calls.
4. Set the gateway slug as `AI_GATEWAY_ID` and your account ID as
   `CF_ACCOUNT_ID` in `wrangler.jsonc` `vars`. Without these, the
   worker bypasses the gateway and you lose the third layer.
5. Mint an AI Gateway token (**API tokens → Create token → Workers AI
   → AI Gateway: Run**) and set it as a Worker secret:

   ```sh
   wrangler secret put AI_GATEWAY_TOKEN
   ```

The two in-worker layers (`LLM_DAILY_LIMIT_PER_USER_*` and
`LLM_DAILY_LIMIT_PER_WORKSPACE_*` in `wrangler.jsonc` `vars`) plus the
gateway cap give defense in depth — see ADR-0004 §c for why all three
are necessary.

### 4. Tune the daily limits

```jsonc
"vars": {
  "LLM_DAILY_LIMIT_PER_USER_ASK": "100",
  "LLM_DAILY_LIMIT_PER_USER_SEARCH": "1000",
  "LLM_DAILY_LIMIT_PER_WORKSPACE_ASK": "1000",
  "LLM_DAILY_LIMIT_PER_WORKSPACE_SEARCH": "10000"
}
```

Defaults are conservative for a small dogfood team. Rate-limited
requests get `429 RATE_LIMITED` with
`details: { limit, used, scope, reset_at }`; the web UI's
`RateLimitBanner` renders the localtime reset.

### 5. (Optional) Force the FTS5 fallback

```jsonc
"vars": {
  "AI_SEARCH_ENABLED": "false"
}
```

Skips the AI Search call entirely and goes straight to the D1 FTS5
index. Useful for comparing result quality, debugging an AI Search
outage, or running a fork that doesn't have AI Search enabled.

### Local-dev path

Two important limitations:

- **AI Search is remote-only.** Local dev (`wrangler dev` with
  `wrangler.dev.jsonc`) doesn't define the `ai_search` binding; the
  worker auto-detects the missing binding and silently falls back to
  FTS5. Search results carry `mode: "fts5_fallback"` and the web UI
  shows the fallback banner. To exercise the AI Search path live,
  use `wrangler dev --remote --config wrangler.jsonc`.
- **Workers AI hits the real service in dev.** Unlike Artifacts,
  Workers AI dispatches to Cloudflare's real backend even in local
  dev — `pnpm dev` against the default Llama model spends free-tier
  neurons. The cost guards still apply. `lib/llm.ts` emits a one-time
  warning the first time a non-BYOK call goes out so you don't
  forget. To run dev with no LLM cost: set
  `LLM_DAILY_LIMIT_PER_USER_ASK=0` to refuse all calls.

### Smoke verification

```sh
# Bootstrap a small wiki via the M4 routes (or via the bootstrap-vault
# admin route). Then:

DEV_HEADER='X-Local-Dev-Email: cory@example.com'

# Reindex (FTS5 always; AI Search if available):
curl -s -X POST -H "$DEV_HEADER" \
  http://127.0.0.1:8788/api/_admin/search/reindex | jq .

# Search:
curl -s -X POST -H "$DEV_HEADER" -H "Content-Type: application/json" \
  -d '{"query":"DMARC","topK":5}' \
  http://127.0.0.1:8788/api/search | jq .
# Local dev expected: { ok: true, data: { results: [...], mode: "fts5_fallback" } }
# Prod expected:      { ok: true, data: { results: [...], mode: "hybrid" } }

# /ask (SSE — note -N to disable curl buffering):
curl -N -X POST -H "$DEV_HEADER" -H "Content-Type: application/json" \
  -d '{"question":"What is our DMARC policy?"}' \
  http://127.0.0.1:8788/api/ask
# Expected: streaming SSE; data lines with "delta", then `event: citations`
# carrying the citation array, then `event: done`.
```

The cost-guard 429 is reachable by lowering the per-user cap to a
small number and calling /ask repeatedly:

```sh
# After exceeding the cap:
# {"ok":false,"error":{"code":"RATE_LIMITED","message":"...",
#   "details":{"limit":2,"used":2,"scope":"user","reset_at":"..."}}}
```

## Ingest agent + proposal inbox (M7)

M7 wires the marquee feature: chat → wiki proposals → human review →
merged wiki. The agent runs on two paths that converge on the same
code: a manual trigger (`POST /api/rooms/:rid/ingest`) and a daily
cron at 03:00 UTC. Operator setup is the cron schedule + a single
optional env var.

### 1. Cron schedule

`wrangler.jsonc` declares both the M5 archive and the M7 ingest
schedules:

```jsonc
"triggers": {
  "crons": ["0 2 * * *", "0 3 * * *"]
}
```

The 03:00 UTC schedule fires 60 minutes after the M5 archive cron lands
yesterday's chat logs. The handler in
[`apps/worker/src/scheduled.ts`](apps/worker/src/scheduled.ts)
dispatches by `controller.cron`:

| Cron | Handler | What it does |
|------|---------|--------------|
| `0 2 * * *` | `runArchive()` | Aggregates yesterday's chat → `/rooms/<slug>/log/<date>.md` |
| `0 3 * * *` | `runIngestScan()` | Triggers `runIngestForRoom()` per room; renders `/wiki/_inbox/<today>.md` |

### 2. Tune the ingest cost guard

```jsonc
"vars": {
  "INGEST_DAILY_LIMIT_PER_WORKSPACE": "100"
}
```

Workspace-scoped only — there is no per-user ingest cap. The cron and
manual triggers share the budget. 100 runs/day gives comfortable
headroom for a dogfood team (~10 runs/day) plus admin backfill.

### 3. Verifying the cron is firing in production

Cloudflare dashboard → **Workers & Pages → loomwiki-api → Triggers**
shows both schedules. The handler emits structured log lines
(`event: ingest_scan_complete`); tail with:

```sh
wrangler tail --format pretty | grep -E 'ingest_scan_complete|archive_run_complete'
```

### 4. Manual ingest trigger

To trigger an ingest run on demand from a chat room — useful for
backfill, smoke verification, or after a fix:

```sh
ROOM_ID=...   # the room's UUIDv7
curl -s -X POST -H "X-Local-Dev-Email: cory@example.com" \
  "http://127.0.0.1:8788/api/rooms/$ROOM_ID/ingest" | jq .
# Expected (lock acquired):
#   { ok: true, data: { run_id: "...", status: "running" } }
# Expected (another run already in flight; HTTP 202):
#   { ok: true, data: { run_id: "...", status: "lock_held" } }
```

Poll the run status:

```sh
RUN=...
curl -s -H "X-Local-Dev-Email: cory@example.com" \
  "http://127.0.0.1:8788/api/runs/$RUN" | jq .
# .data.run.status walks: running → succeeded | failed
```

Inspect the proposals (if any):

```sh
curl -s -H "X-Local-Dev-Email: cory@example.com" \
  "http://127.0.0.1:8788/api/proposals?status=pending" | jq .
```

### 5. Manual digest re-render (operator backfill)

If you need to re-render a day's digest (e.g., after a fix that
changed the format, or to backfill for a date the cron missed):

```sh
DATE=2026-05-04
curl -s -X POST -H "X-Local-Dev-Email: cory@example.com" \
  "http://127.0.0.1:8788/api/_admin/digest/render?date=$DATE" | jq .
# Expected: { ok: true, data: { delivered: true, path: "/wiki/_inbox/<date>.md" } }
```

The route is owner-only and idempotent — re-runs overwrite the file
cleanly. Underlying renderer is deterministic (`renderDigestMarkdown`
in `lib/digest-template.ts`); identical inputs produce byte-identical
output.

### 6. Local-dev path: invoking the cron

The worker's `--test-scheduled` flag exposes `/__scheduled` for ticking
crons synchronously. Both schedules dispatch through `scheduled.ts`'s
switch:

```sh
pnpm --filter @loomwiki/worker dev --test-scheduled --port 8788
# In another shell:
curl -s "http://127.0.0.1:8788/__scheduled?cron=0+3+*+*+*"
# Triggers the M7 ingest scan + digest render.
```

Watch `wrangler tail` for `ingest_scan_complete`.

### 7. Prompt-injection threat model summary

The agent processes untrusted chat content. Every authenticated
workspace member can attempt to inject instructions; some will. Five
independent guards from `docs/SECURITY.md` §2.2 ship together — skip
any one and the corresponding attack vector opens:

| # | Guard | If skipped |
|---|------|-----------|
| 1 | Input sanitization (NFC + zero-width/bidi/HTML strip) | XSS via stored content (A1, A3) |
| 2 | Structured output (Zod parse + retry) | Free-form text routes around the schema (A1) |
| 3 | Path allowlist (`/wiki/<allow>`) | `/AGENTS.md` hijack (A6) |
| 4 | Secret scrub (regex set) | Leaked credentials echoed to inbox |
| 5 | Admin-merge-only (workspace-owner gate) | All of the above auto-deploy |

Plus source-citation validation (every `message_id` must be in the run
input) closes attack scenario A8 (citation laundering). Each guard has
a dedicated test in
[`apps/worker/src/__tests__/ingest-agent.test.ts`](apps/worker/src/__tests__/ingest-agent.test.ts).

The full threat model lives in
[`docs/SECURITY.md`](docs/SECURITY.md) §2; the design rationale lives
in [`docs/ADR/0005-ingest-agent-design.md`](docs/ADR/0005-ingest-agent-design.md).

### 8. Operator caution: AGENTS.md is privileged

`AGENTS.md` (in the vault, at the top-level `/AGENTS.md`) is the
agent's runtime contract. The §11 sub-sections are operator-
customizable; the rest is part of the security model. The agent
ITSELF cannot propose changes to `/AGENTS.md` (path allowlist drops
them). Operators edit `AGENTS.md` directly via the wiki UI or by
pushing to the vault repo — there is no "admin merge" path that goes
through the proposals queue.

A change to `AGENTS.md` propagates to running ingest isolates after
the in-memory cache TTL (5 minutes) — fresh Worker isolates pick it
up immediately. Restart the worker (`wrangler deploy`) for an
immediate global cutover.

## Dogfood deploy (`loomwiki.cortech.online`) + live smoke

This section is the cortech-specific reference deploy. The same pattern
works for any operator's domain — replace `loomwiki.cortech.online`
and `cortech.online` with your hostname + zone throughout.

### 1. DNS

- [ ] Confirm `cortech.online` is on Cloudflare's nameservers (Cloudflare dashboard → Websites → your zone → Overview).
- [ ] No A/AAAA record needed for `loomwiki.cortech.online` — both Pages custom domain and Worker route create their own DNS records on attach.

### 2. Bindings (already provisioned in this fork)

Account ID `f0fc4ca5b74274f7ba892e6c9ec411a7` already has:

| Binding | Resource | ID |
|---|---|---|
| `DB` | D1 database `loomwiki` | `2160f5b1-1226-459b-a083-b214498c7283` |
| `CACHE` | KV namespace `CACHE` | `6181f01467c34a7ea5574720ba6be01b` |
| `WIKI_KV` | KV namespace `WIKI_KV` | `01654647cb3a452cabbe27c1b5fb52f0` |
| `ATTACHMENTS` | R2 bucket `loomwiki-attachments` | (named) |

These are already wired into `wrangler.jsonc`. A fork on a different
account replaces them via the standard one-time-setup steps above.

### 3. AI Search — DEFERRED

Wrangler 4.x `ai-search create` only supports `r2`/`web-crawler`
sources, and dashboard provisioning of the Artifacts source requires
the Artifacts allowlist. The dogfood deploy runs on the FTS5 fallback
(`AI_SEARCH_ENABLED: "false"` in `wrangler.jsonc` `vars`); search is
keyword-only. To enable later: dashboard → AI → AI Search → Create
instance named `loomwiki-search`, then uncomment the `ai_search` block
in `wrangler.jsonc` and flip `AI_SEARCH_ENABLED` to `"true"`.

### 4. AI Gateway

- [ ] Dashboard: **AI → AI Gateway → Create gateway**, name `loomwiki`.
- [ ] **Settings → Daily request cap**: 5000 (the third cost-defense layer; ADR-0004 §c).
- [ ] **API tokens → Create token → Workers AI: Run**. Save the value.
- [ ] In `wrangler.jsonc` `vars`: set `AI_GATEWAY_ID` to the gateway slug. (`CF_ACCOUNT_ID` is already set to the cortech account.)

### 5. Cloudflare Access (Zero Trust)

- [ ] **Zero Trust → Access → Applications → Add application → Self-hosted**.
- [ ] Application domain: `loomwiki.cortech.online`.
- [ ] **Identity providers**: enable **One-time PIN** (add GitHub OAuth or Google Workspace if you want SSO).
- [ ] **Policy 1 — operator login**: Action=**Allow**, Include: emails matching your dogfood email(s).
- [ ] **Policy 2 — automated tests**: Action=**Service Auth**.
- [ ] **Service tokens** (Zero Trust → Access → Service Auth → Create Service Token): name `loomwiki-claude-smoke`. Save the **Client ID** and **Client Secret** somewhere safe — the secret is shown once. Attach to Policy 2.
- [ ] Note the **AUD tag** (Access app overview → Application Audience).
- [ ] In `wrangler.jsonc` `vars`: set `ACCESS_TEAM` to your Zero Trust team subdomain (the `<team>` in `<team>.cloudflareaccess.com`) and `ACCESS_AUD` to the AUD tag.

### 6. Worker secrets

```sh
wrangler secret put BYOK_ENCRYPTION_KEY     # paste output of: openssl rand -base64 32
wrangler secret put AI_GATEWAY_TOKEN        # the API token from step 4
# wrangler secret put SENTRY_DSN            # optional
# wrangler secret put ARTIFACTS_TOKEN       # M4.5+; leave unset for v0.0.1 dogfood
```

### 7. Pages project (one-time)

```sh
wrangler pages project create loomwiki-web --production-branch main
```

In the dashboard: **Workers & Pages → loomwiki-web → Custom domains → Add custom domain → `loomwiki.cortech.online`**.

(The Cloudflare dashboard handles the certificate provisioning automatically. Wait for the certificate to go active before attempting your first deploy; usually < 1 minute.)

### 8. Apply migrations + deploy

```sh
pnpm migrate:remote          # D1 migrations 0001–0003
pnpm deploy:worker           # worker (loomwiki-api) — claims the /api/* route
pnpm deploy:web              # Pages (loomwiki-web) — astro build + wrangler pages deploy
# or both:
pnpm deploy:all
```

Verify:

```sh
# Health (the one open route — no Access required):
curl -s https://loomwiki.cortech.online/api/health | jq .

# Authenticated routes return a 302 to the Access challenge:
curl -sI https://loomwiki.cortech.online/api/me | head -3
```

### 9. Bootstrap the vault

Sign in via browser at <https://loomwiki.cortech.online> first — the JIT user-creation runs and your email becomes workspace owner. Then:

```sh
# In a browser shell that has the Access cookie (or via the service
# token if your operator email has Access):
curl -X POST https://loomwiki.cortech.online/api/_admin/wiki/bootstrap-vault \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

This is also reachable from the operator's authenticated browser session via dashboard or `curl`.

### 10. Live smoke (Claude / CI)

Service-token authed end-to-end smoke. Exercises the M7 happy path
(create room → seed → ingest → poll → merge → verify wiki page →
render digest):

```sh
export CF_ACCESS_CLIENT_ID="<token client id>"
export CF_ACCESS_CLIENT_SECRET="<token client secret>"
export LOOMWIKI_BASE_URL="https://loomwiki.cortech.online"

pnpm smoke:live
```

Output is a stepwise log; non-zero exit means the run failed (e.g. ingest run came back `failed`, or a route 404'd). The script is idempotent: re-running on a workspace that already has the smoke room and a merged proposal short-circuits each step.

**Caveats**:

- Message seeding is currently manual (the v0.0.1 REST API doesn't have a POST shape for messages — they flow through the WS protocol). The smoke script logs a warning and skips when the room already has ≥3 messages; for a fresh room, post 3+ messages via the chat UI before running.
- The smoke calls `/api/_admin/digest/render` — that's owner-only. The service token's user identity must match the workspace owner. v0.0.1's single-tenant model assigns ownership to the first user that hits `/api/me`; if you sign in via OTP first, your OTP email is the owner and the service token (a different identity) gets a 403 on admin routes. Workaround: ensure the service-token's email matches your operator email, or use the operator browser session to run the digest render.

## Right-to-deletion (operator note)

Chat messages can be soft-deleted from D1 and the live DO. They cannot be
removed from the Artifacts repo (the wiki + chat-log committed history is
git, immutable by design). This is documented in `docs/SECURITY.md` §M25.
