// SPDX-License-Identifier: Apache-2.0

// Cookie-aware fetch wrapper around the worker's /api/* surface.
// Sends `credentials: "include"` so the Cloudflare Access cookie travels
// with every request. Local-dev-mode (X-Local-Dev-Email) is layered in
// by lib/dev.ts and consumed transparently here.
//
// Errors:
//   - 401 → AuthRequiredError carrying the Access login URL (read from
//     the SSR-injected <meta name="loomwiki-access-login-url">).
//   - 4xx/5xx with parseable ApiResult<err> → ApiError with the typed
//     code (one of ErrorCodes).
//   - non-JSON 5xx → ApiError(INTERNAL_ERROR).

import { type ApiResult, type ErrorCode, ErrorCodes } from "@loomwiki/shared";
import { devHeaders } from "./dev";

export class AuthRequiredError extends Error {
  loginUrl: string | null;
  constructor(loginUrl: string | null) {
    super("auth required");
    this.name = "AuthRequiredError";
    this.loginUrl = loginUrl;
  }
}

export class ApiError extends Error {
  code: ErrorCode | string;
  status: number;
  /**
   * Optional structured payload the worker attaches to typed errors —
   * e.g. the merge payload on a 409 CONFLICT from PUT /api/wiki/*.
   * Generic shape; specific helpers narrow before consuming.
   */
  details: unknown;
  constructor(code: ErrorCode | string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function readLoginUrlFromMeta(): string | null {
  if (typeof document === "undefined") return null;
  const meta = document.querySelector('meta[name="loomwiki-access-login-url"]');
  if (!meta) return null;
  const url = meta.getAttribute("content");
  return url && url.length > 0 ? url : null;
}

export interface RequestInitJson extends Omit<RequestInit, "body" | "headers"> {
  body?: unknown;
  headers?: Record<string, string>;
}

export async function request<T>(path: string, init: RequestInitJson = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...devHeaders(),
    ...(init.headers ?? {}),
  };

  const fetchInit: RequestInit = {
    method: init.method ?? "GET",
    credentials: "include",
    headers,
  };

  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    fetchInit.body = JSON.stringify(init.body);
  }

  let res: Response;
  try {
    res = await fetch(path, fetchInit);
  } catch (cause) {
    throw new ApiError(
      "NETWORK_ERROR",
      cause instanceof Error ? cause.message : "network error",
      0,
    );
  }

  if (res.status === 401) {
    throw new AuthRequiredError(readLoginUrlFromMeta());
  }

  // Try to parse the body as JSON. The worker always returns JSON for
  // /api/* (M1 convention).
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(
      ErrorCodes.INTERNAL_ERROR,
      `Non-JSON response (status ${res.status})`,
      res.status,
    );
  }

  const result = body as ApiResult<T> & {
    error?: { code: string; message: string; details?: unknown };
  };
  if (result && typeof result === "object" && "ok" in result) {
    if (result.ok) return result.data;
    throw new ApiError(result.error.code, result.error.message, res.status, result.error.details);
  }

  throw new ApiError(
    ErrorCodes.INTERNAL_ERROR,
    `Malformed API response (status ${res.status})`,
    res.status,
  );
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body });
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body });
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}
