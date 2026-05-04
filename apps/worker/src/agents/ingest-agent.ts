// SPDX-License-Identifier: Apache-2.0

// Ingest agent — the M7 marquee feature.
//
// Reads recent chat from one room, runs the LLM with a strict
// JSON-mode contract, and persists 0..N proposals for human review.
// Proposals are NEVER auto-merged (defense layer 5). Five independent
// guards from docs/SECURITY.md §2.2 ship together here:
//
//   1. Input sanitization (sanitizeMessages)
//   2. Structured output (Zod parse on the JSON body, retry-on-fail)
//   3. Path allowlist (validateWikiPath)
//   4. Secret scrub (scrubSecrets)
//   5. Admin-merge-only (no auto-merge code path exists)
//
// Each is implemented as a separate function with a separate test so a
// regression in one cannot silently disable another.

import {
  type IngestAgentResponse,
  IngestAgentResponseSchema,
  type IngestProposal,
  type WikiSearchResult,
  validateWikiPath,
} from "@loomwiki/schema";
import { id, isLoomwikiError } from "@loomwiki/shared";
import type { Env } from "../env.js";
import { VAULT_TEMPLATE_FILES } from "../generated/vault-template-manifest.js";
import { assertWithinLimit } from "../lib/cost-guard.js";
import { chat } from "../lib/llm.js";
import { searchWiki } from "../lib/search.js";
import { KvWikiBackend, type WikiBackend } from "../lib/wiki-backend.js";
import { acquireRunLock, markRunFailed, markRunSucceeded } from "./lock.js";
import {
  INGEST_TEMPERATURE,
  type SanitizedMessage,
  buildUserPrompt,
  getSystemPrompt,
} from "./prompts/ingest-system.js";

// --------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------

export interface RunIngestForRoomOptions {
  env: Env;
  roomId: string;
  workspaceId: string;
  /** UUIDv7 of the triggering user, or "cron" for scheduled runs. */
  triggeredBy: string;
  /** Optional injection point — defaults to `chat()` from lib/llm. */
  llm?: LlmFn;
  /** Optional backend injection — defaults to KvWikiBackend(env.WIKI_KV). */
  backend?: WikiBackend;
  /** Test seam — defaults to wall clock. */
  clock?: () => number;
  /**
   * Maximum messages per run. The default (500) is the resolved cap
   * from the M7 prompt; tests can override down to a small number for
   * cheap fixture-based assertions.
   */
  maxMessages?: number;
}

export type LlmFn = (args: {
  system: string;
  prompt: string;
  env: Env;
  workspaceId: string;
}) => Promise<{ text: string }>;

export interface RunIngestResult {
  runId: string;
  /** True if this caller actually ran the agent; false if the lock was held. */
  ran: boolean;
  /** When `ran=true`: agent's one-line summary. Undefined when lock-held. */
  summary?: string;
  /** When `ran=true`: count of proposals persisted. */
  proposalCount?: number;
}

const DEFAULT_MAX_MESSAGES = 500;
const FIRST_RUN_LOOKBACK_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAX_PARSE_RETRIES = 2; // 3 total LLM calls max per run
const SEARCH_QUERY_MAX_LEN = 200;
const SEARCH_TOP_K = 5;
const RUN_INGEST_KIND = "ingest" as const;

export async function runIngestForRoom(opts: RunIngestForRoomOptions): Promise<RunIngestResult> {
  const clock = opts.clock ?? (() => Date.now());

  // 1. Acquire the lock. If held, exit early with the existing run id.
  const lock = await acquireRunLock({
    env: opts.env,
    roomId: opts.roomId,
    triggeredBy: opts.triggeredBy,
    clock,
  });
  if (!lock.acquired) {
    return { runId: lock.runId, ran: false };
  }
  return executeIngestWork({ ...opts, runId: lock.runId });
}

