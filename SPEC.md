# Loomwiki — Specification (POC, v0.0.1)

> A Cloudflare-native, OSS, one-click-self-hostable team workspace where chat is the input and a git-backed wiki is the output. Operationalizes Karpathy's [`llm-wiki.md`](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern.

---

## 0. How to read this doc

This spec is structured for **Claude Code with Opus 4.7 at `xhigh` effort**. Each component section contains:

- **Intent** — why it exists
- **Files** — exact paths in the repo
- **Contract** — types/interfaces or route shapes
- **Acceptance criteria** — done conditions
- **Subagent guidance** — when to fan out

When kicking off Claude Code on a milestone, paste the milestone's section *plus* sections 4 (architecture), 5 (bindings), and 6 (repo structure) in the first turn. Don't drip context across turns — Opus 4.7 reasons more after each user turn, so batched context is cheaper and produces better output.

**Open questions appear inline as `❓ Q-NN`** and are also indexed in section 20. Answers should be edited directly into this doc and committed; this doc is the single source of truth.

---

## 1. Vision & non-goals

### Vision

A team workspace where every conversation that *would* have been lost in Slack scroll instead becomes durable, citeable, git-backed knowledge — automatically. The wiki is the canonical artifact; chat is the cheap input that feeds it. Operators can `git clone` their entire knowledge base at any time. The whole thing self-hosts on a single Cloudflare account with one click.

### Non-goals (POC)

Loomwiki is **not** trying to replace Slack, Notion, Linear, or Confluence. The POC explicitly does not target:

- Voice / video / screen-sharing
- Calendar / meetings / availability
- Tasks, projects, sprints, OKRs
- File-heavy collaboration (Google Drive replacement)
- Federation (Matrix-style)
- Mobile-native apps (PWA only)
- Multi-workspace per deploy (single workspace for v0.0.1)
- E2E encryption
- Self-hosting on anything other than Cloudflare

If users want those things, they can keep using Slack/Notion alongside. Loomwiki's wedge is *chat-to-wiki*, full stop.

---

## 2. Open questions index

Resolve these as you go. **Bold = blocking for v0.0.1.**

| # | Question | Status |
|---|----------|--------|
| **Q1** | **Name** (Loomwiki / Threadbook / Reweave / Cordwiki / other) | ❓ |
| **Q2** | **Domain** (sister to dmarc.mx? .wiki? .dev?) | ❓ |
| **Q3** | **Frontend framework** (Astro Islands / SvelteKit / React+TanStack) | ❓ |
| **Q4** | **Editor** (Milkdown / Tiptap / CodeMirror 6 / Monaco) | ❓ |
| Q5 | Markdown flavor (GFM only / Obsidian-flavored) | suggested: GFM + bundle-absolute links |
| Q6 | Workspace model (single per deploy / multi) | suggested: single |
| Q7 | Ingest cadence (manual / cron / real-time / hybrid) | suggested: manual for POC |
| Q8 | Proposal mechanism (Artifacts branch / D1 status field) | suggested: D1 status, commit on merge |
| Q9 | Direct human edits to wiki pages | suggested: yes |
| Q10 | Threading in chat for v0.0.1 | suggested: defer |
| Q11 | BYOK key storage model | suggested: Workers Secrets Store, per-workspace |
| **Q12** | **Default LLM** (Workers AI Llama 3.3 / require BYOK) | ❓ |
| Q13 | Mobile (PWA / Capacitor wrapper) | suggested: PWA |
| Q14 | Telemetry (none / opt-in version ping / opt-in analytics) | suggested: none for POC |
| Q15 | Slack/Teams/Discord ingest in POC | suggested: defer |
| Q16 | Email-to-wiki via Email Workers in POC | suggested: defer |
| Q17 | AGENTS.md user-editable per workspace | suggested: yes |
| Q18 | Real-time presence | suggested: defer |
| **Q19** | **Dogfood team size** (solo / 2–3 / 5+) | ❓ |
| Q20 | AI auto-merge tier | suggested: human-merge only for POC |
| Q21 | License | suggested: Apache 2.0 |
| Q22 | Versioning (SemVer / CalVer) | suggested: SemVer |
| Q23 | Repo name (matches Q1) | depends on Q1 |
| Q24 | Org (personal `schmug/` or new GitHub org) | ❓ |

---

## 3. Glossary

- **Workspace** — top-level tenant boundary. POC has exactly one per deploy.
- **Room** — a chat channel. Maps 1:1 to a Durable Object instance.
- **Vault** — the Artifacts (git) repo containing `/wiki` + `/rooms/*/log`.
- **Page** — a markdown file under `/wiki/` in the vault.
- **Proposal** — an AI-generated wiki edit awaiting human review.
- **Run** — a single ingest agent execution over a room's recent messages.
- **AGENTS.md** — schema file in the vault that tells the ingest agent how to behave (Karpathy pattern).

---

## 4. Architecture overview

