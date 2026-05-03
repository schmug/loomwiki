// SPDX-License-Identifier: Apache-2.0

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export function apiOk<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

export function apiErr(code: string, message: string, details?: unknown): ApiResult<never> {
  const error: ApiError = { code, message };
  if (details !== undefined) error.details = details;
  return { ok: false, error };
}
