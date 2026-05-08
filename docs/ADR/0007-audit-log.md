<!-- SPDX-License-Identifier: Apache-2.0 -->

# ADR 0007 — Audit log for admin actions

- **Status**: Accepted
- **Date**: 2026-05-07
- **Milestone**: M8

## Context

`docs/SECURITY.md` §11 listed "no audit log for admin actions" as a
known gap: a compromised workspace owner merging a malicious proposal
left no trail beyond the Artifacts commit log, and the proposal-
lifecycle table (`proposals`) only records the final state, not who
took the transition or what they saw at the moment of decision. M8
closes the gap.

The shape question was small but load-bearing. Too thin and we lose
the forensic value (who, what, when, but not enough state to answer
"what would they have seen"). Too thick and we either hot-spot D1 on
write or accumulate so much data that retention becomes its own
problem before v0.1 lands. The deliverable is the smallest log that
answers the questions "who merged this proposal," "who deleted this
BYOK key," and "did the operator change `default_model` between yesterday
and today" — without inflating per-write latency or building a query
UI we don't yet need.

## Decision

### a. Action taxonomy: a fixed enum, not free text

The `audit_log.action` column is constrained at the schema layer
(`packages/schema`'s `AuditAction` enum) to one of:

- `proposal.merge`
- `proposal.reject`
- `byok.create`
- `byok.delete`
- `agentsmd.update`
- `workspace_settings.update`
- `manual_ingest.trigger`

That's it for v0.0.1. The taxonomy covers the four owner-only surfaces
(BYOK CRUD, AGENTS.md edit, workspace settings, manual ingest) plus the
two proposal lifecycle transitions a human is responsible for. The
enum is small enough to grep and the `auditXyz()` convenience helpers
in `lib/audit.ts` make the mapping unambiguous at the call site.

**Pure reads are not audited.** Listing proposals, rendering a wiki
page, fetching `/api/me` — all out of scope. The auditing target is
*decisions and mutations*, not access patterns. Adding read-side
auditing in v0.1 (for SOC-style "who saw what" needs) is non-breaking;
the action enum extends.

### b. Before/after snapshots, JSON, 4 KB-truncated each

Each row carries `before_json` and `after_json`: JSON-stringified
snapshots of the resource at the moments around the action. The hard
cap is 4 KB per snapshot (`AUDIT_SNAPSHOT_MAX_BYTES` in
`packages/schema`); over-cap payloads are wrapped as
`{"_truncated": true, "prefix": "<first ~4KB>"}` so a downstream reader
can detect truncation without inferring it from string shape.

Two design choices fall out:

- **Diffs are computed on read, not at write time.** Storing `{before,
  after}` rather than `{patch}` keeps the writer cheap and lets the v0.1
  audit-log UI render any diff format that suits it (line, structural,
  side-by-side).
- **Sensitive content is not snapshotted.** `auditByokCreate` records
  `{ provider, has_key: true }` — never the ciphertext, never the
  plaintext, never any prefix of either. The convenience helpers in
  `lib/audit.ts` are the contract surface the routes call into; the
  raw `recordAudit()` is reserved for site-specific handlers that
  know their snapshot shape is non-sensitive.

The 4 KB cap is empirical: AGENTS.md edits and proposal bodies that
fit comfortably under 4 KB cover the common case. A 12 KB AGENTS.md
update truncates with the prefix preserved — enough to reconstruct
"the operator added a new bullet" forensically.

### c. Best-effort write contract via `c.executionCtx.waitUntil`

`recordAudit()` is called from the route layer wrapped in
`c.executionCtx.waitUntil(...)`. The audit row INSERT happens after
the parent operation returns to the client. Two reasons:

1. **D1 latency variance must not appear on the merge button.** A
   merge that legitimately succeeded against the wiki backend should
   return 200 to the client even if D1 is having a bad ten seconds.
2. **An audit-log INSERT failure must not undo a successful merge.**
   Absent-but-acted-on audit is bad; blocking-on-audit-infra is worse,
   because the operator hits the button again, the wiki write fails on
   `before_sha` mismatch, and now you have a confused operator and a
   half-written audit log.

The contract: the parent operation succeeds first, the audit row is a
fire-and-forget tail. Audit-log INSERT failures bubble to Sentry via
the standard error handler so the operator notices a persistent
problem; transient blips disappear into `waitUntil`'s normal
swallow-on-isolate-end behavior.

### d. No rotation in v0.0.1

The `audit_log` table grows monotonically. A small dogfood team's
write rate is on the order of 5–50 rows/day; even pessimistically
that's < 20k rows/year, well inside D1's comfortable read-path. No
rotation, no archival, no time-windowed deletion in v0.0.1.

v0.1 introduces a rotation policy (operator-configurable retention
window, with archival to R2 before delete). v0.0.1's posture is
"truncate via DELETE if you must" — manual operator-triggered cleanup
documented in `DEPLOY.md` if the operator chooses.

### e. JSON-only access in v0.0.1; no UI

Reading the log is `GET /api/_admin/audit?since=&limit=&action=` —
workspace-owner-only, returns a `{ entries: AuditLogEntry[] }` JSON
payload. There is no web UI in v0.0.1. The operator is expected to use
either the JSON API directly or `wrangler d1 execute` for ad-hoc SQL
(see `DEPLOY.md` "Audit log queries" for the canonical snippets).

The rationale is the usual scope-cut: a log viewer with filtering,
pagination, expandable diff views, and timeline rendering is its own
small UI feature, and the v0.0.1 dogfood team can read JSON. The web
UI is tracked as a v0.1 deliverable (`docs/RELEASE.md` "Roadmap to
v0.1").

## Consequences

### Positive

- The known security gap "no audit log for admin actions"
  (`docs/SECURITY.md` §11) is closed for v0.0.1. Compromised-owner
  forensics now have a tail to follow.
- The taxonomy is small and grep-able. Adding a new action category is
  one enum value + one helper + one route call site — three diffs.
- Snapshots-not-diffs lets the v0.1 UI choose its rendering. We don't
  bake a diff format into the schema.
- `waitUntil` keeps the write off the latency budget. A merge that
  used to return in 80 ms returns in 80 ms; the audit row arrives a
  few hundred ms later with no observable user impact.

### Negative / accepted trade-offs

- **Audit absence isn't surfaced to the operator in the moment.** A
  D1 INSERT failure is logged to Sentry but the operator's UI shows
  the merge as successful. The forensic question "did this action
  audit?" requires checking Sentry for that request_id — acceptable
  for v0.0.1, but worth tightening if dogfood reveals a noise
  floor of audit failures.
- **Truncation is lossy on huge AGENTS.md edits.** A 50 KB AGENTS.md
  diff records the first ~4 KB of `before` and `after`. The full
  state lives in the Artifacts commit log; cross-reference by
  `request_id` and timestamp.
- **No tamper-evidence.** A workspace owner with D1 write access
  can rewrite the audit log. Cryptographic chaining (Merkle / hash-
  chain rows) is overkill for v0.0.1's threat model; the operator
  is already trusted with everything in their workspace. v0.1+ if
  external auditors enter the picture.
- **No per-action retention overrides.** Some teams might want
  long-term retention on `byok.create` and short retention on
  `manual_ingest.trigger`; v0.0.1 retains all rows uniformly. v0.1
  retention policy can read `action` and apply per-category rules.

### What this does NOT close

- **Right-to-deletion.** Audit rows reference `workspace_id` and
  `actor_user_id`, both pseudo-PII. A user-initiated deletion
  request that wants the audit tail to disappear isn't supported in
  v0.0.1. Documented in `docs/SECURITY.md` §M25 (audit log
  retention is part of the right-to-deletion gap).

## Revisit when

- D1 retention costs become non-trivial. Plan: configurable retention
  window + R2 archival (`audit_log_archive_<ym>.jsonl`).
- An operator wants tamper-evidence (regulated environment, external
  auditor). Plan: hash-chain rows, anchor periodically to a public
  service.
- A v0.1 audit-log web UI lands. The schema is intentionally
  ergonomic for it (sortable timestamps, indexable on action and
  resource_kind).

## Alternatives considered

- **Pre-computed diff in `diff_json` instead of `before_json` +
  `after_json`.** Rejected — locks the diff format at write time; a
  v0.1 UI that wants structured diffs would have to re-compute from
  Artifacts history.
- **Free-text action column.** Rejected — drift over time; the enum
  is a 2 KB cost in schema and saves a class of bug.
- **Synchronous audit write (await before responding).** Rejected —
  see decision (c). The latency cost on the merge button is the
  highest-touch surface in M8 and we won't pay it for an
  observability tail.
- **Audit reads (e.g. `proposal.list`, `wiki.read`).** Rejected for
  v0.0.1 — write volume would 10–100× and the forensic value at the
  current threat tier is low. Add when SOC-style "who saw what"
  enters scope.

## References

- `apps/worker/src/lib/audit.ts` — `recordAudit` + per-action helpers.
- `packages/schema/d1-migrations/0004_audit.sql` — `audit_log` table.
- `packages/schema` — `AuditAction`, `AuditResourceKind`,
  `AUDIT_SNAPSHOT_MAX_BYTES`.
- `apps/worker/src/__tests__/audit.test.ts` — snapshot truncation,
  helper round-trips, sensitive-field exclusion.
- `docs/SECURITY.md` §11 — closed gap row.
- `DEPLOY.md` "Audit log queries" — operator runbook.
