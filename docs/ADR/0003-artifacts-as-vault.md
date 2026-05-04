# ADR 0003 — Artifacts as the wiki vault, KV as the v0.0.1 backend

- **Status**: Accepted (with M4.5 follow-up)
- **Date**: 2026-05-04
- **Milestone**: M4

## Context

M4 wires the wiki: read/write markdown pages backed by the workspace's
"vault." SPEC §7.2 describes the vault as a single git repo per workspace
holding `/wiki/**`, `/AGENTS.md`, `/README.md`, and (M5+) `/rooms/**/log/*.md`.
SPEC §18 #4 requires that `git clone`-ing the vault returns the same
content the UI shows.

We had to pick *the* primitive that is the source of truth for the
vault. Three options were on the table:

1. **Cloudflare Artifacts**, the new Cloudflare-managed git remote.
   First-class on the platform, exposes a Workers binding, and ships
   with a public HTTPS git endpoint operators can clone from.
2. **R2** holding raw markdown blobs, with our own indexing layer in
   D1 for the path tree.
3. **D1** as the page store directly (one row per page, body in
   `TEXT`).

Option 1 is the clear architectural fit — operators expect git, M5+
wants per-day commit semantics, and the platform commits to the
abstraction. Picking either of the others would require us to recreate
git semantics on top.

But the **Cloudflare Artifacts Workers binding shipped with only
repo-lifecycle methods** in the runtime version we target
(`compatibility_date 2026-04-22`):

- `env.ARTIFACTS.create(name, opts?)` — creates a repo, returns
  metadata + an initial token.
- `env.ARTIFACTS.get(name)` — returns a repo handle.
- `env.ARTIFACTS.list / delete / import`.
- The repo handle exposes `createToken / listTokens / revokeToken /
  fork`.

There is **no `read(path)`, `write(path, content)`, `commit({...})`**
on the binding. File operations happen via the standard git protocol
against `repo.remote`, authenticated with a token from
`createToken("write")`.

The M4 prompt's "Resolved decisions" table assumed file-level methods
on the binding (`repo.commit({...})` etc.), and forbade exposing
Artifacts tokens to anything outside the worker. The two assumptions
are incompatible — without file ops on the binding, the only way to
push content to the repo is via the git protocol, which means an
authenticated client (in-worker or external) holding a token.

The verification block at the bottom of the same M4 prompt **already
assumed** a `POST /api/_admin/wiki/vault-token` route minting tokens
for `git clone`. The ambiguity is internal to the prompt; we resolve it.

## Decision

Two parts:

### a. Vault-as-source-of-truth: yes; persistence: KV in v0.0.1

The vault is conceptually a Cloudflare Artifacts repo. M4 wires the
binding for repo lifecycle:

- On the first request that needs the vault, the worker calls
  `env.ARTIFACTS.get(ARTIFACTS_REPO)` and falls back to
  `create(ARTIFACTS_REPO)` on not-found. Idempotent under concurrent
  first-time access.
