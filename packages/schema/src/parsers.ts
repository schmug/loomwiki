// SPDX-License-Identifier: Apache-2.0

// Typed row parsers for D1 result rows. A failed parse means the DB returned
// a shape we don't expect — that's a 500 with code `DB_PARSE_ERROR`, not a
// 4xx, because the client did nothing wrong.
//
// Routes call these on every read so schema drift surfaces loudly instead of
// causing silent bad data downstream.

import { ErrorCodes, LoomwikiError } from "@loomwiki/shared";
import type { infer as ZodInfer, ZodTypeAny } from "zod";
import {
  AuditLogRowSchema,
  IngestRunRowSchema,
  LlmUsageRowSchema,
  MessageRowSchema,
  ProposalRowSchema,
  RoomMemberRowSchema,
  RoomRowSchema,
  UserRowSchema,
  type WikiPageFrontmatter,
  WikiPageFrontmatterSchema,
  WorkspaceRowSchema,
  WorkspaceSettingsRowSchema,
} from "./index.js";

function parseRow<S extends ZodTypeAny>(schema: S, row: unknown, table: string): ZodInfer<S> {
  const result = schema.safeParse(row);
  if (!result.success) {
    throw new LoomwikiError("DB_PARSE_ERROR", `Failed to parse ${table} row`, {
      status: 500,
      details: result.error.issues,
    });
  }
  return result.data;
}

export const parseUserRow = (row: unknown) => parseRow(UserRowSchema, row, "users");
export const parseWorkspaceRow = (row: unknown) => parseRow(WorkspaceRowSchema, row, "workspaces");
export const parseRoomRow = (row: unknown) => parseRow(RoomRowSchema, row, "rooms");
export const parseRoomMemberRow = (row: unknown) =>
  parseRow(RoomMemberRowSchema, row, "room_members");
export const parseMessageRow = (row: unknown) => parseRow(MessageRowSchema, row, "messages");
export const parseLlmUsageRow = (row: unknown) =>
  parseRow(LlmUsageRowSchema, row, "llm_usage_daily");
export const parseIngestRunRow = (row: unknown) => parseRow(IngestRunRowSchema, row, "ingest_runs");
export const parseProposalRow = (row: unknown) => parseRow(ProposalRowSchema, row, "proposals");
export const parseAuditLogRow = (row: unknown) => parseRow(AuditLogRowSchema, row, "audit_log");
export const parseWorkspaceSettingsRow = (row: unknown) =>
  parseRow(WorkspaceSettingsRowSchema, row, "workspace_settings");

/**
 * Parse a Zod-validated wiki frontmatter object. Caller hands in an
 * already-decoded YAML object (gray-matter handles YAML → JS); this
 * function validates the shape against the strict Zod schema and
 * raises a typed LoomwikiError on failure so the route layer can map
 * to a 400 with `code: VALIDATION_FAILED`.
 */
export function parseWikiFrontmatter(value: unknown): WikiPageFrontmatter {
  const result = WikiPageFrontmatterSchema.safeParse(value);
  if (!result.success) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid wiki page frontmatter", {
      status: 400,
      details: result.error.issues,
    });
  }
  return result.data;
}

export type {
  AskCitation,
  AskRequest,
  AuditAction,
  AuditLogEntry,
  AuditLogRow,
  AuditResourceKind,
  ByokProvider,
  BYOKKeyMetadata,
  IngestAgentResponse,
  SetBYOKKeyRequest,
  UpdateAgentsMdRequest,
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettingsRow,
  IngestProposal,
  IngestProposalSource,
  IngestRunRow,
  IngestRunStatus,
  IngestRunTrigger,
  LlmUsageKind,
  LlmUsageRow,
  LlmUsageScopeId,
  LlmUsageScopeType,
  Message,
  Proposal,
  ProposalAction,
  ProposalRow,
  ProposalStatus,
  Room,
  RoomMember,
  RoomMemberRole,
  SearchReindexError,
  SearchReindexResponse,
  User,
  WikiPageFrontmatter,
  WikiPageKind,
  WikiPageSource,
  WikiPageStatus,
  WikiPageWriteRequest,
  WikiSearchMode,
  WikiSearchRequest,
  WikiSearchResponse,
  WikiSearchResult,
  WikiSearchSource,
  Workspace,
} from "./index.js";