/**
 * Run the cost-guard + agent body against an already-acquired lock.
 * Exposed so the manual route can split lock acquisition (fast,
 * synchronous response with run_id) from the slow LLM phase
 * (dispatched via ctx.waitUntil). The caller MUST have acquired the
 * lock first; otherwise the run row won't exist and updates will
 * silently no-op.
 */
export async function executeIngestWork(
  opts: RunIngestForRoomOptions & { runId: string },
): Promise<RunIngestResult> {
  const clock = opts.clock ?? (() => Date.now());
  const runId = opts.runId;

  try {
    // Cost guard — before any LLM call. Counter increments here.
    await assertWithinLimit({
      env: opts.env,
      workspaceId: opts.workspaceId,
      userId: opts.triggeredBy,
      kind: RUN_INGEST_KIND,
      clock,
    });
  } catch (err) {
    const code =
      isLoomwikiError(err) && err.code === "RATE_LIMITED" ? "rate_limited" : "cost_guard_error";
    await markRunFailed(opts.env, runId, { error: code, clock });
    throw err;
  }

  try {
    const result = await runAgentBody({ ...opts, runId });
    await markRunSucceeded(opts.env, runId, {
      lastMessageId: result.lastMessageId,
      summary: result.summary,
      clock,
    });
    return {
      runId,
      ran: true,
      summary: result.summary,
      proposalCount: result.proposalCount,
    };
  } catch (err) {
    const tag = err instanceof IngestError ? err.tag : "internal_error";
    await markRunFailed(opts.env, runId, { error: tag, clock });
    throw err;
  }
}

// --------------------------------------------------------------------
// Agent body
// --------------------------------------------------------------------

interface AgentBodyResult {
  summary: string;
  proposalCount: number;
  lastMessageId: string | null;
}

/** Internal failure with a structured tag for the ingest_runs.error column. */
export class IngestError extends Error {
  readonly tag: string;
  constructor(tag: string, message: string) {
    super(message);
    this.name = "IngestError";
    this.tag = tag;
  }
}

async function runAgentBody(
  opts: RunIngestForRoomOptions & { runId: string },
): Promise<AgentBodyResult> {
  const clock = opts.clock ?? (() => Date.now());
  const backend = opts.backend ?? new KvWikiBackend(opts.env.WIKI_KV);
  const maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;

  // 3. AGENTS.md — cached 5 min, with bundled-template fallback.
  const agentsMd = await loadAgentsMd(opts.env, backend, clock);

  // 4. Room messages since last bookmark (30-day fallback on first run).
  const room = await loadRoomBasics(opts.env, opts.roomId);
  if (room === null) {
    throw new IngestError("room_not_found", `Room ${opts.roomId} no longer exists`);
  }
  const sinceMessageId = await loadLastMessageBookmark(opts.env, opts.roomId);
  const sinceCreatedAt =
    sinceMessageId === null ? Math.floor(clock() / 1000) - FIRST_RUN_LOOKBACK_SECONDS : null;

  const rawMessages = await loadRoomMessages(opts.env, {
    roomId: opts.roomId,
    sinceMessageId,
    sinceCreatedAt,
    limit: maxMessages,
  });

  // 5. Sanitize. Failures redact rather than drop so message_id reservations
  //    remain stable for source citation across retries.
  const userIds = uniqueUserIds(rawMessages);
  const displayNames = await loadDisplayNames(opts.env, userIds);
  const sanitized = rawMessages.map((m) => sanitizeMessage(m, displayNames));

  // The empty-batch shape: short-circuit before incurring an LLM call.
  // assertWithinLimit already incremented the counter — that's fine, an
  // ingest run is one logical operation regardless of whether messages
  // were present.
  if (sanitized.length === 0) {
    return { summary: "No new messages.", proposalCount: 0, lastMessageId: null };
  }

  // 6+7. Build query, retrieve context.
  const query = buildSearchQuery(sanitized);
  const retrievedPages = query.length === 0 ? [] : await retrieveContext(opts.env, query);

  // 8. LLM call with retry-on-parse-fail.
  const userPrompt = buildUserPrompt({
    agentsMd,
    retrievedPages,
    messages: sanitized,
    roomId: opts.roomId,
    roomSlug: room.slug,
    runStartedAt: new Date(clock()).toISOString(),
  });
  const llm = opts.llm ?? defaultLlm;

  let response: IngestAgentResponse | null = null;
  let lastParseErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
    let text: string;
    try {
      const reply = await llm({
        env: opts.env,
        workspaceId: opts.workspaceId,
        system: getSystemPrompt(),
        prompt: userPrompt,
      });
      text = reply.text;
    } catch (err) {
      throw new IngestError(
        "llm_call_failed",
        `LLM call failed on attempt ${attempt + 1}: ${describe(err)}`,
      );
    }
    const parsed = parseAgentResponse(text);
    if (parsed.ok) {
      response = parsed.value;
      break;
    }
    lastParseErr = parsed.error;
  }
  if (response === null) {
    throw new IngestError(
      "parse_retry_exceeded",
      `parse_retry_exceeded: failed to parse agent response after ${
        MAX_PARSE_RETRIES + 1
      } attempts: ${describe(lastParseErr)}`,
    );
  }

  // 9. Validators (path allowlist + secret scrub + source citation).
  const sourceMessageIds = new Set(sanitized.map((m) => m.id));
  const validated = validateProposals(response.proposals, {
    sourceMessageIds,
    runRoomId: opts.roomId,
  });

  // 10. Persist.
  await persistProposals(opts.env, opts.runId, validated, clock);

  const newest = sanitized[sanitized.length - 1] ?? null;
  return {
    summary: response.summary || `Processed ${sanitized.length} message(s).`,
    proposalCount: validated.length,
    lastMessageId: newest?.id ?? null,
  };
}

