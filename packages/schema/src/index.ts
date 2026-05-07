// SPDX-License-Identifier: Apache-2.0

// Zod schemas + inferred types for the D1 row shapes declared in
// d1-migrations/0001_init.sql. Routes parse rows through these schemas to
// catch any DB drift loudly (DB_PARSE_ERROR → 500) rather than letting bad
// data trickle into API responses.
//
// Times are stored as unix epoch seconds. Conversion to ISO-8601 happens at
// the route layer (CLAUDE.md "Times: store as unix epoch seconds (integer)").

import { z } from "zod";

// UUIDv7 — sortable. Helper in @loomwiki/shared/id.
export const Uuidv7Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "must be a UUIDv7",
  );

const EpochSeconds = z.number().int().nonnegative();

// Email validation tracks the JWT `email` claim. Length cap matches RFC 5321.
const EmailSchema = z.string().email().max(320);

// Slug: kebab-case, lowercase, ASCII only, ≤ 60 chars (mirrors vault-template
// AGENTS.md slug rules). M1 prompt resolves this default explicitly.
export const SlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,59}$/, "slug must be kebab-case lowercase ASCII");

// ---------- D1 row schemas ----------

export const UserRowSchema = z.object({
  id: Uuidv7Schema,
  email: EmailSchema,
  display_name: z.string().min(1).max(120),
  avatar_url: z.string().url().nullable(),
  created_at: EpochSeconds,
});
export type User = z.infer<typeof UserRowSchema>;

export const WorkspaceRowSchema = z.object({
  id: Uuidv7Schema,
  name: z.string().min(1).max(120),
  owner_id: Uuidv7Schema,
  vault_repo: z.string().min(1),
  ai_search_id: z.string().nullable(),
  created_at: EpochSeconds,
});
export type Workspace = z.infer<typeof WorkspaceRowSchema>;

export const RoomRowSchema = z.object({
  id: Uuidv7Schema,
  workspace_id: Uuidv7Schema,
  slug: SlugSchema,
  name: z.string().min(1).max(120),
  topic: z.string().nullable(),
  created_by: Uuidv7Schema,
  created_at: EpochSeconds,
});
export type Room = z.infer<typeof RoomRowSchema>;

export const RoomMemberRoleSchema = z.enum(["admin", "member", "viewer"]);
export type RoomMemberRole = z.infer<typeof RoomMemberRoleSchema>;

export const RoomMemberRowSchema = z.object({
  room_id: Uuidv7Schema,
  user_id: Uuidv7Schema,
  role: RoomMemberRoleSchema,
  joined_at: EpochSeconds,
});
export type RoomMember = z.infer<typeof RoomMemberRowSchema>;

export const MessageRowSchema = z.object({
  id: Uuidv7Schema,
  room_id: Uuidv7Schema,
  user_id: Uuidv7Schema,
  body: z.string().max(4096),
  parent_id: Uuidv7Schema.nullable(),
  created_at: EpochSeconds,
  edited_at: EpochSeconds.nullable(),
  deleted_at: EpochSeconds.nullable(),
});
export type Message = z.infer<typeof MessageRowSchema>;

// ---------- Request body schemas ----------

export const CreateRoomRequestSchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1).max(120),
  topic: z.string().max(2000).optional(),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

// ---------- Wiki (M4) ----------

// Wiki page paths under the vault. Mirrors vault-template/AGENTS.md §7
// slug rules but widens the leading-character class to allow `_` so
// system files like /wiki/_index.md and /wiki/_open-questions.md fit.
//
// Anchored, ASCII-only, no traversal sequences, no uppercase. The body
// alphabet allows `_` and `-`, plus `/` for nested directories.
export const WIKI_PATH_REGEX = /^\/wiki\/[a-z0-9_][a-z0-9_/-]*\.md$/;

// Top-level vault files that bootstrap may write outside `/wiki/`. These
// are read-only via the wiki API in M4 (admin-only edit lands in M8).
const VAULT_TOP_LEVEL_ALLOWLIST = new Set(["/AGENTS.md", "/README.md"]);

/**
 * Returns `true` if `path` is a valid wiki page path under `/wiki/`.
 * Rejects `..`, uppercase, leading dot (but not leading underscore),
 * trailing slashes, double slashes, and non-`.md` extensions.
 */
export function validateWikiPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 256) return false;
  if (path.includes("..")) return false;
  if (path.includes("//")) return false;
  return WIKI_PATH_REGEX.test(path);
}

