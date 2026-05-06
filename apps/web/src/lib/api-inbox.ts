// SPDX-License-Identifier: Apache-2.0

// Typed helpers for the M7 inbox routes. Mirrors the api-search /
// api-wiki shape: every helper returns the typed payload directly,
// or surfaces an ApiError for the caller to inspect.

import { apiGet, apiPost } from "@/lib/api";
import type {
  MergeProposalResponse,
  ProposalCountResponse,
  ProposalDetailResponse,
  ProposalStatus,
  ProposalsListResponse,
  RejectProposalResponse,
  RunDetailResponse,
  TriggerIngestResponse,
} from "@/lib/types";

export function listProposals(status: ProposalStatus = "pending"): Promise<ProposalsListResponse> {
  return apiGet<ProposalsListResponse>(`/api/proposals?status=${encodeURIComponent(status)}`);
}

export function countProposals(status: ProposalStatus = "pending"): Promise<ProposalCountResponse> {
  return apiGet<ProposalCountResponse>(
    `/api/proposals?count=true&status=${encodeURIComponent(status)}`,
  );
}

export function getProposal(id: string): Promise<ProposalDetailResponse> {
  return apiGet<ProposalDetailResponse>(`/api/proposals/${encodeURIComponent(id)}`);
}

export function mergeProposal(id: string, beforeSha?: string): Promise<MergeProposalResponse> {
  const body: { before_sha?: string } = {};
  if (beforeSha !== undefined) body.before_sha = beforeSha;
  return apiPost<MergeProposalResponse>(`/api/proposals/${encodeURIComponent(id)}/merge`, body);
}

export function rejectProposal(id: string): Promise<RejectProposalResponse> {
  return apiPost<RejectProposalResponse>(`/api/proposals/${encodeURIComponent(id)}/reject`, {});
}

export function triggerIngest(roomId: string): Promise<TriggerIngestResponse> {
  return apiPost<TriggerIngestResponse>(`/api/rooms/${encodeURIComponent(roomId)}/ingest`, {});
}

export function getRunStatus(runId: string): Promise<RunDetailResponse> {
  return apiGet<RunDetailResponse>(`/api/runs/${encodeURIComponent(runId)}`);
}