// --------------------------------------------------------------------
// AGENTS.md loader (cached)
// --------------------------------------------------------------------

interface AgentsMdCacheEntry {
  text: string;
  expiresAt: number;
}

const AGENTS_MD_TTL_MS = 5 * 60 * 1000;
let agentsMdCache: AgentsMdCacheEntry | null = null;

const BUNDLED_AGENTS_MD = (() => {
  const file = VAULT_TEMPLATE_FILES.find((f) => f.path === "/AGENTS.md");
  if (!file) {
    throw new Error("vault-template manifest is missing /AGENTS.md");
  }
  return file.content;
})();

export async function loadAgentsMd(
  env: Env,
  backend: WikiBackend,
  clock: () => number,
): Promise<string> {
  const now = clock();
  if (agentsMdCache !== null && agentsMdCache.expiresAt > now) {
    return agentsMdCache.text;
  }

  // The vault stores AGENTS.md at the top-level `/AGENTS.md` path. The
  // M4 KV backend currently rejects writes outside /wiki|/rooms, but
  // reads of arbitrary paths via the read() interface ARE supported via
  // direct KV lookup. We try the backend first; if it returns null we
  // fall through to the bundled template.
  let text: string | null = null;
  try {
    const record = await backend.read("/AGENTS.md");
    if (record !== null && record.raw.length > 0) {
      text = record.raw;
    }
  } catch (err) {
    console.warn(
      `[ingest] backend.read("/AGENTS.md") threw, falling back to bundled template: ${describe(
        err,
      )}`,
    );
  }

  if (text === null) {
    text = BUNDLED_AGENTS_MD;
  }

  agentsMdCache = { text, expiresAt: now + AGENTS_MD_TTL_MS };
  return text;
}

/** Test helper: clear the in-memory AGENTS.md cache. */
export function _resetAgentsMdCache(): void {
  agentsMdCache = null;
}

// --------------------------------------------------------------------
// D1 helpers
// --------------------------------------------------------------------