/**
 * Returns `true` if `path` is a top-level vault file that the bootstrap
 * routine may write (`/AGENTS.md`, `/README.md`). Used by the bootstrap
 * code path only — the wiki HTTP API never accepts these.
 */
export function isVaultTopLevelPath(path: string): boolean {
  return VAULT_TOP_LEVEL_ALLOWLIST.has(path);
}

export const WikiPageKindSchema = z.enum([
  "entity",
  "decision",
  "concept",
  "open-question",
  "glossary",
]);
export type WikiPageKind = z.infer<typeof WikiPageKindSchema>;

export const WikiPageStatusSchema = z.enum(["draft", "published", "superseded"]);
export type WikiPageStatus = z.infer<typeof WikiPageStatusSchema>;

// ISO-8601 date or datetime string (YYYY-MM-DD or full RFC 3339).
// Shape via regex; calendar validity (month/day in range) via refine — a
// loose regex would let "2026-13-99" through, which we want to reject so
// the editor catches typos before they hit the vault.
const ISO_DATE_LIKE_REGEX =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
const IsoDateLikeSchema = z
  .string()
  .min(8)
  .max(40)
  .regex(ISO_DATE_LIKE_REGEX, "must be an ISO-8601 date or datetime")
  .refine(
    (s) => {
      const datePart = s.slice(0, 10);
      const d = new Date(`${datePart}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) return false;
      // Reject calendar overflow (e.g. 2026-02-31 → March 3 in JS).
      return d.toISOString().slice(0, 10) === datePart;
    },
    { message: "calendar date must be valid" },
  );

export const WikiPageSourceSchema = z
  .object({
    room: z.string().min(1).max(120),
    message_id: z.string().min(1).max(64),
    excerpt: z.string().max(400).optional(),
  })
  .strict();
export type WikiPageSource = z.infer<typeof WikiPageSourceSchema>;

/**
 * Frontmatter required on every wiki page. Strict shape — extra
 * top-level keys are rejected so vault content stays in lockstep with
 * what the ingest agent (M7) writes.
 *
 * `superseded_by` is only meaningful when `status === "superseded"`
 * but the schema does not enforce that pairing — the M7 ingest agent
 * is the source of truth for that invariant; M4 just stores what the
 * user types.
 */
export const WikiPageFrontmatterSchema = z
  .object({
    title: z.string().min(1).max(200),
    kind: WikiPageKindSchema,
    created: IsoDateLikeSchema,
    last_updated: IsoDateLikeSchema,
    status: WikiPageStatusSchema,
    superseded_by: z.string().min(1).max(256).optional(),
    sources: z.array(WikiPageSourceSchema).max(50).optional(),
  })
  .strict();
export type WikiPageFrontmatter = z.infer<typeof WikiPageFrontmatterSchema>;

// 64 KB cap on the body. Mirrors vault-template/AGENTS.md §5.
export const WIKI_BODY_MAX_BYTES = 64 * 1024;

// Request bodies for the wiki write route. Accepts either a structured
// {frontmatter, body} shape (the default editor path) or a raw shape
// {raw} carrying a YAML-fenced page (the merge-dialog "Use this" path,
// where the user is editing the on-disk text directly). Exactly one of
// the two shapes is required.
const WikiPageStructuredWriteSchema = z
  .object({
    frontmatter: WikiPageFrontmatterSchema,
    body: z.string(), // length validated separately so the code is VALIDATION_FAILED
    before_sha: z.string().min(1).max(128).optional(),
  })
  .strict();

const WikiPageRawWriteSchema = z
  .object({
    raw: z.string().min(1),
    before_sha: z.string().min(1).max(128).optional(),
  })
  .strict();

export const WikiPageWriteRequestSchema = z.union([
  WikiPageStructuredWriteSchema,
  WikiPageRawWriteSchema,
]);
export type WikiPageWriteRequest = z.infer<typeof WikiPageWriteRequestSchema>;

// ---------- LLM usage counters (M6) ----------

export const LlmUsageScopeTypeSchema = z.enum(["user", "workspace"]);
export type LlmUsageScopeType = z.infer<typeof LlmUsageScopeTypeSchema>;

// `scope_id` is either a UUIDv7 (for scope_type='user') or the literal
// sentinel '_workspace' (for scope_type='workspace'). The sentinel is
// chosen to be impossible to confuse with a UUIDv7 — UUIDs never begin
// with `_`. Schema validates the union shape; the cost-guard module
// enforces the per-row pairing.
export const LlmUsageScopeIdSchema = z.union([Uuidv7Schema, z.literal("_workspace")]);
export type LlmUsageScopeId = z.infer<typeof LlmUsageScopeIdSchema>;

const LlmUsageDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

export const LlmUsageRowSchema = z.object({
  workspace_id: Uuidv7Schema,
  day: LlmUsageDaySchema,
  scope_type: LlmUsageScopeTypeSchema,
  scope_id: LlmUsageScopeIdSchema,
  ask_count: z.number().int().nonnegative(),
  search_count: z.number().int().nonnegative(),
  // M7: third counter alongside ask/search. Workspace-scoped reads only
  // (cost-guard ignores the user-scoped column for ingest).
  ingest_count: z.number().int().nonnegative(),
  updated_at: EpochSeconds,
});
export type LlmUsageRow = z.infer<typeof LlmUsageRowSchema>;

export const LlmUsageKindSchema = z.enum(["ask", "search", "ingest"]);
export type LlmUsageKind = z.infer<typeof LlmUsageKindSchema>;

// ---------- Wiki search / ask responses (M6) ----------

export const WikiSearchSourceSchema = z.enum(["ai_search", "fts5"]);
export type WikiSearchSource = z.infer<typeof WikiSearchSourceSchema>;

export const WikiSearchModeSchema = z.enum(["hybrid", "fts5_fallback"]);
export type WikiSearchMode = z.infer<typeof WikiSearchModeSchema>;

export const WikiSearchResultSchema = z.object({
  path: z.string().regex(WIKI_PATH_REGEX, "must be a wiki page path"),
  title: z.string().min(1).max(200),
  kind: WikiPageKindSchema,
  snippet: z.string().max(2000),
  // AI Search returns a normalized hybrid score; FTS5 returns the raw
  // BM25 rank (lower-is-better). The orchestrator inverts FTS5's sign
  // so callers can sort descending in either mode.
  score: z.number(),
  source: WikiSearchSourceSchema,
  // The H1/H2 heading the matching chunk fell under, if any. AI Search
  // populates this from the chunk metadata; FTS5 leaves it null because
  // the index is row-per-page (no per-section granularity). The web
  // citation pill builds /w/<path>#<slugifyHeading(heading)> when set.
  heading: z.string().min(1).max(200).nullable().optional(),
});
export type WikiSearchResult = z.infer<typeof WikiSearchResultSchema>;

export const WikiSearchResponseSchema = z.object({
  results: z.array(WikiSearchResultSchema),
  mode: WikiSearchModeSchema,
});
export type WikiSearchResponse = z.infer<typeof WikiSearchResponseSchema>;

export const WikiSearchRequestSchema = z.object({
  query: z.string().max(2000), // empty allowed — returns []
  topK: z.number().int().min(1).max(50).optional(),
});
export type WikiSearchRequest = z.infer<typeof WikiSearchRequestSchema>;

// `/api/ask` request. Streamed SSE response carries `delta` events plus
// a final `citations` event whose payload is `WikiSearchResult[]`.
export const AskRequestSchema = z.object({
  question: z.string().min(1).max(4000),
});
export type AskRequest = z.infer<typeof AskRequestSchema>;

export const AskCitationSchema = z.object({
  path: z.string().regex(WIKI_PATH_REGEX),
  title: z.string().min(1).max(200),
  kind: WikiPageKindSchema,
  // Optional in-page anchor (slugified heading) — null when the
  // matching chunk had no heading (full-page chunk).
  heading_slug: z.string().nullable(),
});
export type AskCitation = z.infer<typeof AskCitationSchema>;

// Reindex (admin) response shape.
export const SearchReindexErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type SearchReindexError = z.infer<typeof SearchReindexErrorSchema>;

export const SearchReindexResponseSchema = z.object({
  pages_indexed: z.number().int().nonnegative(),
  errors: z.array(SearchReindexErrorSchema),
});
export type SearchReindexResponse = z.infer<typeof SearchReindexResponseSchema>;

// ---------- Ingest runs + Proposals (M7) ----------

export const ProposalActionSchema = z.enum(["create", "update"]);
export type ProposalAction = z.infer<typeof ProposalActionSchema>;

export const ProposalStatusSchema = z.enum(["pending", "merged", "rejected", "superseded"]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

// 2× WIKI_BODY_MAX_BYTES gives the LLM a small overrun budget while
// still rejecting truly oversize content; the agent validator fences
// proposals to the strict 64 KB cap before persistence.
export const ProposalRowSchema = z.object({
  id: Uuidv7Schema,
  run_id: Uuidv7Schema,
  page_path: z.string().regex(WIKI_PATH_REGEX, "must be a wiki page path"),
  action: ProposalActionSchema,
  before_sha: z.string().nullable(),
  after_content: z.string().max(WIKI_BODY_MAX_BYTES * 2),
  rationale: z.string().min(1).max(1000),
  status: ProposalStatusSchema,
  created_at: EpochSeconds,
  reviewed_at: EpochSeconds.nullable(),
  reviewed_by: Uuidv7Schema.nullable(),
  artifacts_commit: z.string().nullable(),
});
export type ProposalRow = z.infer<typeof ProposalRowSchema>;

// Backwards-compatible alias for the M4-era name.
export const ProposalSchema = ProposalRowSchema;
export type Proposal = ProposalRow;

export const IngestRunStatusSchema = z.enum(["running", "succeeded", "failed"]);
export type IngestRunStatus = z.infer<typeof IngestRunStatusSchema>;

// `triggered_by` is either a UUIDv7 (manual trigger by a workspace
// member) or the literal string "cron" (scheduled run). Mirrors the
// llm_usage_daily.scope_id pattern: a UUIDv7 cannot start with the
// letter 'c' (UUIDv7 hex chars are 0-9 and a-f), so the union is
// unambiguous.
export const IngestRunTriggerSchema = z.union([Uuidv7Schema, z.literal("cron")]);
export type IngestRunTrigger = z.infer<typeof IngestRunTriggerSchema>;

export const IngestRunRowSchema = z.object({
  id: Uuidv7Schema,
  room_id: Uuidv7Schema,
  triggered_by: IngestRunTriggerSchema,
  started_at: EpochSeconds,
  finished_at: EpochSeconds.nullable(),
  // The bookmark — id of the newest message processed by this run.
  // Subsequent runs read messages with id > last_message_id.
  last_message_id: Uuidv7Schema.nullable(),
  status: IngestRunStatusSchema,
  summary: z.string().max(280).nullable(),
  error: z.string().max(2000).nullable(),
});
export type IngestRunRow = z.infer<typeof IngestRunRowSchema>;

// ---------- Ingest agent JSON-mode response ----------
//
// The agent is required to emit JSON matching this schema exactly. Any
// deviation either fails Zod parsing (triggering retry) or — for the
// fields whose constraints lift directly from vault-template/AGENTS.md
// §5 — is rejected by the path/secret/source validators downstream.
//
// Sources are validated against the run's input message-id set; a
// fabricated id rejects the proposal at validateProposals().

const IngestProposalSourceSchema = z
  .object({
    room_id: Uuidv7Schema,
    message_id: Uuidv7Schema,
    excerpt: z.string().max(400).optional(),
  })
  .strict();
export type IngestProposalSource = z.infer<typeof IngestProposalSourceSchema>;

export const IngestProposalSchema = z
  .object({
    action: ProposalActionSchema,
    page_path: z.string().regex(WIKI_PATH_REGEX, "must be a wiki page path"),
    after_content: z.string().min(1).max(WIKI_BODY_MAX_BYTES),
    rationale: z.string().min(1).max(1000),
    sources: z.array(IngestProposalSourceSchema).min(1).max(20),
  })
  .strict();
export type IngestProposal = z.infer<typeof IngestProposalSchema>;

export const IngestAgentResponseSchema = z
  .object({
    summary: z.string().max(280),
    proposals: z.array(IngestProposalSchema).max(20),
  })
  .strict();
export type IngestAgentResponse = z.infer<typeof IngestAgentResponseSchema>;

// ---------- M8: BYOK metadata, workspace settings, audit log ----------

export const ByokProviderSchema = z.enum(["anthropic", "openai", "google"]);
export type ByokProvider = z.infer<typeof ByokProviderSchema>;

// v0.0.1 surfaces only Anthropic + OpenAI in the settings UI; Google is
// reserved in the enum (and the M1 schema's CHECK) but the UI won't
// offer it until a default model is wired. The provider-resolver in
// lib/llm.ts maps by model-name prefix.
export const BYOK_UI_PROVIDERS = ["anthropic", "openai"] as const;

/**
 * Public-API representation of a stored BYOK key. The plaintext key
 * never leaves the worker — the metadata is the entire shape returned
 * by GET /api/settings/byok.
 */
export const BYOKKeyMetadataSchema = z.object({
  workspace_id: Uuidv7Schema,
  provider: ByokProviderSchema,
  has_key: z.boolean(),
  created_at: EpochSeconds,
  created_by: Uuidv7Schema,
  last_used_at: EpochSeconds.nullable(),
});
export type BYOKKeyMetadata = z.infer<typeof BYOKKeyMetadataSchema>;

/**
 * Body of `PUT /api/settings/byok/:provider`. The plaintext `key` lives
 * in memory only for the duration of the request; the response carries
 * metadata, never the key.
 */
export const SetBYOKKeyRequestSchema = z.object({
  key: z.string().min(8).max(2048),
});
export type SetBYOKKeyRequest = z.infer<typeof SetBYOKKeyRequestSchema>;

/**
 * D1 row schema for `workspace_settings`. Strict — extra keys reject so
 * future migrations that add columns force the parser to be updated
 * before the runtime sees them.
 */
export const WorkspaceSettingsRowSchema = z.object({
  workspace_id: Uuidv7Schema,
  timezone: z.string().min(1).max(64),
  default_model: z.string().min(1).max(120),
  updated_at: EpochSeconds,
  updated_by: Uuidv7Schema.nullable(),
});
export type WorkspaceSettingsRow = z.infer<typeof WorkspaceSettingsRowSchema>;

// IANA timezone allowlist for v0.0.1. Bundled list of ~40 common zones
// — the dropdown is a small UX surface and a full IANA database is
// overkill. Operators can extend by editing this list (and the test).
// "UTC" is the fallback default.
export const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Phoenix",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Helsinki",
  "Europe/Athens",
  "Europe/Istanbul",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Karachi",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Manila",
  "Australia/Perth",
  "Australia/Sydney",
  "Pacific/Auckland",
] as const;

const TimezoneSchema = z.enum(COMMON_TIMEZONES);

// Default LLM model IDs the UI offers. Workers AI ids prefixed with
// `@cf/`; BYOK options carry a `byok:<provider>` sentinel that the
// runtime resolves at chat-time. Explicit allowlist keeps a typo'd
// model from reaching env.AI.run().
export const SUPPORTED_DEFAULT_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3-70b-instruct",
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "byok:anthropic",
  "byok:openai",
] as const;
const DefaultModelSchema = z.enum(SUPPORTED_DEFAULT_MODELS);

export const UpdateWorkspaceSettingsRequestSchema = z
  .object({
    timezone: TimezoneSchema,
    default_model: DefaultModelSchema,
  })
  .strict();
export type UpdateWorkspaceSettingsRequest = z.infer<typeof UpdateWorkspaceSettingsRequestSchema>;

export const UpdateAgentsMdRequestSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(64 * 1024),
    // Server-side enforcement of the AGENTS.md confirmation dialog.
    // The web UI shows a confirm dialog and only sends `confirmed: true`
    // on user click. A request without the flag rejects with 400.
    confirmed: z.literal(true),
  })
  .strict();
export type UpdateAgentsMdRequest = z.infer<typeof UpdateAgentsMdRequestSchema>;

// ---------- Audit log ----------

export const AuditActionSchema = z.enum([
  "proposal.merge",
  "proposal.reject",
  "byok.create",
  "byok.delete",
  "agentsmd.update",
  "workspace_settings.update",
  "manual_ingest.trigger",
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

export const AuditResourceKindSchema = z.enum([
  "proposal",
  "byok",
  "agentsmd",
  "workspace_settings",
  "ingest",
]);
export type AuditResourceKind = z.infer<typeof AuditResourceKindSchema>;

// 4 KB cap per snapshot — enforced in lib/audit.ts at write time, but
// also expressed in the schema so a hand-crafted INSERT can't sneak a
// larger blob past parsing.
export const AUDIT_SNAPSHOT_MAX_BYTES = 4 * 1024;

export const AuditLogRowSchema = z.object({
  id: Uuidv7Schema,
  workspace_id: Uuidv7Schema,
  actor_user_id: Uuidv7Schema.nullable(),
  action: AuditActionSchema,
  resource_kind: AuditResourceKindSchema,
  resource_id: z.string().max(128).nullable(),
  before_json: z.string().max(AUDIT_SNAPSHOT_MAX_BYTES).nullable(),
  after_json: z.string().max(AUDIT_SNAPSHOT_MAX_BYTES).nullable(),
  request_id: z.string().max(64).nullable(),
  created_at: EpochSeconds,
});
export type AuditLogRow = z.infer<typeof AuditLogRowSchema>;

// Public API shape — same fields, the worker serializer just doesn't
// repeat the row schema name. Kept distinct for forward-compatibility:
// when v0.1 adds a "diff" computed field, it lands in the API shape
// without changing the on-disk row schema.
export const AuditLogEntrySchema = AuditLogRowSchema;
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;
