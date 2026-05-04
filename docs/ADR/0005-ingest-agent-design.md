# ADR 0005 — Ingest agent design (defense-in-depth, JSON-mode + retry, lock semantics, digest)

- **Status**: Accepted
- **Date**: 2026-05-04
- **Milestone**: M7

## Context

M7 ships the marquee feature: chat → wiki proposals → human review →
merged wiki. The agent reads chat from one room, asks an LLM to produce
structured proposals, and persists them for an admin to merge. This is
also the prompt-injection-via-chat threat model showpiece: every
authenticated user can attempt to inject instructions into the LLM by
typing into chat, and the system prompt alone is not a sufficient
defense (`docs/SECURITY.md` §2.1 enumerates eight concrete attacks).

Four coupled decisions had to land together:

1. How the agent's output is structured and parsed.
2. What guards run on the parsed output before persistence.
3. How concurrent triggers (manual vs cron, same-room races) are
   serialized.
4. How operators see what the agent produced.

## Decision

### a. Defense-in-depth: five independent guards, not one big check

The five guards from `docs/SECURITY.md` §2.2 ship as five separate
functions with five separate tests. A single "validateProposal" mega-
check would mean a future refactor that accidentally drops one layer
breaks one test, not five — and the attacker only needs one missing
layer.

| # | Guard | Where |
|---|------|-------|
| 1 | Input sanitization (NFC + zero-width/bidi strip + HTML strip) | `agents/ingest-agent.ts` `sanitizeMessageBody()` |
| 2 | Structured output (Zod parse + retry-on-fail, max 2 retries) | `agents/ingest-agent.ts` `parseAgentResponse()` |
| 3 | Path allowlist (`validateWikiPath` regex) | `agents/ingest-agent.ts` `validateProposals()` |
| 4 | Secret scrub (regex set against credential shapes) | `agents/ingest-agent.ts` `scrubSecrets()` |
| 5 | Admin-merge-only (workspace-owner gate; no auto-merge code path) | `routes/proposals.ts` `requireOwner()` |

Each guard has a dedicated test in `apps/worker/src/__tests__/ingest-agent.test.ts`
and `routes-proposals.test.ts`. The "validateProposals (defense layer 3 — path
allowlist)" tests prove that an agent emitting `/AGENTS.md` produces zero
persisted rows; the "scrubSecrets" tests prove that a leaked AWS key in the
LLM output rejects the proposal; etc.

**Why source-citation (every `message_id` in the run input) is part of
this set** — it's the anti-fabrication guard for attack scenario A8
(citation laundering). A proposal that cites a non-existent message_id
is dropped at `validateProposals()`. Tests in `ingest-agent.test.ts >
validateProposals (source citation)` cover both fabricated message ids
and cross-room source contamination.

### b. JSON-mode + retry-on-parse-fail (over function-calling)

The agent's contract is "emit a JSON object matching `IngestAgentResponseSchema`."
Workers AI Llama-3.3-70B supports `response_format: { type: "json_object" }`
which we pass through `chat({ ..., responseFormat: "json_object" })`.