interface RoomBasics {
  slug: string;
  workspace_id: string;
}

async function loadRoomBasics(env: Env, roomId: string): Promise<RoomBasics | null> {
  const row = await env.DB.prepare("SELECT slug, workspace_id FROM rooms WHERE id = ?")
    .bind(roomId)
    .first<RoomBasics>();
  return row ?? null;
}

async function loadLastMessageBookmark(env: Env, roomId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT last_message_id FROM ingest_runs
       WHERE room_id = ? AND status = 'succeeded'
       ORDER BY started_at DESC
       LIMIT 1`,
  )
    .bind(roomId)
    .first<{ last_message_id: string | null }>();
  return row?.last_message_id ?? null;
}

interface LoadRoomMessagesArgs {
  roomId: string;
  sinceMessageId: string | null;
  sinceCreatedAt: number | null;
  limit: number;
}

interface RawMessage {
  id: string;
  user_id: string;
  body: string;
  created_at: number;
  deleted_at: number | null;
}

async function loadRoomMessages(env: Env, args: LoadRoomMessagesArgs): Promise<RawMessage[]> {
  // Two query shapes:
  //   - sinceMessageId set: id > ? for resumption from bookmark.
  //   - first run: created_at >= ? to bound the look-back window.
  //
  // Both filter to room_id and take ASC order so the LLM sees
  // chronological context. limit caps cost per run.
  const stmt =
    args.sinceMessageId !== null
      ? env.DB.prepare(
          `SELECT id, user_id, body, created_at, deleted_at FROM messages
             WHERE room_id = ? AND id > ? AND deleted_at IS NULL
             ORDER BY created_at ASC, id ASC
             LIMIT ?`,
        ).bind(args.roomId, args.sinceMessageId, args.limit)
      : env.DB.prepare(
          `SELECT id, user_id, body, created_at, deleted_at FROM messages
             WHERE room_id = ? AND created_at >= ? AND deleted_at IS NULL
             ORDER BY created_at ASC, id ASC
             LIMIT ?`,
        ).bind(args.roomId, args.sinceCreatedAt ?? 0, args.limit);
  const rs = await stmt.all<RawMessage>();
  return (rs.results ?? []) as RawMessage[];
}

function uniqueUserIds(messages: RawMessage[]): string[] {
  const set = new Set<string>();
  for (const m of messages) set.add(m.user_id);
  return [...set];
}

async function loadDisplayNames(env: Env, ids: string[]): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const rs = await env.DB.prepare(
    `SELECT id, display_name FROM users WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ id: string; display_name: string }>();
  const out = new Map<string, string>();
  for (const row of rs.results ?? []) out.set(row.id, row.display_name);
  return out;
}

// --------------------------------------------------------------------
// Sanitization (defense layer 1)
// --------------------------------------------------------------------

// Zero-width chars (U+200B–U+200D, U+FEFF) + bidi overrides
// (U+202A–U+202E, U+2066–U+2069). Constructed from the source string
// rather than a regex literal so this file contains no embedded
// control codepoints — important for round-tripping through tooling
// that mishandles them.
const ZERO_WIDTH_OR_BIDI =
  /\u200B|\u200C|\u200D|\uFEFF|\u202A|\u202B|\u202C|\u202D|\u202E|\u2066|\u2067|\u2068|\u2069/g;

// Control characters except \n (U+000A) and \t (U+0009). Stripping
// these is the explicit sanitization goal; biome's
// noControlCharactersInRegex rule fires on the intentional pattern.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the deliberate sanitization goal
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Strip dangerous characters and HTML tags from a chat message body.
 * Returns "[message redacted]" if the result would be empty (a body
 * that consisted entirely of tags or zero-width characters).
 *
 * NFC-normalization, zero-width / bidi-control stripping, and HTML-tag
 * stripping together address attack scenarios A3 (steganographic) and
 * the immediate XSS vector from A1 (inline `<script>`). Prompt-injection
 * via plain-text instructions is handled by the system prompt, not here.
 */
