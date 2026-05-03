# ADR 0001 — Cloudflare-only stack for the POC

- **Status**: Accepted
- **Date**: 2026-05-03
- **Milestone**: M0

## Context

Loomwiki is positioned as a one-click self-hostable team workspace where chat is
the input and a git-backed wiki is the output. The POC needs to be cheap to run,
straightforward to deploy, and honest about its operational footprint so an
operator running a single workspace can stand it up over a weekend.

Three stack postures were on the table:

1. **Cloudflare-only** — Workers, Durable Objects, D1, R2, KV, Workers AI, AI
   Search, Artifacts. One vendor, one bill, one auth surface (Cloudflare
   Access).
2. **Cloudflare front, Postgres-on-something-else back** — Workers + a managed
   Postgres (Neon/Supabase/RDS). Better SQL ergonomics, harder to one-click
   deploy, two vendors to budget.
3. **Self-managed (Node + Postgres + S3 + a vector store)** — most flexibility,
   highest operator burden, least coherent story for "open the dashboard, point,
   click, run".

## Decision

Adopt the **Cloudflare-only** posture for the POC.

- Hono on Workers for the API.
- Durable Objects (SQLite-backed, Hibernation API) for live chat rooms.
- D1 for hot relational state (users, rooms, messages, proposals).
- R2 for attachments.
- KV for cache.
- Workers AI + AI Gateway for inference; AI Search over the Artifacts vault.
- Artifacts for the git-backed wiki itself.
- Cloudflare Access for auth.

## Consequences

**Positive:**

- One-click deploy is achievable — every primitive is provisioned by Wrangler
  or a single dashboard click, and the operator's bill comes from one vendor.
- Edge-native by default; no separate region/VPC story for the POC.
- Workspace data lives in the operator's account, which simplifies the privacy
  story for early adopters dogfooding on real notes.

**Negative / accepted trade-offs:**

- D1 is less mature than mainstream Postgres. We accept the smaller feature
  surface in exchange for the deploy story.
- Outbound WebSockets from a Durable Object don't hibernate
  ([workerd #4864](https://github.com/cloudflare/workerd/issues/4864)) — design
  the LLM streaming path to use fresh `fetch` per request, not a long-lived
  outbound socket from the DO.
- Vendor lock-in is real. The escape hatch is documented: D1 → Postgres
  migration is a known path, the wiki is plain markdown in git, and BYOK
  (M8) lets users bring their own LLM provider.

## Revisit when

- Self-hosters report that Cloudflare-only is a blocker (e.g., regulated
  environments where Cloudflare is not on the approved vendor list).
- D1 hits a hard scaling ceiling for an active workspace.
- Cloudflare changes the pricing or availability of any primitive in this list
  in a way that breaks the "free or near-free for a small team" assumption.