For models that don't honor the directive (or honor it poorly), the
parser falls back to extracting from a fenced ```json block, then re-
parsing. If the Zod schema rejects the result, the agent retries up to
2 more times — three total LLM calls per run, max. After three failures
the run is marked `failed` with `error: 'parse_retry_exceeded'`.

**Why not function-calling**: Workers AI Llama doesn't support tool
use natively in the same way Claude/OpenAI do. JSON-mode + Zod is the
universal lowest common denominator.

**Cost-counter discipline on retry**: the workspace ingest counter
increments ONCE per `runIngestForRoom` call, before the first LLM call
(in `executeIngestWork()`'s `assertWithinLimit`). Retry attempts do
NOT increment again — a single ingest run is one logical operation
regardless of how many LLM round-trips it took. Tests:
`ingest-agent.test.ts > runIngestForRoom retry-on-parse-fail > does
NOT double-charge the cost counter on retry`.

### c. Lock semantics (D1 row, not Durable Object)

`apps/worker/src/agents/lock.ts` uses a `running` row in
`ingest_runs` as the per-room lock. `acquireRunLock`:

- Selects any `running` row younger than 1 hour for the same room. If
  one exists, returns `acquired=false` with that run's id.
- Otherwise: marks any stale (>1h) `running` rows for the same room
  as `failed` with `error='lock_expired'` (preserving audit), then
  inserts a fresh `running` row.

D1 serializes writes within an instance, so two simultaneous
`acquireRunLock` calls produce one inserted row + one observed-existing
row — the loser still gets a usable runId pointing at the winner.

**Why D1 instead of a Durable Object**: ingest runs are slow (10–60s)
and infrequent (manual + 1/day cron). A DO would introduce a new hot
path on the room-room hot path that DOes don't currently mediate, just
to guard a low-frequency operation. The composite-PK trick from M6's
`llm_usage_daily` extends naturally to "single running row per room".

**Stale-lock TTL is 1 hour**: empirically the agent runs in 10–60s; an
hour gives 60× margin. The cron cadence is daily, not hourly, so the
M7 ingest cron at 03:00 UTC has plenty of headroom even after a lock
takeover.

### d. Manual + cron triggers, both converging on the same code

The agent code is the same whether triggered by `POST /api/rooms/:rid/ingest`
or by the 03:00 UTC cron. The two paths diverge only in:

- `triggered_by`: a UUIDv7 (manual) vs the literal `"cron"` (scheduled).
- HTTP response shape: the manual route returns the run_id immediately
  (200 + `status: "running"` or 202 + `status: "lock_held"`); the cron
  path logs structured outcomes per room.

The manual route's split — fast lock acquisition synchronously, slow
LLM phase via `ctx.waitUntil` — is the v0.0.1 approach for "long work
behind a fast HTTP response." If we ever shift to Cloudflare Workflows
(SPEC §10.3 hinted at the option), the same `executeIngestWork()`
function becomes the workflow body.

**Per-room failure isolation in the cron pass**: one bad room's failure
logs and continues, mirroring the M5 chat-log archival pattern. The
digest renders after all per-room runs settle, so a partial scan still
produces a useful digest.

### e. Digest-as-wiki-page (over email) for v0.0.1

The daily digest at `/wiki/_inbox/{YYYY-MM-DD}.md` is itself a wiki
page. It renders through the same M4 sanitizer + viewer; no new
display surface is required. Re-running the cron for the same date
produces byte-identical output (deterministic ordering of proposals
in `renderDigestMarkdown`).

The `DigestDelivery` interface (`lib/digest-delivery.ts`) exists so
M8 can add an email implementation behind the same contract — single-
file change, no schema migration. M7 only ships the wiki-page impl.

**Why not ship email in M7**: email delivery requires (a) Workers Email
Sending wired, (b) per-user opt-in, (c) digest preference UI. All three
are M8+ scope. The wiki-page surface is sufficient for the dogfood
team and self-hosters who don't want email at all.

**Why a wiki page and not a separate `digests` table**: a wiki page is
markdown, version-controlled (M4.5 will push it to git), search-
indexed, and the operator's existing reading surface. A separate table
would mean a new viewer, a new search-index path, and operator
education. Three layers of complexity collapsed into one wiki-page
write.

## Consequences

### Positive

- The agent loop is short and audited end-to-end. Each step has a
  test; each guard has a test; the retry loop has a test for both
  success-on-second-try and three-strike failure.
- The LLM is the least-capable agent that can do its job. No tool
  use, no fetches, no D1 writes outside `proposals` and `ingest_runs`.
  This closes attack scenarios A2 (indirect injection via web fetch)
  and A7 (capability solicitation) entirely — the capabilities are
  not present, so the agent can't be tricked into using them.
- Concurrent triggers converge on a single run. The manual route's
  fast 202 LOCK_HELD response means the UI gets immediate feedback
  without spawning duplicate work.
- The digest's idempotent render means the cron path is safe to re-
  invoke (admin route at `POST /api/_admin/digest/render?date=…`)
  for backfill or manual fix-up without producing artifacts that
  diverge from the canonical render.

### Negative / accepted trade-offs

- **The 1h stale-lock window is conservative.** A run that legitimately
  takes >1h would be considered abandoned; the new run would step over
  it. We don't currently have runs that take that long, but if
  someone configures a giant batch (`maxMessages` >> 500) they could
  hit it. The mitigation is per-run logging (`event:
  ingest_run_complete` with `duration_ms`); operators can tune the TTL
  via a future env var when they hit the case.
- **The retry loop is naive.** It uses the same prompt for all three
  attempts. A smarter approach would feed the parse error back into
  the next prompt as "your last reply failed because X — fix it."
  Defer for M9; v0.0.1 retries succeed often enough that the value of
  the fancier loop is unclear.
- **The cron picks `DEFAULT_WORKSPACE_ID` for the digest**, matching
  v0.0.1's single-tenant model. M8+'s multi-workspace work has to
  iterate over each workspace.
- **The secret scrub is regex-based and false-positive prone.** A long
  hex hash that happens to match the JWT shape will reject the
  proposal even though it's not actually a JWT. The cost is "operator
  re-runs ingest with the message rewritten" — vastly preferable to
  the alternative of letting a real secret slip through.
- **AGENTS.md cache is process-local.** Each Worker isolate caches
  independently; an operator edit to `/AGENTS.md` propagates within
  ~5 minutes (or instantly to a fresh isolate). Acceptable v0.0.1
  trade-off; M9 may add a global pub/sub-style invalidation.

## Revisit when

- Workers Workflows ships and we move ingest into a durable workflow
  (the lock then becomes the workflow's identity, not a D1 row).
- We add a "real-time" ingest mode that triggers on every chat
  message. The cost-counter math (one charge per run regardless of
  LLM round-trips) needs to survive the new cadence; right now it
  assumes runs are bounded.
- The Anthropic / OpenAI BYOK paths land in M8. Their JSON-mode
  semantics differ slightly from Workers AI's; the parser may need
  per-provider branches.
- The lint workflow ships (deferred; see `vault-template/AGENTS.md`
  §12). It's a separate agent role; the structured-output contract
  here is the template.

## Alternatives considered

- **Function-calling instead of JSON-mode.** Rejected for v0.0.1 because
  Workers AI Llama doesn't support tool use natively. Revisit when the
  BYOK Anthropic path lands.
- **Auto-merge low-risk proposals.** Rejected by SPEC §16 (Q20). The
  M7 prompt explicitly forbids any `status='auto_merged'` value;
  defense layer 5 is "every proposal requires an admin click."
- **Email-only digest.** Rejected because v0.0.1 is the dogfood
  surface; not every operator wants to wire Workers Email Sending up
  on day one. The wiki page is a strict superset (operators can view
  it without setting up email; M8 adds email behind the same
  interface).
- **One big "validate proposal" function instead of five separate
  guards.** Rejected — the test mapping argument above. Five
  functions, five tests, five regressions caught individually.
- **A Durable Object for the per-room run lock.** Rejected — see
  decision (c) above. D1 row + composite PK is sufficient and
  cheaper.
