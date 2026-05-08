// SPDX-License-Identifier: Apache-2.0

// Minimal Sentry-compatible event sender for the M8 observability stack.
//
// Why not @sentry/cloudflare? The advisor's instinct is right that we
// should try the SDK first — but the SDK pulls a non-trivial OTel
// surface that we don't use, and a bug in the OTel layer would be
// invisible to vitest-pool-workers. The minimal sender is ~80 lines,
// fully testable with a stubbed fetch, and exposes the only Sentry
// surface this project actually uses: capture an unhandled exception,
// scrub PII, send. Documented in ADR-0008.
//
// Uses the Sentry "store" endpoint (older but stable) on the project
// host derived from the DSN. Each event includes:
//   - event_id (UUIDv4 hex no dashes per Sentry convention)
//   - timestamp (ISO-8601)
//   - level ("error" | "warning" | "info")
//   - tags: { request_id?, user_id? } — never email or workspace_id
//   - extra: caller-supplied
//   - exception (when capturing an Error)
//
// PII scrubbing runs on every event before the network call.

import type { ExecutionContext } from "@cloudflare/workers-types";

export interface ParsedDsn {
  host: string;
  projectId: string;
  publicKey: string;
  protocol: "https";
}

export function parseDsn(dsn: string): ParsedDsn | null {
  if (!dsn || dsn.length === 0) return null;
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // Sentry DSN shape: https://<publicKey>@<host>/<projectId>
  const publicKey = url.username;
  const projectId = url.pathname.replace(/^\/+/, "");
  if (!publicKey || !projectId) return null;
  return { host: url.host, projectId, publicKey, protocol: "https" };
}

interface SentryTags {
  request_id?: string;
  user_id?: string;
  // Never workspace_id, never email, never api_key.
}

interface SentryEvent {
  event_id: string;
  timestamp: string; // ISO-8601
  platform: "javascript";
  level: "error" | "warning" | "info";
  logger: string;
  tags: SentryTags;
  extra: Record<string, unknown>;
  exception?: {
    values: Array<{ type: string; value: string; stacktrace?: { frames: unknown[] } }>;
  };
  message?: string;
  release?: string;
}

export interface CaptureOptions {
  level?: "error" | "warning" | "info";
  tags?: SentryTags;
  extra?: Record<string, unknown>;
  request_id?: string | null;
  user_id?: string | null;
  release?: string | null;
}

const PII_FIELD_REGEX =
  /^(email|displayName|display_name|api_key|token|password|authorization|workspace_id)$/i;
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/**
 * Strip PII fields and email-shaped strings from event payload. Runs
 * recursively over `extra` and any user-supplied object inside it.
 * Workspace_id is also stripped — the SECURITY model treats it as
 * pseudo-identifying once correlated with chat content.
 */
export function scrubPII<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.replace(EMAIL_REGEX, "[redacted-email]") as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubPII(v)) as T;
  }
  if (typeof value === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (PII_FIELD_REGEX.test(k)) continue;
      obj[k] = scrubPII(v);
    }
    return obj as T;
  }
  return value;
}

function uuid4hex(): string {
  // 32-char hex, no dashes. Sentry convention.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Set version (4) and variant bits per RFC 4122.
  if (bytes[6] !== undefined) bytes[6] = (bytes[6] & 0x0f) | 0x40;
  if (bytes[8] !== undefined) bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function buildEvent(error: unknown, opts: CaptureOptions): SentryEvent {
  const event: SentryEvent = {
    event_id: uuid4hex(),
    timestamp: new Date().toISOString(),
    platform: "javascript",
    level: opts.level ?? "error",
    logger: "loomwiki",
    tags: {},
    extra: scrubPII(opts.extra ?? {}),
  };
  if (opts.request_id) event.tags.request_id = opts.request_id;
  if (opts.user_id) event.tags.user_id = opts.user_id;
  if (opts.release) event.release = opts.release;

  if (error instanceof Error) {
    event.exception = {
      values: [{ type: error.name, value: error.message }],
    };
  } else if (typeof error === "string") {
    event.message = error;
  } else if (error !== undefined) {
    event.message = String(error);
  }
  return event;
}

/**
 * Send an event to Sentry. Network failures are swallowed — Sentry is
 * an observability sink, not a critical-path dependency. The function
 * never throws.
 */
export async function sendEvent(dsn: string, event: SentryEvent): Promise<void> {
  const parsed = parseDsn(dsn);
  if (!parsed) return;
  const url = `${parsed.protocol}://${parsed.host}/api/${parsed.projectId}/store/`;
  const auth = [
    "Sentry sentry_version=7",
    "sentry_client=loomwiki/0.0.1",
    `sentry_key=${parsed.publicKey}`,
  ].join(", ");
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": auth,
      },
      body: JSON.stringify(event),
    });
  } catch {
    // Swallow — observability sink, not critical.
  }
}

/**
 * Capture an exception. Scrubs PII, builds the event, fires-and-forgets
 * via ctx.waitUntil when an ExecutionContext is supplied.
 */
export function captureException(
  env: { SENTRY_DSN?: string; CF_VERSION_METADATA?: { id: string } },
  error: unknown,
  ctx: ExecutionContext | undefined,
  opts: CaptureOptions = {},
): void {
  if (!env.SENTRY_DSN || env.SENTRY_DSN.length === 0) return;
  const release = opts.release ?? env.CF_VERSION_METADATA?.id ?? null;
  const event = buildEvent(error, { ...opts, release });
  const promise = sendEvent(env.SENTRY_DSN, event);
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(promise);
  }
}

/**
 * Hono middleware: install a global onError shim so unhandled errors
 * in any route are reported to Sentry with the request_id tag and
 * scrubbed extras. Routes that throw a typed LoomwikiError still go
 * through the error-handler middleware first (which catches and
 * returns ApiResult); the middleware does NOT capture LoomwikiError —
 * those are handled, not unhandled. We only care about real surprises.
 *
 * Returns a no-op middleware when SENTRY_DSN is unset (local dev,
 * tests without Sentry).
 */
export function sentryMiddleware(): import("hono").MiddlewareHandler<{
  Bindings: { SENTRY_DSN?: string; CF_VERSION_METADATA?: { id: string } };
  Variables: { request_id?: string; user?: { id: string } };
}> {
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      if (!(err && typeof err === "object" && "code" in err && "status" in err)) {
        // Only capture truly unhandled (non-LoomwikiError) errors.
        captureException(c.env, err, c.executionCtx, {
          level: "error",
          request_id: c.var.request_id ?? null,
          user_id: c.var.user?.id ?? null,
          extra: { path: c.req.path, method: c.req.method },
        });
      }
      throw err; // hand back to the error-handler middleware
    }
  };
}
