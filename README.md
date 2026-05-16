<!-- SPDX-License-Identifier: Apache-2.0 -->

# Loomwiki

A Cloudflare-native team workspace where chat is the input and a
git-backed wiki is the output. Open-source, one-click self-hostable
on Cloudflare. Operationalizes Karpathy's
[`llm-wiki.md`](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
pattern.

**Status:** v0.0.1 (dogfood). Live at `loomwiki.cortech.online`
(private — Cloudflare Access OTP). The reference operator path; not
a public-facing demo. See [`docs/RELEASE.md`](./docs/RELEASE.md) for
the v0.0.1 release notes and known limitations.

[Screenshots will be added once a public demo deploy is available.]

## Quickstart

Boot a local dev environment:

```sh
pnpm install
pnpm dev
```

`pnpm dev` runs the worker (`wrangler dev` on `:8788`) and the Astro
dev server (`:4321`) concurrently. Browse to <http://localhost:4321>;
the worker proxies through.

For a full first-time setup (D1 migrations, Cloudflare Access, Worker
secrets), follow [`DEPLOY.md`](./DEPLOY.md).

To verify the M2 chat round-trip and hibernation behaviour locally, run the
[M2 smoke script](./docs/SMOKE.md#m2--chat-round-trip) after `pnpm dev` is
running:

```sh
pnpm smoke:m2
```

The full project conventions — commands, Cloudflare bindings, code
style, "do-not-touch" zones — live in [`CLAUDE.md`](./CLAUDE.md). The
master spec is [`SPEC.md`](./SPEC.md). The threat model is
[`docs/SECURITY.md`](./docs/SECURITY.md).

## Running ingest manually

The ingest agent reads recent chat messages in a room and extracts wiki
proposals. To trigger it manually:

1. Open a room as a member.
2. Click the **▶ Run ingest** button in the room header (top-right).
3. The button is disabled while the trigger is in flight; once it
   returns, the UI polls `GET /api/runs/:id` and shows a success or
   error toast when the run reaches a terminal state.

**Required operator config** (set via `wrangler secret put` or the
Cloudflare dashboard → Workers → your worker → Settings → Variables):

| Setting | Purpose |
|---|---|
| `AI_GATEWAY_ID` | AI Gateway slug (enables cost guards) |
| `CF_ACCOUNT_ID` | Cloudflare account ID for Gateway URL composition |

The `AI` Workers AI binding must also be enabled in `wrangler.jsonc`.
If neither a gateway nor the binding is configured, the run will fail
immediately with an actionable error shown in the UI.

For the full ingest-agent design, see
[`docs/ADR/0005-ingest-agent-design.md`](./docs/ADR/0005-ingest-agent-design.md).

## Roadmap to v0.1

The v0.0.1 release is the dogfood-first milestone. The v0.1 effort
swaps the wiki backend to git-backed Artifacts, re-enables AI Search,
ships email digest delivery, and adds the audit-log web UI. The full
list lives in [`docs/RELEASE.md`](./docs/RELEASE.md) under "Roadmap
to v0.1."

## Architecture (one paragraph)

Hono on Cloudflare Workers handles the API. Live chat lives in a
`ChatRoom` Durable Object using the WebSocket Hibernation API
(SQLite-backed storage; D1 mirror for non-live queries). Wiki pages
persist via a `WikiBackend` interface — `KvWikiBackend` in v0.0.1, a
git-backed Artifacts implementation in v0.1. The ingest agent runs
on Workers AI (Llama by default; BYOK Anthropic / OpenAI optional)
through AI Gateway with three layers of cost guards. Frontend is
Astro 5 + React 19 islands + Tailwind v4. Auth is Cloudflare Access.

For more depth: [`docs/ADR/`](./docs/ADR/) holds the decision
records, including the Cloudflare-only stack rationale (ADR-0001),
no-ORM (ADR-0002), Artifacts-as-vault (ADR-0003), search/RAG
layering (ADR-0004), ingest-agent design (ADR-0005), BYOK envelope
encryption (ADR-0006), audit log (ADR-0007), and the Sentry
deviation (ADR-0008).

## Attribution

The chat-as-input, wiki-as-output pattern operationalized here comes
from Andrej Karpathy's
[`llm-wiki.md`](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
gist. The two-agent split (ingest + lint) is Loomwiki's v0.0.1
(ingest) and v0.1 (lint) roadmap. The vault schema in
[`vault-template/AGENTS.md`](./vault-template/AGENTS.md) reads as a
direct descendant.

Full acknowledgements in [`docs/RELEASE.md`](./docs/RELEASE.md#acknowledgements).

## Reporting vulnerabilities

Please report security issues per [`docs/SECURITY.md`](./docs/SECURITY.md)
§12. Two channels: `security@cortech.online` (preferred) or a GitHub
private vulnerability advisory on the repo. **Please do not file
public issues for vulnerabilities.** Acknowledgement target: 72 hours.

## License

Apache-2.0. See [`LICENSE`](./LICENSE) for the full text and
[`NOTICE`](./NOTICE) for attributions required by the license.