- The seed (`vault-template/`) is bundled at build time into a typed
  TS module (`apps/worker/src/generated/vault-template-manifest.ts`)
  via `scripts/precompute-vault-template.ts`. The bootstrap routine
  walks the manifest and seeds any /wiki/** path the backend doesn't
  already have.

But **wiki page content lives in the `WIKI_KV` namespace** for
v0.0.1, not in the Artifacts repo. The reasons:

1. **The binding can't push files.** Pushing requires the git
   protocol; that's a non-trivial dependency (isomorphic-git plus
   transport plumbing) that we wanted to keep out of the M4 critical
   path while we got the API surface, validation, optimistic locking,
   and UI right.
2. **We can't live-test it.** Miniflare doesn't support the Artifacts
   binding (it's "remote-only"), so any git-push code we wrote in M4
   would land unverified.
3. **The contract we owe the editor** is read / write / SHA-based
   optimistic locking. KV gives us all of that on day one. The editor
   doesn't care whether the storage layer is git or KV.

The route layer talks to `WikiBackend`
(`apps/worker/src/lib/wiki-backend.ts`), an interface with two
implementations: `KvWikiBackend` (production v0.0.1) and
`InMemoryWikiBackend` (tests + bootstrap-bootstrapping fixtures).
M4.5 adds a third implementation, `GitArtifactsBackend`, that uses
isomorphic-git over `repo.remote` with a token from
`repo.createToken("write")`. Swapping is a one-line change at
`defaultWikiBackend(env)`.

### b. Token issuance route is exposed (deviation from prompt)

The M4 prompt says "do not mint or expose Artifacts tokens to the
browser in v0.0.1." That rule was scaffolded on the (false) premise
that the worker could read/write files via the binding directly. With
the binding only exposing repo lifecycle, an operator who wants to
verify §18 #4 (`git clone` works) needs a token. We expose:

- `POST /api/_admin/wiki/vault-token` — workspace-owner-only, takes
  `{ scope?: "read" | "write", ttl_seconds? }`, returns
  `{ token, scope, expires_at, remote, repo_name }`. Default scope is
  `write` and default TTL is 1 hour. The token is never persisted
  worker-side; the operator copies it once.

The token only enters the browser if the workspace owner explicitly
fetches it from the admin route. The route is gated by workspace
ownership and rate-limited at the auth layer (M1). It's never
returned alongside an unrelated payload.

## Consequences

### Positive

- The seam between the route layer and the storage layer is clean.
  M4.5's git work touches one file (`wiki-backend.ts`) plus a deps
  bump.
- The Artifacts binding is wired and exercised today: lifecycle is
  real, the `vault-token` admin route works, the manifest precompute
  pipeline is in place. M4.5 inherits a hot path.
- Tests are deterministic. `InMemoryWikiBackend` makes route tests
  fast and offline-friendly; `KvWikiBackend` is exercised in
  miniflare via the parameterized backend test suite so we know the
  contract holds across both implementations.
- Validation, optimistic locking, conflict semantics, and merge UX
  all ship today on a backend that is a strict subset of what git
  gives us — when M4.5 swaps the backend, no semantic regression is
  possible.

### Negative / accepted trade-offs

- **§18 #4 (`git clone` shows the page) is partial in v0.0.1.** A
  fresh deploy creates the Artifacts repo and the operator can clone
  it, but it'll be empty (or only contain the seed once M4.5 starts
  pushing). UI edits do not appear in the cloned repo until M4.5.
  This is the load-bearing scope cut.
- **The vault-template seed is in two places.** The build-time
  manifest seeds the KV backend; M4.5 will additionally push it to
  the git remote on first bootstrap. The M4 bootstrap result already
  includes `seededPaths` and `skippedPaths` so the M4.5 push step
  knows what to send.
- **Operators can't `git clone` the v0.0.1 wiki to back it up.** They
  can use the existing `/api/wiki/*` endpoints (or restore the entire
  `WIKI_KV` namespace via wrangler). The KV-as-vault is a
  transitional state, not a permanent posture.

### Why M4.5 isn't M4

Adding isomorphic-git to the worker bundle is real engineering: pack
file generation, smart HTTP protocol, Buffer polyfill, network error
handling. With no live-verification path (miniflare doesn't host
Artifacts), shipping the git layer in the same PR as the abstraction
+ the UI risked landing speculative code on the critical path. The
pragmatic call: ship the contract today, ship the persistence
swap-in next.

## Revisit when

- Cloudflare Artifacts ships file-level read/write methods on the
  binding. If that happens before M4.5, the persistence layer
  collapses to a thin wrapper around the binding and isomorphic-git
  is moot.
- Multi-workspace lands. Each workspace having its own vault repo
  changes lifecycle handling; the binding's `import` and `fork`
  methods become useful here.
- The cron archive (M5) decides whether to commit chat logs through
  the same backend abstraction or to a separate `RoomLogBackend`. If
  the latter, this ADR's seam is the precedent.

## Alternatives revisited

If we ever want to back out of git entirely, **Option 2 (R2 + D1
index)** is the leading fallback — R2 gives durable blob storage,
D1 the path tree, and it sidesteps the Artifacts binding entirely.
The cost is operators no longer get `git clone` for free. We'd need
to ship our own backup/export tool. Not the direction.
