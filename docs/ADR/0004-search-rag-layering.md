# ADR 0004 — Two-tier search (AI Search + FTS5 fallback) and three-layer cost guards

- **Status**: Accepted
- **Date**: 2026-05-04
- **Milestone**: M6

## Context

M6 wires the wiki for hybrid search and grounded `/ask` answers. SPEC §18
acceptance #5 (`<500ms` 3-word search over a 1k-page corpus) and #6
(`<5s` /ask with ≥2 citations) drive the wire-up. SPEC §13 names AI
Gateway as the cost-monitoring layer and `docs/SECURITY.md` §7 lists
"AI cost runaway via `/ask`" as the marquee multi-tenant abuse vector.

Three coupled decisions had to land together:

1. **Where the search index lives.** Cloudflare AI Search (managed,
   hybrid BM25 + vector) is the right answer in production but it is
   remote-only — local dev, fresh deploys before bootstrap, and AI
   Search outages all leave the surface dead unless we have a
   fallback. D1 has FTS5 built-in; we already pay for the binding.
2. **Where the LLM call lives.** Every other module (M7's IngestAgent,
   M8's BYOK admin tools) is going to call into the LLM. If we don't
   pin the call site now, we'll have three of them by M8.
3. **How we keep `/ask` from burning the operator's budget.** A single
   layer of defense is brittle — a botnet of users in one workspace
   can drain a per-user cap; a workspace cap doesn't help against one
   bad actor consuming the workspace's budget; missing the gateway
   cap means a worker bug exposes the whole account.

## Decision

### a. Two-tier search: AI Search primary, D1 FTS5 fallback

`searchWiki()` (`apps/worker/src/lib/search.ts`) tries AI Search first,
catches `AI_SEARCH_UNAVAILABLE` (a sentinel error code thrown by
`lib/ai-search.ts` when the binding is missing, the env-var override
disables it, or any binding call throws/5xx) and falls through to
`searchFts5()` silently.

The orchestrator returns `{ results, mode }` where `mode` is `"hybrid"`
on the AI Search path and `"fts5_fallback"` on the FTS5 path. The web
UI surfaces this via an empty-state message ("Showing keyword matches
only — semantic search is unavailable") so users know what's happening.

**Why auto-detect instead of a `wrangler.dev.jsonc` split-config (the
M5 precedent):** Artifacts fails outright in dev with HTTP 10015 — a
hard failure needs the hard `wrangler.dev.jsonc` workaround. AI Search
is a soft failure: the binding either exists or doesn't, and a missing
binding throws once per call. Catching that throw and falling through
preserves the surface in dev without operator action.

**Why per-section chunking via the existing `unified` AST:** the M3
sanitizer already parses every wiki page through `unified` +
`remark-parse` + `remark-gfm`. Re-parsing for chunking would duplicate
work and risk drift between the rendered HTML and the indexed chunks.
`packages/shared/src/markdown-chunk.ts` reuses
`createMarkdownAstParser()` exported from the sanitizer, walks the AST
splitting on `heading` nodes with `depth ≤ 2`, and emits one chunk per
section (plus a "prelude" chunk for content before the first heading).

**Why FTS5 stores only `(path, title, body)` instead of per-section
chunks:** the fallback is a fallback. Operating at full-page granularity
keeps the FTS5 schema (and the upsert / delete code paths) simple. AI
Search gets per-section indexing because it's the production path.

### b. Single LLM call site (`apps/worker/src/lib/llm.ts`)

Every LLM call funnels through `chat()` and `chatStream()`. Internally:

- Routes through the AI Gateway URL when `env.AI_GATEWAY_ID` and
  `env.CF_ACCOUNT_ID` are configured.
- Falls back to `env.AI.run(...)` directly when they aren't.
- Calls `getBYOK(env, workspaceId, provider)` for the BYOK lookup
  (M8 plug-in point: M6 always returns `null` from D1).

This means swapping the default model, adding a new BYOK provider, or
adjusting the gateway routing is a one-file change. M7's `IngestAgent`
and M8's BYOK UI both call `chat()`; nothing else touches `env.AI`.

**Verification:** `rg "env\.AI\.run" apps/worker/src/` should return
only `lib/llm.ts` and `lib/embeddings.ts` (the two intentional call
sites; embeddings.ts could fold into llm.ts but the streams are
sufficiently different to keep them separate).

### c. Three-layer cost guards (defense in depth)

| Layer | Where | Defends against |
|-------|-------|-----------------|
| Per-user counter | `lib/cost-guard.ts` → `llm_usage_daily` | Typical bad actor |
| Per-workspace counter | same | Coordinated abuse inside one workspace |
| AI Gateway daily cap | Cloudflare dashboard | Worker bug bypass |

`assertWithinLimit()` reads both counters before the LLM call,
throws `LoomwikiError("RATE_LIMITED", { limit, used, scope, reset_at })`
on cap, otherwise increments BOTH counters in a single `Promise.all`.
Race safety: the counter upsert is an `INSERT ... ON CONFLICT DO
UPDATE` against the composite primary key
`(workspace_id, day, scope_type, scope_id)`; SQLite serializes writes
within a D1 instance and the conflict clause handles the row-exists
case atomically (see `apps/worker/src/__tests__/usage.test.ts` for the
25-concurrent-+1 test).

The Gateway cap lives in the Cloudflare dashboard rather than code
because (a) it gates the entire deploy, including bypass paths the
worker can't see, and (b) operators can dial it without redeploying.
`docs/DEPLOY.md` documents the configuration step.

**Why three layers and not just one:** skipping any single layer creates
a hole. Per-user without per-workspace = botnet inside one workspace
drains budget. Per-workspace without per-user = one bad actor consumes
the shared quota. Missing the Gateway = a worker bug exposes the whole
account. The combined cost in implementation is one D1 table, two
upsert calls per request, and two `await getUsage(...)` reads.

### d. BYOK shim instead of full M8 plumbing

`lib/byok.ts` queries the `byok_keys` table provisioned in M1 but
always returns `null` in M6. The call site in `lib/llm.ts` already
invokes the lookup — M8's plug-in point is "decrypt the row we already
fetched", not "wire up the call". This means:

- The contract `getBYOK(env, workspaceId, provider) → Promise<string | null>`
  is frozen now and won't change in M8.
- Tests in `__tests__/byok.test.ts` assert the M6 null contract
  explicitly so the M8 PR sees a failing test the moment it flips
  behavior — that's the moment to update the test along with the rest
  of the BYOK plumbing.
- Workers AI is the default model in M6, full stop. BYOK becomes a
  per-workspace setting in M8.

## Consequences

### Positive

- Search works in local dev today (FTS5 fallback) and gives hybrid
  results in prod (AI Search). The mode-aware empty state means
  operators see "fts5_fallback" and know to provision AI Search.
- The chunker shares the sanitizer's parse pipeline. Drift between
  "what we indexed" and "what we render" is structurally impossible
  (modulo the chunker's offset math, which is unit-tested).
- Cost guards are independent. A user who hits their cap doesn't tank
  another user's request; a workspace at cap can still serve cached
  responses through the AI Gateway layer.
- `/ask` streams via SSE, which is the right tool: short-lived,
  unidirectional, native `EventSource` on the browser, automatic
  reconnection, degrades to a non-streaming consumer that just reads
  the whole response.
- The BYOK seam is real but inert. M8 is one file's worth of work,
  not a refactor.

### Negative / accepted trade-offs

- **AI Search is the production path; we don't have a way to verify
  the prod hybrid ranking from local dev.** Operators rely on the
  AI Gateway dashboard + smoke checklist to confirm prod search
  quality. Local dev silently uses keyword-only.
- **The /ask surface incurs LLM cost per request.** Counter increments
  before the LLM call, never after — a client disconnect mid-stream
  does not roll back. This is correct (the cost has been paid at the
  provider) but means the caps are slightly conservative relative to
  "successful answer" semantics.
- **Citations are best-effort in the FTS5 fallback path.** The
  per-section chunking lives only in AI Search; FTS5 stores full
  pages. /ask citations from FTS5 results carry `heading_slug = null`
  (link to the page, not to a `#section`).
- **AI Gateway cap is operator-configured.** A self-hoster who skips
  the Gateway setup loses the third layer. The DEPLOY.md instructions
  flag it; we don't (yet) reject deploys that omit it.

### Why this isn't M8

M8 ships BYOK encryption + workspace LLM settings. Wiring the cost
guards then would mean shipping `/ask` in M6 with no protection — that's
exactly the "ship now, secure later" pattern that produces the
surprise-bill incident the SECURITY.md threat model warns about. M6 is
the milestone where LLM-backed surfaces first ship to users; cost
guards have to ship with them.

## Revisit when

- AI Search adds a Workers binding for direct embedding lookups
  separate from the managed query API. Today's `lib/ai-search.ts`
  wraps the high-level search method; if the lower-level vector index
  becomes accessible we may want a different abstraction.
- Multi-workspace ships. The cost guards key on `workspace_id`
  already; the AI Search namespacing (per
  `ai_search_namespaces` binding) becomes the next change.
- We add a "cached answer" surface that should bypass the per-user
  counter (the answer is already paid for). The current API doesn't
  support that — counters always increment.

## Alternatives considered

- **AI Search only, no fallback.** Rejected: dev surface dies; fresh
  deploys can't search before bootstrap; AI Search outages take
  search down.
- **FTS5 only, no AI Search.** Rejected: keyword-only ranking is
  worse on the queries that matter (semantic similarity, abbreviation
  expansion).
- **Per-section chunking in FTS5 too.** Rejected for v0.0.1: FTS5's
  job is "good enough fallback"; per-section indexing doubles the
  schema surface for marginal recall improvement.
- **Cost guard via DO atomic counters instead of D1.** Rejected: the
  composite PK upsert is race-safe in D1, and we'd need a per-workspace
  DO just for counters. D1 reuses existing infrastructure.
