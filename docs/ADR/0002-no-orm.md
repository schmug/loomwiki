# ADR 0002 — No ORM for D1 access

- **Status**: Accepted
- **Date**: 2026-05-03
- **Milestone**: M1

## Context

M1 introduces the first D1 reads and writes in the worker (`/api/me`,
`/api/workspaces/:wid/rooms`, JIT user provisioning). At this point we choose
how queries are constructed and how rows become typed objects. Three options
were on the table:

1. **Raw `env.DB.prepare(sql).bind(...).run()`** + Zod-validated row parsers
   in `@loomwiki/schema/parsers`. No code generation, no schema-as-code, no
   query builder.
2. **Drizzle** — TypeScript schema declared in code, query builder generates
   SQL, `drizzle-kit` generates migrations. Mature D1 adapter.
3. **Kysely** — type-safe query builder over the existing schema. No
   migration story; introspection-only types via `kysely-codegen`.

A fourth option, an OO ORM (Prisma, Sequelize), is excluded — neither runs
well in Workers and both impose abstractions that would dwarf v0.0.1's data
needs.

## Decision

Use **option 1: raw prepared statements + Zod row parsers** for v0.0.1.

The data layer at this size is:

- 8 tables.
- Routes that touch ≤ 3 tables each.
- No joins more complex than `rooms ⋈ room_members`.

Drizzle and Kysely both shine when joins, partial selects, and dynamic
predicates start eating route code. Loomwiki isn't there yet. The friction
they would *add* in v0.0.1 — a second source of truth for the schema, a
build-time codegen step, learning-curve overhead for self-hosters reading
the worker — outweighs the ergonomics they would *give*.

Migrations stay in `packages/schema/d1-migrations/*.sql` and apply via
`wrangler d1 migrations apply` (Cloudflare-native; covered by ADR-0001's
"Cloudflare-only" posture). Forward-only — to roll back, write a new
migration.

Type safety lives in `@loomwiki/schema`:

- Zod schemas describe each table's row shape.
- `parseUserRow(row)` etc. wrap `schema.safeParse` and throw a typed
  `LoomwikiError` (`code: "DB_PARSE_ERROR"`, status 500) on drift.
- Routes always parse rows before returning them; raw `env.DB` results never
  hit the API surface unvalidated.

This means:

- Schema drift between migration SQL and TS types **fails loudly** the first
  time a route reads the affected column, instead of silently leaking bad
  shapes into responses.
- The wire format (ISO-8601 strings) and the storage format (epoch seconds)
  are explicitly converted at the route layer (`apps/worker/src/lib/serialize.ts`).

## Consequences

**Positive:**

- One source of truth: the SQL migration. Operators reading the repo see
  exactly what their D1 holds without reading a second TS schema file.
- Zero codegen. CI runs the migration in `--local` mode for tests; nothing
  else generates files into the tree.
- Tiny dependency footprint. No drizzle/kysely in the worker bundle.

**Negative / accepted trade-offs:**

- Manual SQL means typos in column names surface only when the query runs.
  Mitigated by the Zod parser (drift on read fails loudly) and by route
  integration tests.
- Hand-writing parameterized queries means hand-writing every `bind()` call.
  At v0.0.1's route count this is fine; if M7 (ingest) starts assembling
  complex predicates, revisit.
- No automatic `WHERE workspace_id = ?` scoping helper. We rely on every
  route writing the scope explicitly. The `assertWorkspaceMatch()` pattern
  (workspaces.ts) is the M1 convention; later milestones should keep it.

## Revisit when

- A single route exceeds ~30 lines of SQL juggling, or writes the same join
  three times across the codebase.
- M7 (ingest agent) starts dynamically composing `SELECT messages WHERE …`
  predicates from user filters.
- Any route needs to combine results from > 3 tables in a single query.
- A self-hoster reports that hand-rolled SQL is hard to extend in their
  fork.

## Alternatives revisited

If we revisit, **Drizzle** is the leading candidate. It has the best D1
adapter, codegen ergonomics that match the migration file format, and a
mature TS surface. Kysely would require us to add a migration story it
doesn't ship.