```
                    ┌─────────────────────────────┐
                    │   Cloudflare Access          │  email-OTP, free ≤50 users
                    └─────────────┬───────────────┘
                                  │ JWT (CF-Access-Jwt-Assertion)
                                  ▼
      ┌──────────────┐    ┌────────────────────┐    ┌──────────────────┐
      │ Web (Worker) │◀──▶│  API Worker (Hono) │◀──▶│ MCP/agent endpts │
      └──────┬───────┘    └────────┬───────────┘    └──────────────────┘
             │ WebSocket           │
             ▼                     ▼
   ┌──────────────────┐    ┌──────────────────┐
   │ ChatRoom DO      │    │ IngestAgent      │
   │ (SQLite + WS     │    │ (Agents SDK +    │
   │  Hibernation,    │    │  Workflows)      │
   │  one per room)   │    └────────┬─────────┘
   └────────┬─────────┘             │
            │                       │
            └─────┬─────────────────┘
                  ▼
        ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐
        │ D1 (hot data)   │  │ Artifacts        │  │ AI Search        │
        │ users, rooms,   │  │ /wiki/*.md       │  │ data source =    │
        │ messages,       │  │ /rooms/*/log/*   │◀─│ Artifacts vault  │
        │ proposals       │  │ AGENTS.md        │  │ hybrid BM25+vec  │
        └─────────────────┘  └──────────────────┘  └────────┬─────────┘
                                                            │
                                                  ┌─────────▼─────────┐
                                                  │ Workers AI        │
                                                  │ + AI Gateway      │
                                                  └───────────────────┘
```

Detailed rationale lives in `/docs/RATIONALE.md` (the deep-research artifact). This SPEC.md is the operational source of truth.

---

## 5. Cloudflare bindings (`wrangler.jsonc`)

Declare all bindings up front, even if a milestone doesn't use them yet. This prevents Claude Code from guessing at binding shapes mid-build.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "loomwiki-api",
  "main": "apps/worker/src/index.ts",
  "compatibility_date": "2026-04-15",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "routes": [
    { "pattern": "api.loomwiki.example", "custom_domain": true }  // ❓ Q2
  ],
  "durable_objects": {
    "bindings": [
      { "name": "CHAT_ROOM", "class_name": "ChatRoom" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ChatRoom"] }
  ],
  "d1_databases": [
    { "binding": "DB", "database_name": "loomwiki", "database_id": "<set after wrangler d1 create>" }
  ],
  "r2_buckets": [
    { "binding": "ATTACHMENTS", "bucket_name": "loomwiki-attachments" }
  ],
  "kv_namespaces": [
    { "binding": "CACHE", "id": "<set after wrangler kv namespace create>" }
  ],
  "ai": { "binding": "AI" },
  "vars": {
    "WORKSPACE_NAME": "default",
    "DEFAULT_LLM_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "EMBEDDING_MODEL": "@cf/baai/bge-base-en-v1.5",
    "ARTIFACTS_REPO": "loomwiki-vault",
    "AI_SEARCH_INSTANCE": "loomwiki-search"
  },
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1.0
  },
  "triggers": {
    "crons": ["0 2 * * *"]   // 02:00 UTC daily — commit chat logs to Artifacts
  }
}
```

Secrets (set via `wrangler secret put`):

- `SENTRY_DSN`
- `BYOK_ENCRYPTION_KEY` — 32 bytes, base64. Used to envelope-encrypt user-supplied LLM provider keys.
- `ARTIFACTS_TOKEN` — Artifacts API token (until/unless binding ships GA)
- `AI_GATEWAY_TOKEN` — for the AI Gateway proxy

❓ **Q-bindings**: Once Artifacts ships a Worker binding (it's announced; track changelog), replace `ARTIFACTS_TOKEN` with a binding.

---

## 6. Repo structure

pnpm monorepo. Apache 2.0 (❓ Q21).

```
loomwiki/
├── CLAUDE.md                  # auto-loaded by Claude Code
├── SPEC.md                    # this file
├── README.md                  # user-facing
├── DEPLOY.md                  # one-click + manual deploy instructions
├── LICENSE
├── pnpm-workspace.yaml
├── package.json
├── wrangler.jsonc             # see §5
├── tsconfig.base.json
├── biome.json                 # linter/formatter (or eslint+prettier — ❓)
├── .github/
│   ├── workflows/ci.yml       # lint + typecheck + vitest
│   └── ISSUE_TEMPLATE/
│       ├── milestone.md
│       └── bug.md
├── apps/
│   ├── worker/                # Hono API + ChatRoom DO
│   │   ├── src/
│   │   │   ├── index.ts       # Hono app, route registration
│   │   │   ├── routes/        # one file per resource
│   │   │   ├── do/ChatRoom.ts # DO with hibernation
│   │   │   ├── agents/IngestAgent.ts
│   │   │   ├── lib/auth.ts    # Access JWT validation
│   │   │   ├── lib/artifacts.ts # Artifacts client
│   │   │   ├── lib/ai-search.ts
│   │   │   ├── lib/llm.ts     # AI Gateway-aware client
│   │   │   ├── lib/crypto.ts  # envelope encryption for BYOK
│   │   │   └── env.ts         # typed Env interface
│   │   └── tsconfig.json
│   └── web/                   # frontend (❓ Q3)
│       ├── src/
│       │   ├── routes/
│       │   ├── components/
│       │   ├── lib/api.ts     # typed client
│       │   └── lib/ws.ts      # WebSocket client w/ reconnect
│       └── public/
├── packages/
│   ├── schema/
│   │   ├── d1-migrations/0001_init.sql
│   │   └── src/index.ts       # Zod schemas + TS types shared between worker+web
│   ├── shared/
│   │   └── src/index.ts       # protocol types: WS message envelopes, etc.
│   └── agents-prompts/
│       └── src/
│           ├── ingest.ts      # system prompts for IngestAgent
│           └── ask.ts         # /ask RAG prompt
├── vault-template/            # files copied into a fresh Artifacts vault on first deploy
│   ├── AGENTS.md
│   ├── README.md
│   └── wiki/_index.md
├── docs/
│   ├── RATIONALE.md           # the deep-research output
│   ├── DATA-MODEL.md
│   ├── SECURITY.md
│   └── ADR/
│       └── 0001-cloudflare-only.md
└── scripts/
    ├── seed.ts                # seeds D1 with the test corpus
    └── bootstrap-vault.ts     # creates Artifacts vault from vault-template/
