<!-- SPDX-License-Identifier: Apache-2.0 -->

# ADR 0008 — Minimal Sentry envelope sender (deviation from `@sentry/cloudflare`)

- **Status**: Accepted (deliberate deviation)
- **Date**: 2026-05-07
- **Milestone**: M8

## Context

M8 wires Sentry as the unhandled-error sink for the production worker.
The M8 prompt's preference is to use `@sentry/cloudflare`, the first-
party SDK — and that's the right default for most teams.

We deviated: the v0.0.1 worker ships a ~80-line minimal Sentry event
sender in `apps/worker/src/lib/sentry.ts` instead of pulling the SDK
in. The deviation is a v0.0.1 trade-off, not a permanent posture; the
swap-in path is documented below.

## Decision

Ship a minimal Sentry-compatible event sender that:

- Parses the `SENTRY_DSN` shape (`https://<key>@<host>/<projectId>`).
- Emits Sentry "store" envelope events with the fields the project
  actually uses: `event_id`, `timestamp`, `platform`, `level`, `tags`,
  `extra`, `exception`/`message`, `release`.
- Tags every event with `request_id` (from the per-request UUIDv7 in
  `c.var.request_id`) and `user_id` when present.
- Runs PII scrubbing on every event before transmission: strips
  `email`, `displayName`, `api_key`, `token`, `password`,
  `authorization`, `workspace_id` field names; replaces email-shaped
  strings with `[redacted-email]`.
- Fires-and-forgets via `ctx.waitUntil(...)` so a Sentry network blip
  never appears on the request critical path.
