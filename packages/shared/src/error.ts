// SPDX-License-Identifier: Apache-2.0

export interface LoomwikiErrorOptions {
  cause?: unknown;
  details?: unknown;
  status?: number;
}

export class LoomwikiError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly status: number;

  constructor(code: string, message: string, options: LoomwikiErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LoomwikiError";
    this.code = code;
    this.details = options.details;
    this.status = options.status ?? 500;
  }
}

export function isLoomwikiError(value: unknown): value is LoomwikiError {
  return value instanceof LoomwikiError;
}
