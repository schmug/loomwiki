# Loomwiki — Deployment

> Operator guide for self-hosting Loomwiki on a Cloudflare account. The full
> deploy story rounds out across M1–M8; this file grows with each milestone.
> M1 covers auth + the data layer.

## Prerequisites

- A Cloudflare account (free tier is fine for the dogfood deploy).
- `wrangler` CLI authenticated (`wrangler login`).
- pnpm 10.x and Node 22.x.

## One-time setup

### 1. Create the D1 database and KV namespace

```sh
wrangler d1 create loomwiki
wrangler kv namespace create CACHE
```

Copy the `database_id` and `id` values into `wrangler.jsonc` (replace the
`<TBD>` placeholders).

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
pnpm deploy
```

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

## Right-to-deletion (operator note)

Chat messages can be soft-deleted from D1 and the live DO. They cannot be
removed from the Artifacts repo (the wiki + chat-log committed history is
git, immutable by design). This is documented in `docs/SECURITY.md` §M25.