- Returns a no-op when `SENTRY_DSN` is unset (local dev, tests
  without Sentry, self-hosters who don't run Sentry at all).

The Hono middleware (`sentryMiddleware()`) installs as a global
`onError` shim, captures only truly unhandled errors (typed
`LoomwikiError` is "handled — no Sentry event"), and re-throws to the
standard error-handler middleware so the API contract stays the same.

## Why not `@sentry/cloudflare`

Three reasons, in priority order:

### 1. OTel transitive surface we don't use

`@sentry/cloudflare` ships with the Sentry OpenTelemetry instrumentation
layer. That's the right call for teams instrumenting traces,
breadcrumbs, fetch instrumentation, and performance monitoring across
many runtimes. Loomwiki v0.0.1 uses none of that — Workers Logs
(`observability.enabled: true`, `head_sampling_rate: 1.0`) covers our
log story, and we don't ship distributed tracing. Pulling the OTel
surface in for one feature (capture an exception) costs binary size
and adds a class of error mode (an OTel layer bug becomes a Sentry
bug) that's invisible to `@cloudflare/vitest-pool-workers`.

### 2. Full testability with stubbed `fetch`

The minimal sender is one file, one default export, and one network
call. `apps/worker/src/__tests__/sentry.test.ts` stubs `fetch` and
asserts on the exact wire shape: DSN parse, PII scrub, header build,
URL build. There's no mocking of an SDK boundary, no test that
incidentally exercises a third-party error path. When the SDK lands
in v0.1, those tests are the regression suite for the swap.

### 3. Surface area matches what we use

The minimal sender exposes precisely what the worker calls:

| What we want | Minimal sender | `@sentry/cloudflare` |
|---|---|---|
| Capture unhandled exceptions | `captureException()` | `Sentry.captureException()` |
| Tag with request_id | `opts.request_id` | `Sentry.setTag()` |
| Scrub PII before send | `scrubPII()` always-on | `beforeSend` hook |
| Source-map support | none | yes |
| Auto-instrumentation | none | yes (fetch, performance) |
| Breadcrumbs | none | yes |
| Profiling | none | partial |

The right-hand column features are the ones we don't need at
v0.0.1's traffic level (a dogfood team of < 10 users). They become
useful at v0.1's broader-self-host scale, which is the inflection
point where the swap should happen.

## What this trade-off costs

Be explicit about what we're giving up:

- **No source-map symbolication.** Stack traces in Sentry show the
  bundled, minified worker output. The worker's bundle is small
  enough to read inline; we accept the friction. The release tag
  (`CF_VERSION_METADATA.id`) is included so an investigator can
  correlate to the source SHA.
- **No auto-instrumentation.** No automatic `fetch` tracing, no
  console-as-breadcrumbs, no transaction recording. The team's debug
  surface is Workers Logs + Sentry-the-error-sink. v0.0.1's incident
  tier doesn't need more.
- **No breadcrumbs.** A captured exception ships with the error and
  request metadata only — no "what happened in the 30 seconds before
  the throw." When this bites in production, it's the v0.1 trigger.
- **No retry / queue / batching.** A `fetch` that fails to reach
  Sentry's host drops the event silently. Acceptable: Sentry is an
  observability sink, not a critical-path dependency. The error is
  caught by Workers Logs in any case.
- **No `Sentry.withScope` / nested context.** All `extra` and `tags`
  are caller-supplied per call. We don't have a deep call tree that
  benefits from contextual stacking.

## Honesty on the deviation

The advisor's instinct in the M8 prompt — prefer the SDK — is the
right default. We're not arguing the SDK is wrong; we're arguing it's
overkill *for v0.0.1*, and that paying for it now means committing
to a transitive surface (OTel) we'd rather observe before adopting.
The minimal sender is small enough to read end-to-end in a sitting,
covers the only Sentry surface we use, and inverts cleanly to the SDK
when scale demands.

This is a **load-bearing scope cut**, not a "we'll do it later that we
won't." See the swap recipe below.

## Consequences

### Positive

- One file (~80 lines of meaningful code), one test file, zero
  npm dependencies for the observability surface.
- PII scrubbing is unconditional, defense-in-depth alongside
  `lib/byok.ts`'s primary "plaintext keys never reach the logger"
  contract.
- The `SENTRY_DSN`-unset path is a no-op, so local dev and tests
  don't need a Sentry account.
- Tests are deterministic and fast; no SDK mock surface.

### Negative / accepted trade-offs

- See "What this trade-off costs" above. Each is a v0.0.1 pragmatism
  call, not a permanent posture.
- A future contributor expecting the SDK's surface
  (`Sentry.startSpan`, `Sentry.flush`, `Sentry.metrics`) needs to be
  pointed at this ADR. Comment headers in `lib/sentry.ts` and the
  middleware site mention ADR-0008.

## How to swap to `@sentry/cloudflare` in v0.1

The swap is contained. Steps:

1. `pnpm --filter @loomwiki/worker add @sentry/cloudflare`.
2. Replace `apps/worker/src/lib/sentry.ts` with a thin re-export
   wrapper that:
   - Calls `Sentry.init({ dsn: env.SENTRY_DSN, ...,
     beforeSend: scrubPII })` once per isolate.
   - Re-exports `captureException(env, error, ctx, opts)` to call
     `Sentry.captureException(error, { tags: { request_id, user_id },
     extra: opts.extra })`.
   - Keeps the `parseDsn` / `scrubPII` exports so existing tests
     continue to assert the contract surface.
3. Replace `sentryMiddleware()` with the SDK's
   `withSentry(handler, { ... })` wrapper at the worker entry point.
4. Update `apps/worker/src/__tests__/sentry.test.ts` to mock the SDK
   surface rather than `fetch`. The PII scrub test stays exactly as
   written — it asserts pre-`Sentry.captureException` filtering.
5. Add `worker_runtime: "cloudflare-workers"` and any required
   `compatibility_flags` entries that the SDK requires; verify
   against the SDK's release notes at swap time.

The PII scrub function (`scrubPII`) and the unconditional `extra`
filtering stay. The DSN parsing and the `fetch` call go.

The migration is one PR, ~50 lines net change, with the existing
tests as the regression suite.

## Revisit when

- The dogfood team grows past ~50 users or the worker traffic exceeds
  10 req/s sustained — the auto-instrumentation value rises sharply.
- We add a streaming surface where breadcrumbs ("we sent 47 SSE
  frames before the throw") would materially help debugging.
- The SDK adds (or has added by v0.1) a "minimal" build target that
  drops OTel by default. At that point the cost calculus inverts.

## Alternatives considered

- **Use `@sentry/cloudflare` directly.** Not rejected on principle —
  rejected on v0.0.1 cost/value. Re-evaluate at v0.1.
- **Send to Workers Logs only, no Sentry.** Rejected — the dogfood
  workflow specifically wants per-issue grouping, recipient alerting,
  and a stable URL to share in PR review. Workers Logs is line-
  oriented; Sentry's grouping is the value.
- **Build a generic event-sink abstraction.** Rejected — premature.
  The minimal sender's surface is small enough to swap in one PR.
- **Use OpenTelemetry directly via the OTel JS SDK.** Rejected for
  the same reason as `@sentry/cloudflare` (transitive surface) plus
  loss of the per-error grouping UX.

## References

- `apps/worker/src/lib/sentry.ts` — implementation (`parseDsn`,
  `scrubPII`, `sendEvent`, `captureException`, `sentryMiddleware`).
- `apps/worker/src/__tests__/sentry.test.ts` — wire-shape assertions.
- `DEPLOY.md` "Sentry setup (M8)" — operator runbook.
- Sentry "store" endpoint format —
  https://develop.sentry.dev/sdk/data-model/envelopes/ (envelope
  shape used by the wire format).
