// SPDX-License-Identifier: Apache-2.0

// Error code constants for ApiResult<err> responses. Routes throw a typed
// LoomwikiError; the worker error middleware maps `code` → status and
// `code` → JSON body.
//
// Status mapping lives in apps/worker/src/middleware/error.ts and is the
// single source of truth for HTTP semantics; codes here are the wire format
// shared between worker and web.

export const ErrorCodes = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  AUTH_INVALID_JWT: "AUTH_INVALID_JWT",
  AUTH_EXPIRED: "AUTH_EXPIRED",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  CONFLICT: "CONFLICT",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  DB_PARSE_ERROR: "DB_PARSE_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