export function sanitizeMessageBody(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return "[message redacted]";
  // 1. NFC normalize — collapses confusable code-point sequences.
  let s = raw.normalize("NFC");
  // 2. Strip zero-width + bidi controls.
  s = s.replace(ZERO_WIDTH_OR_BIDI, "");
  // 3. Strip raw HTML tags. M14's full sanitizer is the renderer's job;
  //    here we just keep tags out of the LLM context entirely.
  s = s.replace(/<[^>]*>/g, "");
  // 4. Strip control characters (except \n and \t).
  s = s.replace(CONTROL_CHARS, "");
  s = s.trim();
  if (s.length === 0) return "[message redacted]";
  return s;
}

function sanitizeMessage(
  m: RawMessage,
  displayNames: ReadonlyMap<string, string>,
): SanitizedMessage {
  return {
    id: m.id,
    user_id: m.user_id,
    display_name: displayNames.get(m.user_id) ?? "<unknown>",
    body: sanitizeMessageBody(m.body),
    created_at: m.created_at,
  };
}

// --------------------------------------------------------------------
// Search query construction
// --------------------------------------------------------------------

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "of",
  "to",
  "in",
  "for",
  "on",
  "with",
  "by",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "should",
  "could",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "what",
  "which",
  "who",
  "when",
  "where",
  "why",
  "how",
  "yes",
  "no",
  "ok",
  "okay",
  "thanks",
  "thank",
]);

/**
 * Build a query string from the message bodies. Picks the top noun-ish
 * tokens (words ≥ 4 chars not in the stopword list), deduplicated and
 * concatenated up to SEARCH_QUERY_MAX_LEN. Empty input → empty string.
 */
export function buildSearchQuery(messages: SanitizedMessage[]): string {
  if (messages.length === 0) return "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    const tokens = m.body
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
    for (const tok of tokens) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
      if (out.join(" ").length >= SEARCH_QUERY_MAX_LEN) break;
    }
    if (out.join(" ").length >= SEARCH_QUERY_MAX_LEN) break;
  }
  const joined = out.join(" ");
  return joined.length > SEARCH_QUERY_MAX_LEN ? joined.slice(0, SEARCH_QUERY_MAX_LEN) : joined;
}

async function retrieveContext(env: Env, query: string): Promise<WikiSearchResult[]> {
  try {
    const result = await searchWiki({ env, query, topK: SEARCH_TOP_K });
    return result.results;
  } catch (err) {
    console.warn(
      `[ingest] retrieveContext failed, proceeding with no retrieved pages: ${describe(err)}`,
    );
    return [];
  }
}

// --------------------------------------------------------------------
// Default LLM glue
// --------------------------------------------------------------------

const defaultLlm: LlmFn = async ({ env, workspaceId, system, prompt }) => {
  const result = await chat({
    env,
    workspaceId,
    system,
    prompt,
    temperature: INGEST_TEMPERATURE,
    responseFormat: "json_object",
  });
  return { text: result.text };
};

// --------------------------------------------------------------------
// Response parsing (defense layer 2)
// --------------------------------------------------------------------

interface ParseOk {
  ok: true;
  value: IngestAgentResponse;
}
interface ParseErr {
  ok: false;
  error: unknown;
}
export type ParseResult = ParseOk | ParseErr;

/**
 * Parse the LLM response. Tries straight JSON first; if the response is
 * wrapped in a fenced ```json block (common when the model ignores the
 * response_format directive), extracts the fenced content and retries.
 * The Zod schema is the final gate.
 */
export function parseAgentResponse(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: new Error("empty response") };
  }
  const candidates = [trimmed, extractFencedJson(trimmed)].filter((s): s is string => s !== null);
  let lastErr: unknown = null;
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      lastErr = err;
      continue;
    }
    const result = IngestAgentResponseSchema.safeParse(parsed);
    if (result.success) return { ok: true, value: result.data };
    lastErr = result.error;
  }
  return { ok: false, error: lastErr };
}