```

---

## 7. Data model

### 7.1 D1 schema (`packages/schema/d1-migrations/0001_init.sql`)

```sql
-- Users (created via JIT on first authenticated request)
CREATE TABLE users (
  id            TEXT PRIMARY KEY,           -- UUIDv7
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_users_email ON users(email);

-- Workspaces (POC has exactly one)
CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_id      TEXT NOT NULL REFERENCES users(id),
  vault_repo    TEXT NOT NULL,              -- Artifacts repo identifier
  ai_search_id  TEXT,                       -- AI Search instance id
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Rooms
CREATE TABLE rooms (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  slug          TEXT NOT NULL,              -- url-safe; unique per workspace
  name          TEXT NOT NULL,
  topic         TEXT,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (workspace_id, slug)
);

-- Room membership (POC: every workspace member is in every room)
CREATE TABLE room_members (
  room_id       TEXT NOT NULL REFERENCES rooms(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  role          TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
  joined_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (room_id, user_id)
);

-- Messages (also lived in DO SQLite; D1 is the queryable mirror)
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,           -- UUIDv7 — sortable
  room_id       TEXT NOT NULL REFERENCES rooms(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  body          TEXT NOT NULL,              -- markdown
  parent_id     TEXT REFERENCES messages(id),  -- threading; null for top-level (❓ Q10)
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  edited_at     INTEGER,
  deleted_at    INTEGER
);
CREATE INDEX idx_messages_room_created ON messages(room_id, created_at);

-- Ingest runs
CREATE TABLE ingest_runs (
  id              TEXT PRIMARY KEY,
  room_id         TEXT NOT NULL REFERENCES rooms(id),
  triggered_by    TEXT NOT NULL,            -- user_id or 'cron'
  started_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at     INTEGER,
  last_message_id TEXT,                     -- bookmark
  status          TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  summary         TEXT,                     -- LLM-written one-liner
  error           TEXT
);

-- Proposals (AI-generated wiki edits awaiting review)
CREATE TABLE proposals (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES ingest_runs(id),
  page_path       TEXT NOT NULL,            -- e.g. /wiki/concepts/dmarc.md
  action          TEXT NOT NULL CHECK (action IN ('create','update')),
  before_sha      TEXT,                     -- null for 'create'
  after_content   TEXT NOT NULL,            -- proposed markdown
  rationale       TEXT NOT NULL,            -- LLM's reasoning
  status          TEXT NOT NULL CHECK (status IN ('pending','merged','rejected','superseded')),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  reviewed_at     INTEGER,
  reviewed_by     TEXT REFERENCES users(id),
  artifacts_commit TEXT                     -- set on merge
);
CREATE INDEX idx_proposals_status ON proposals(status, created_at);

-- BYOK keys (envelope-encrypted)
CREATE TABLE byok_keys (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  provider        TEXT NOT NULL,            -- 'anthropic' | 'openai' | 'google'
  ciphertext      BLOB NOT NULL,
  iv              BLOB NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by      TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (workspace_id, provider)
);
```

### 7.2 Artifacts vault layout

```
loomwiki-vault/                  # one Artifacts repo per workspace
├── AGENTS.md                    # see §10.1
├── README.md
├── wiki/
│   ├── _index.md                # workspace home page
│   ├── people/
│   ├── projects/
│   ├── concepts/
│   ├── decisions/               # ADR-style
│   └── glossary/
└── rooms/
    └── {room-slug}/
        └── log/
            └── 2026-05-03.md    # daily append-only chat log, committed at 02:00 UTC
```

Each daily log file is a markdown document with one entry per message:

```markdown
## 14:32 alice
Hey, what's our take on the new DMARC reject policy rollout?

## 14:33 bob
We're still at p=quarantine for the K-12 tenants. cory's writing it up.

## 14:35 cory
Yeah — see /wiki/decisions/2026-05-dmarc-rollout.md (draft). Will publish today.
```

Frontmatter on each log file:

```yaml
---
room: ops-cyber
date: 2026-05-03
message_count: 47
ingest_run_ids: [01HX...] # references back to D1 ingest_runs
---
```

### 7.3 AI Search

One AI Search instance per workspace, pointing at the workspace's Artifacts vault. Filter to `path: /wiki/**`. Hybrid BM25 + vector search via the post-April-16-2026 managed-instance flow. Reindex triggered on commit (or 5-minute poll for v0.0.1 since commit-trigger may not exist yet).

Ingest agent reads from `path: /rooms/**` *separately*, but those documents are not exposed to the user-facing search bar — only to the agent.

❓ **Q-search-namespacing**: As soon as Loomwiki supports multi-workspace, switch to AI Search namespaces (`ai_search_namespaces` binding) keyed by `workspace_id`.

---

## 8. API surface

Hono app, all routes under `/api`. Auth via Cloudflare Access JWT (`CF-Access-Jwt-Assertion` header).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/me` | Current user; JIT-creates `users` row |
| GET | `/api/workspaces/:wid` | Workspace metadata |
| GET | `/api/workspaces/:wid/rooms` | List rooms |
| POST | `/api/workspaces/:wid/rooms` | Create room |
| GET | `/api/rooms/:rid` | Room metadata |
| GET | `/api/rooms/:rid/messages` | Paginated history (`?before=<id>&limit=50`) |
| GET | `/api/rooms/:rid/ws` | WebSocket upgrade → ChatRoom DO |
| POST | `/api/rooms/:rid/ingest` | Manually trigger an ingest run |
| GET | `/api/rooms/:rid/runs` | List ingest runs |
| GET | `/api/wiki/*` | Read a wiki page (markdown + parsed frontmatter) |
| PUT | `/api/wiki/*` | Create/update a wiki page (commits to Artifacts) |
| DELETE | `/api/wiki/*` | Delete a wiki page |
| GET | `/api/wiki-tree` | File tree for nav |
| GET | `/api/proposals` | List proposals (`?status=pending`) |
| GET | `/api/proposals/:id` | Proposal detail (with diff) |
| POST | `/api/proposals/:id/merge` | Merge → commits to Artifacts |
| POST | `/api/proposals/:id/reject` | Reject proposal |
| POST | `/api/search` | Hybrid search via AI Search |
| POST | `/api/ask` | RAG: search + LLM, returns answer + citations |
| GET | `/api/health` | Liveness |

**Acceptance criteria for §8:**
- All routes typed end-to-end (Zod schemas in `packages/schema`, shared with web).
- All routes return `application/json` with shape `{ ok: true, data: ... }` or `{ ok: false, error: { code, message } }`.
- All routes (except `/api/health`) require a valid Access JWT; reject with 401 otherwise.
- Errors logged to Sentry with request ID.
- Each route has at least one vitest integration test.

---

## 9. Real-time chat surface (`ChatRoom` Durable Object)

### Intent

One DO per room. Holds the WebSocket connections, broadcasts messages, persists to its own SQLite, and mirrors writes to D1 so non-DO code paths (search, ingest) can read messages without round-tripping through the DO.

### Files

- `apps/worker/src/do/ChatRoom.ts`
- `apps/worker/src/do/types.ts`
- `packages/shared/src/ws-protocol.ts`

### Protocol (WebSocket envelopes)

```ts
// Client → Server
type ClientMsg =
  | { kind: 'hello'; userId: string; sinceMessageId?: string }
  | { kind: 'send'; tempId: string; body: string; parentId?: string }
  | { kind: 'edit'; messageId: string; body: string }
  | { kind: 'delete'; messageId: string }
  | { kind: 'ping' };

// Server → Client
type ServerMsg =
  | { kind: 'welcome'; roomId: string; recentMessages: Message[] }
  | { kind: 'message'; message: Message }
  | { kind: 'ack'; tempId: string; messageId: string }
  | { kind: 'edited'; messageId: string; body: string; editedAt: number }
  | { kind: 'deleted'; messageId: string }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'pong' };
```

### Hibernation

Use the **WebSocket Hibernation API** (`ctx.acceptWebSocket(ws)` + `webSocketMessage()` + `webSocketClose()`), not the legacy `ws.addEventListener` pattern. This is non-negotiable: it's what makes idle rooms cost zero. Reference: `cloudflare/workers-chat-demo` and `developers.cloudflare.com/durable-objects/best-practices/websockets/`.

### Storage

- DO SQLite (via `ctx.storage.sql`): `messages_local` table for local hot path.
- After successful local insert, write-through to D1 via the worker's `env.DB` binding. If D1 write fails, mark message as `pending_mirror=1` and retry on next request (or via a DO alarm).
- D1 is the canonical store for *queries*; DO SQLite is the canonical store for *the room's live state*.

### Backpressure

- Hard cap: 100 messages/sec per room. Above that, return `error: rate_limited`.
- Hard cap: 4096 chars per message body. Reject longer.

### Acceptance criteria for §9

- Two browser tabs open to the same room receive each other's messages within 200ms (LAN test).
- Tab disconnect + reconnect resumes from `sinceMessageId`.
- DO hibernates after 30 seconds idle (verify via `wrangler tail` showing no GB-s during idle).
- D1 mirror remains consistent within 1 second of DO insert (vitest integration test).
- Crashing the DO mid-write does not lose acknowledged messages (use `ctx.blockConcurrencyWhile` for the insert+ack path).

### Subagent guidance

Two parallel subagents are appropriate here: **one** to implement the DO + protocol + hibernation, **one** to implement the WS client in `apps/web`. They share `packages/shared/src/ws-protocol.ts` so the contract is fixed before fan-out. Do not spawn a subagent for the D1 schema — it's already written; just read `packages/schema/d1-migrations/0001_init.sql`.

---

## 10. Ingest agent

### Intent

Reads new messages since the last bookmark for a room, asks an LLM to extract entities/decisions/open-questions, and produces wiki page proposals. **POC: triggered manually via `POST /api/rooms/:rid/ingest`. Cron comes in v0.1.**

### Files

- `apps/worker/src/agents/IngestAgent.ts` (Cloudflare Agents SDK class)
- `packages/agents-prompts/src/ingest.ts` (system prompt)
- `vault-template/AGENTS.md` (the schema the agent reads each run — Karpathy pattern)

### 10.1 `AGENTS.md` (in the vault)

This file lives in the Artifacts vault, *not* the code repo. The ingest agent reads it on every run. Operators can edit it to customize ingest behavior per-workspace.

Suggested initial contents:

```markdown
# AGENTS.md — Loomwiki Vault Ingest Schema

This file tells the Loomwiki ingest agent how to convert chat into wiki pages.
It's a living document. Edit it to change agent behavior — no redeploy needed.

## What to extract

For each ingest run over recent chat, identify:

1. **Entities** — people, projects, vendors, technologies, places. Each gets a
   page under `/wiki/{kind}/{slug}.md` if mentioned ≥ 2 times across history.
2. **Decisions** — explicit choices ("we'll go with X", "deprecating Y").
   Page under `/wiki/decisions/YYYY-MM-{slug}.md`. Use ADR-lite format.
3. **Open questions** — questions raised but not resolved. Append to
   `/wiki/_open-questions.md` with date, room, asker.
4. **Glossary terms** — domain jargon used without explanation. Page under
   `/wiki/glossary/{term}.md`.

## What NOT to extract

- Personal/off-topic banter
- Anything in a message marked `<!-- offrecord -->`
- Anything from messages older than 90 days (handled separately by archive)

## Page schema (frontmatter)

Every wiki page must have YAML frontmatter:

```yaml
---
title: <Title Case>
kind: entity | decision | concept | open-question | glossary
created: ISO-8601
last_updated: ISO-8601
sources:
  - room: <slug>
    message_id: <UUIDv7>
  - ...
status: draft | published | superseded
superseded_by: <path>   # only if status=superseded
---
```

## Linking

Use Obsidian-style `[[wikilinks]]` for internal references (Q5: assumes
Obsidian flavor). The ingest agent should add `[[link]]` whenever a known
entity is mentioned in body text.

## Conflicts

If a proposed update contradicts an existing page, the agent must:

1. Set `status: pending` on the proposal.
2. Cite both the old text and new evidence in the rationale.
3. Never auto-merge in v0.0.1 (Q20).
```

### 10.2 Run lifecycle

```ts
// IngestAgent.run({ roomId, triggeredBy })
// 1. Load AGENTS.md from Artifacts.
// 2. SELECT messages FROM D1 WHERE room_id=:rid AND id > :bookmark ORDER BY id LIMIT 500.
// 3. Build context: AGENTS.md + room metadata + messages + existing relevant pages
//    (top-5 by AI Search, filtered to /wiki/**).
// 4. Call LLM with structured output schema (Zod-validated):
//    { proposals: [{ action, page_path, after_content, rationale }], summary: string }
// 5. For each proposal: write a row to `proposals` (status='pending').
// 6. Update ingest_runs row to 'succeeded' with last_message_id and summary.
```

### 10.3 LLM call

- Default model: ❓ Q12. Suggested: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for free-tier-friendliness, with BYOK fallback to Anthropic Claude Sonnet 4.7 via AI Gateway when a workspace has a key configured.
- Always proxy through AI Gateway for caching, rate-limiting, and observability.
- Use structured output (JSON schema) — do not parse free-form text.

### Acceptance criteria for §10

- Manual trigger via API completes in < 30s for a room with 100 new messages.
- Each ingest run produces 0 or more proposals; 0 is a valid outcome and not an error.
- Proposals contain a non-empty `rationale` field.
- A second run with no new messages exits in < 1s with `status='succeeded'` and 0 proposals.
- All LLM calls visible in AI Gateway dashboard.
- An ingest run that fails mid-flight leaves a `failed` row with `error` populated; never a stuck `running` row (use `step.do` from Workflows for resumability).

### Subagent guidance

Do not parallelize the ingest path itself — it's sequential by nature. *Do* use a separate subagent to write the prompt-engineering tests (golden-file tests for the LLM output schema). Those tests can run in parallel with the agent code.

---

## 11. Wiki surface

### Intent

A read-write markdown wiki where pages are committed to Artifacts. The UI is the primary editing surface; the Artifacts repo is the escape hatch.

### Pages

- `/` — workspace home (renders `/wiki/_index.md`)
- `/w/*` — wiki page viewer/editor for the path after `/w/`
- `/r/:slug` — room view (chat)
- `/proposals` — proposal inbox
- `/search?q=...` — search results (hybrid)
- `/ask` — conversational RAG view (`/api/ask` UI)
- `/settings/byok` — BYOK key management
- `/settings/agents` — view/edit AGENTS.md

### Editor (❓ Q4)

Recommended: **Milkdown**. Reasons: WYSIWYG markdown round-trips cleanly, ProseMirror foundation, Obsidian-compatible if Q5 = Obsidian flavor, plugin ecosystem covers tables/code/math/wikilinks.

Alternatives: Tiptap (very similar; choose based on team familiarity), CodeMirror 6 (raw markdown, lower friction for power users — your dogfood team is technical, this is viable).

### Frontend framework (❓ Q3)

**Recommendation: Astro Islands + React for interactive bits.**

Rationale:
- Wiki pages are static-ish — Astro's MPA model fits.
- Chat and editor are islands that hydrate.
- Smaller JS payload than full SPA.
- Better SEO if you ever expose public wikis.
- First-class Cloudflare support via `@astrojs/cloudflare` (was Pages pre-v13; v13+ deploys as a Worker — see DEPLOY.md).

Alternative: SvelteKit (you've used it in WikiForge; fastest for you to ship; Cloudflare adapter is solid).

### Acceptance criteria for §11

- Editing a page and saving triggers a commit to Artifacts within 2s.
- Conflict on save (page changed since load) returns 409 with both versions; UI shows a 3-way merge.
- Wiki tree loads in < 200ms from cold cache.
- Search results return in < 500ms p50 against a 1k-page corpus.
- `/ask` returns a streamed answer with at least 2 citations within 3s p50.

---

## 12. Auth

### Intent

Cloudflare Access in front of the Worker. JIT user provisioning. Three tiers (set at deploy time):

1. **Solo/homelab** — Cloudflare Access free tier with email OTP. Default for `pnpm deploy`.
2. **Team** — Access + GitHub OAuth or Google Workspace OIDC.
3. **Enterprise** — any SAML/OIDC IDP via Access SaaS app.

### Files

- `apps/worker/src/lib/auth.ts` — JWT validation
- `apps/worker/src/middleware/auth.ts` — Hono middleware

### Validation flow

1. Worker reads `CF-Access-Jwt-Assertion` header.
2. Verifies against the Access JWKS for the team.
3. Extracts `email` and `sub` claims.
4. Looks up user by email; creates if missing (JIT).
5. Attaches `c.var.user` to Hono context.

### Acceptance criteria for §12

- Worker rejects all non-`/api/health` requests without a valid Access JWT.
- JWT verification < 5ms (cache JWKS in KV).
- New user appears in `users` table within one request after first login.
- The default deploy ships with email-OTP working out of the box; operator only sets two env vars (`ACCESS_TEAM`, `ACCESS_AUD`).

---

## 13. Observability

- **Workers Logs** — `observability.enabled = true` in `wrangler.jsonc`. 100% sampling for v0.0.1; reduce later.
- **Sentry** — `@sentry/cloudflare` SDK; capture unhandled errors and explicit `Sentry.captureException` for non-fatal failures (LLM timeouts, AI Search misses).
- **AI Gateway** — all LLM and embedding calls go through it. Use the dashboard for cost monitoring.
- **Workers Analytics Engine** — emit one event per: message sent, ingest run, proposal merged/rejected, search query, ask query. Schema: `{ workspace_id, event_kind, latency_ms, status, metadata_json }`.
- **No third-party analytics in v0.0.1** (Q14).

### Acceptance criteria for §13

- Every error visible in Sentry with request ID.
- Cost dashboard shows per-day spend by route in AI Gateway.
- A `wrangler tail` shows no log spam during idle.

---

## 14. Testing

- **Unit**: vitest + `@cloudflare/vitest-pool-workers`. Test pure functions in `lib/` and prompt builders.
- **DO tests**: miniflare-backed vitest pool. Test `ChatRoom` message flow end-to-end.
- **Integration**: spin up `wrangler dev` in CI; hit real routes; use a throwaway D1 from `wrangler d1 execute --local`.
- **Prompt golden tests**: golden-file tests for IngestAgent output against a fixture of 50 sample messages.
- **Smoke checklist**: documented in `docs/SMOKE.md`; run before every release tag.

### Acceptance criteria for §14

- `pnpm test` passes in < 60s locally.
- CI runs unit + DO + integration on every PR.
- Coverage > 60% on `apps/worker/src` (not a hard gate, but a target).

---

## 15. CI/CD

- **Workers Builds** connected to GitHub.
- `main` branch → production deploy at `api.{Q2-domain}` and `app.{Q2-domain}`.
- Other branches → preview deploy at `<branch>.<project>.workers.dev`.
- Every build runs: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `wrangler d1 migrations apply`, `wrangler deploy`.
- Migrations are forward-only. To roll back, write a new migration.

### Acceptance criteria for §15

- A push to `main` deploys to prod within 5 minutes.
- A failed test blocks deploy.
- D1 migrations are idempotent (safe to re-run).

---

## 16. POC scope (v0.0.1)

Everything below ships in v0.0.1. Anything not listed defers.

- Single workspace per deploy.
- Cloudflare Access OTP auth.
- Multi-room chat with WebSocket Hibernation.
- D1 mirror of all messages.
- Daily cron (02:00 UTC) commits chat logs to Artifacts.
- Manually-editable wiki via UI; commits to Artifacts.
- AI Search over `/wiki/**`.
- Inline `/ask` slash-command in chat that returns RAG'd answer with citations.
- Manual ingest trigger via `POST /api/rooms/:rid/ingest`.
- Proposal inbox UI (list, view diff, merge, reject).
- BYOK key UI (workspace-scoped Anthropic + OpenAI).
- Sentry + AI Gateway wired.
- `pnpm install && pnpm deploy` produces a working deploy on a fresh Cloudflare account.

---

## 17. Out of scope (POC)

- Threading
- Real-time presence / typing indicators / read receipts
- File uploads / attachments / image embedding
- Voice rooms / transcription
- Email-to-wiki ingest
- Slack/Teams/Discord ingest
- Scheduled (cron) ingest
- Auto-merge of low-risk proposals
- Multi-workspace per deploy
- E2E encryption
- Mobile-native apps
- Federation / multi-server
- Granular RBAC beyond admin/member/viewer
- Billing / payment / SaaS hosting
- Public/anonymous read-only wikis
- Plugin/extension system
- WebRTC anything
- Search ranking customization

---

## 18. Acceptance criteria for v0.0.1 (whole-product)

The POC is "done" when **all** of these are true for a fresh deploy on your dogfood domain:

1. A new user can sign in via email OTP and reach the workspace home.
2. A user can create a room, send a message, and a second user in another tab sees it within 200ms.
3. The next morning, the previous day's chat appears as a markdown file under `/rooms/{slug}/log/{date}.md` in the Artifacts repo.
4. A user can create a wiki page via the editor, and `git clone`-ing the Artifacts repo shows the page.
5. The search bar returns relevant pages for a 3-word query in < 500ms.
6. `/ask "what did we decide about X"` in a chat room returns a cited answer in < 5s.
7. Manually triggering ingest on a room with discussion produces ≥ 1 proposal that, when merged, appears as a wiki page commit in Artifacts.
8. Sentry shows no unhandled errors during the smoke checklist.
9. AI Gateway dashboard shows < $0.50 spend across the smoke run.
10. Total monthly Cloudflare bill for the dogfood deploy is < $10 with the dogfood team active.

---

## 19. Milestone breakdown for Claude Code

Each milestone is a self-contained chunk sized for one Claude Code session at `xhigh`. Open the milestone's section + sections 4, 5, 6 in the first turn. **Don't drip context.**

### M0 — Skeleton (one session)
- Initialize pnpm monorepo per §6.
- `wrangler.jsonc` per §5 (with placeholder IDs).
- Empty Hono worker with `/api/health`.
- Vitest config; one passing test.
- GitHub Actions CI (`.github/workflows/ci.yml`).
- `CLAUDE.md` written.
- **DoD**: `pnpm test` passes; `wrangler dev` serves `/api/health`.

### M1 — Auth + D1 + base API (one session)
- D1 migration `0001_init.sql` per §7.1.
- Access JWT middleware per §12.
- `/api/me`, `/api/workspaces/:wid`, `/api/workspaces/:wid/rooms`, `/api/rooms/:rid`.
- Zod schemas in `packages/schema`.
- Integration tests for each route.
- **DoD**: hitting `/api/me` with a real Access JWT returns the JIT-created user.

### M2 — Chat (DO + WebSocket) (one session)
- `ChatRoom` DO per §9 with WS hibernation.
- WS upgrade route in worker.
- DO SQLite + D1 mirror.
- `packages/shared/ws-protocol.ts`.
- DO unit tests with miniflare.
- **Subagent fan-out**: split worker DO and web WS client into two parallel subagents once `ws-protocol.ts` is committed.
- **DoD**: two `wscat` sessions to the same room exchange messages.

### M3 — Frontend shell + chat UI (one or two sessions)
- ❓ Resolve Q3 (framework) and Q4 (editor) before starting.
- App shell, Access-aware login flow.
- Room list + room view + WS client.
- Markdown rendering for messages.
- **Deploy topology**: `apps/web` deploys as a Cloudflare **Worker** (`@astrojs/cloudflare` v13 with the `assets` binding + an `API` service binding to `loomwiki-api`), not a Pages project. The full deploy + one-time Pages→Worker cutover procedure is in DEPLOY.md.
- **DoD**: chatting in the browser end-to-end works; reload preserves history.

### M4 — Wiki read/write + Artifacts integration (one session)
- `apps/worker/src/lib/artifacts.ts` — typed Artifacts client.
- Wiki page CRUD routes (§8).
- Bootstrap-vault script (`scripts/bootstrap-vault.ts`).
- Wiki page UI (viewer + editor — start read-only, then edit).
- Frontmatter parsing (gray-matter or remark-frontmatter).
- **DoD**: editing a page in UI creates a commit in Artifacts; `git clone` shows it.

### M5 — Daily chat-log commit cron (half session)
- Cron handler in worker.
- Aggregates yesterday's messages per room from D1.
- Commits one file per room per day to Artifacts.
- **DoD**: trigger `wrangler triggers cron` and see commits.

### M6 — AI Search + /ask (one session)
- AI Search instance bootstrap (manual one-time, document in `DEPLOY.md`).
- `apps/worker/src/lib/ai-search.ts`.
- `/api/search` and `/api/ask` routes.
- Search bar + ask UI.
- **DoD**: §18 acceptance criteria #5 and #6 pass.

### M7 — Ingest agent + proposal inbox (one or two sessions)
- `IngestAgent` per §10.
- `vault-template/AGENTS.md`.
- Prompt golden tests.
- Proposal inbox UI (list, diff view, merge button).
- **Subagent fan-out**: agent code, prompt tests, and proposal UI are three parallel subagents — protocol fixed by §10.2 lifecycle.
- **DoD**: §18 acceptance criteria #7 passes.

### M8 — BYOK + observability + polish (one session)
- BYOK envelope encryption (`lib/crypto.ts`).
- BYOK settings UI.
- AI Gateway proxy wiring.
- Sentry init.
- Smoke checklist (`docs/SMOKE.md`).
- `DEPLOY.md` for self-hosters.
- README polish.
- **DoD**: all of §18 passes.

**Total**: ~8–10 Claude Code sessions, ~6–10 weekends including the human review/dogfood-loop overhead.

---

## 20. Consolidated open questions

> *Edit answers directly into this section as decisions are made. Each answer should be a single line; rationale goes into `docs/ADR/`.*

### Blocking for v0.0.1

- **Q1 — Name**:
- **Q2 — Domain**:
- **Q3 — Frontend framework**:
- **Q4 — Editor**:
- **Q12 — Default LLM**:
- **Q19 — Dogfood team size**:

### Important — answer before relevant milestone

- **Q5 — Markdown flavor** (M4, suggested = GFM + bundle-absolute markdown links):
  - Input (2026-07-14): [OKF v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) — Google's draft Open Knowledge Format — standardizes exactly loomwiki's substrate (markdown + YAML frontmatter bundles) and uses standard bundle-absolute markdown links (`[text](/wiki/page.md)`), not wikilinks. Choosing GFM + bundle-absolute links makes vault links natively OKF-compatible, renders correctly on GitHub and every markdown tool, and avoids building a wikilink resolver (v0.0.1 renders `[[…]]` as code-fenced text). Counterpoint: title-based `[[wikilinks]]` are easier for the ingest agent to emit and friendlier to Obsidian users. Interacts with [#110](https://github.com/schmug/loomwiki/issues/110) (OKF export) — if Q5 lands on GFM links, its link-rewriting stage becomes a near-no-op.
- **Q6 — Workspace model** (M1, but POC = single):
- **Q7 — Ingest cadence** (M7, but POC = manual):
- **Q8 — Proposal mechanism** (M7, suggested = D1 status field, commit on merge):
- **Q9 — Direct human edits** (M4, suggested = yes):
- **Q11 — BYOK key storage** (M8, suggested = Workers Secrets Store, per-workspace):
- **Q20 — AI auto-merge tier** (M7, suggested = human-merge only for POC):

### Defer until v0.1+

- **Q10 — Threading**:
- **Q13 — Mobile**:
- **Q14 — Telemetry**:
- **Q15 — Slack/Teams/Discord ingest**:
- **Q16 — Email-to-wiki**:
- **Q17 — AGENTS.md user-editable**:
- **Q18 — Real-time presence**:

### Repo-level

- **Q21 — License** (suggested = Apache 2.0):
- **Q22 — Versioning scheme** (suggested = SemVer):
- **Q23 — Repo name** (depends on Q1):
- **Q24 — GitHub org** (`schmug` or new org):

---

## 21. Companion artifacts to create next

This SPEC.md is the master doc. Three more files should ship with the repo:

1. **`CLAUDE.md`** — auto-loaded every Claude Code session. Short (≤ 200 lines). Purpose: project conventions, commands, "do not touch" zones, where to find this spec. *Ask me to generate this next.*
2. **`vault-template/AGENTS.md`** — drafted in §10.1. Lives in the *vault*, not the code repo. *Already drafted; copy from §10.1.*
3. **`README.md`** — user-facing. Marketing-y, with the Deploy-to-Cloudflare button, screenshots, and a "what is this" pitch. *Ask me to generate this once Q1 (name) is resolved.*

Optional but useful:

4. **`docs/RATIONALE.md`** — paste the deep-research artifact here for posterity.
5. **`docs/SECURITY.md`** — threat model: prompt injection via chat content, BYOK key handling, abuse of self-hosted instances.
6. **`.github/ISSUE_TEMPLATE/milestone.md`** — template that mirrors the M0–M8 structure for tracking work.

---

*End of SPEC.md.*