function extractFencedJson(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fence?.[1] ?? null;
}

// --------------------------------------------------------------------
// Validators (defense layers 3 + 4 + source-citation)
// --------------------------------------------------------------------

// Compact regex set for the secret scrub. Each pattern matches a
// well-known credential shape. False positives are acceptable — they
// cause a proposal to be dropped, not a request to fail with PII; ops
// can re-run with the message rewritten.
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "anthropic_api_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "openai_api_key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github_token", re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    name: "private_key_block",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)?PRIVATE KEY-----/,
  },
  // Generic JWT (three base64url segments separated by dots). May false-
  // positive on long fragmented hashes; we accept that to catch leaked
  // session tokens.
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

/**
 * Scan content for secret-shaped strings. Returns the first matching
 * pattern name on hit, null on clean. Defense layer 4.
 */
export function scrubSecrets(content: string): string | null {
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(content)) return p.name;
  }
  return null;
}

interface ValidateContext {
  /** Set of message_ids in the run input (any source not in the set is fabricated). */
  sourceMessageIds: Set<string>;
  /** The room this run is for (sources from other rooms are rejected). */
  runRoomId: string;
}

export interface ValidatedProposal extends IngestProposal {
  /** Reason this proposal made it through; useful for the per-run summary log. */
  __validation_pass: true;
}

/**
 * Apply the M3+M4+M8 validators to a list of agent-emitted proposals.
 * Drops invalid entries with a structured log line; returns the
 * survivors. A run with all proposals dropped still succeeds with 0
 * proposals — that's a valid outcome.
 */
export function validateProposals(
  proposals: IngestProposal[],
  ctx: ValidateContext,
): ValidatedProposal[] {
  const out: ValidatedProposal[] = [];
  for (const p of proposals) {
    const reason = validateOne(p, ctx);
    if (reason !== null) {
      console.warn({
        event: "proposal_rejected",
        page_path: p.page_path,
        reason,
      });
      continue;
    }
    out.push({ ...p, __validation_pass: true });
  }
  return out;
}

function validateOne(p: IngestProposal, ctx: ValidateContext): string | null {
  // Layer 3: path allowlist.
  if (!validateWikiPath(p.page_path)) {
    return "path_disallowed";
  }
  // Layer 4: secret scrub on content + rationale.
  const secretInBody = scrubSecrets(p.after_content);
  if (secretInBody !== null) return `secret_scrub_triggered:${secretInBody}`;
  const secretInRationale = scrubSecrets(p.rationale);
  if (secretInRationale !== null) return `secret_scrub_triggered:${secretInRationale}`;

  // Source citation: every message_id must exist in input; room_id must match.
  if (p.sources.length === 0) return "no_sources";
  for (const src of p.sources) {
    if (src.room_id !== ctx.runRoomId) return "source_room_mismatch";
    if (!ctx.sourceMessageIds.has(src.message_id)) return "source_not_in_input";
  }
  return null;
}

// --------------------------------------------------------------------
// Persistence
// --------------------------------------------------------------------

async function persistProposals(
  env: Env,
  runId: string,
  proposals: ValidatedProposal[],
  clock: () => number,
): Promise<void> {
  if (proposals.length === 0) return;
  const nowSec = Math.floor(clock() / 1000);
  // Sequential inserts. D1 batch APIs exist but the proposal cap is 20
  // per run and the hot path is human review, not throughput.
  for (const p of proposals) {
    const proposalId = id();
    await env.DB.prepare(
      `INSERT INTO proposals
         (id, run_id, page_path, action, before_sha, after_content, rationale, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
      .bind(proposalId, runId, p.page_path, p.action, null, p.after_content, p.rationale, nowSec)
      .run();
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
