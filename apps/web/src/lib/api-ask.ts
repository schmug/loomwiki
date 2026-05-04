// SPDX-License-Identifier: Apache-2.0

// Streaming consumer for POST /api/ask. The route emits Server-Sent
// Events:
//
//   data: {"text": "..."}\n\n                      (incremental token chunk)
//   event: citations\ndata: [{...}, {...}]\n\n    (final citations)
//   event: done\ndata: {}\n\n                     (stream complete)
//
// We don't use the browser EventSource because:
//   1. EventSource is GET-only; /api/ask is POST.
//   2. We need to send custom headers (X-Local-Dev-Email in dev) and
//      `credentials: include` for the Access cookie.
//   3. We want a real AbortController so the user can hit Stop.
//
// Errors: when the worker rejects before the stream opens (401, 429,
// schema 400) it returns a normal JSON ApiResult<err>. We detect that by
// inspecting Content-Type and surface an `ApiError` to onError. A 429
// RATE_LIMITED with `details` is the trigger for the rate-limit banner —
// `.details` is preserved verbatim.

import { ApiError, AuthRequiredError } from "@/lib/api";
import { devHeaders } from "@/lib/dev";
import type { AskCitation } from "@/lib/types";
import { ErrorCodes } from "@loomwiki/shared";

export interface AskStreamCallbacks {
  /** Each token chunk from the model. Append to the rendered answer. */
  onDelta(text: string): void;
  /** Final citations. Always fires before `onDone` on a successful stream. */
  onCitations(citations: AskCitation[]): void;
  /** Stream complete — no more events. */
  onDone(): void;
  /**
   * Pre-stream HTTP error (401/429/4xx) or a mid-stream parse / network
   * failure. After this fires, no further callbacks fire.
   */
  onError(err: ApiError | AuthRequiredError): void;
}

export interface AskStreamHandle {
  /** Aborts the in-flight fetch + reader. Idempotent. */
  abort(): void;
}

export function askStream(question: string, callbacks: AskStreamCallbacks): AskStreamHandle {
  const controller = new AbortController();
  let aborted = false;

  void run(question, callbacks, controller);

  return {
    abort: () => {
      if (aborted) return;
      aborted = true;
      controller.abort();
    },
  };
}

async function run(
  question: string,
  callbacks: AskStreamCallbacks,
  controller: AbortController,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/ask", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...devHeaders(),
      },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });
  } catch (cause) {
    if (controller.signal.aborted) {
      // User-initiated abort — surface a typed error so the UI can
      // distinguish abort from a network failure if it cares.
      callbacks.onError(new ApiError("ABORTED", "request aborted", 0));
      return;
    }
    callbacks.onError(
      new ApiError("NETWORK_ERROR", cause instanceof Error ? cause.message : "network error", 0),
    );
    return;
  }

  if (res.status === 401) {
    callbacks.onError(new AuthRequiredError(readLoginUrlFromMeta()));
    return;
  }

  // The worker returns SSE on success and JSON on error. Distinguish by
  // Content-Type: a JSON body means the request was rejected before any
  // SSE frames were written.
  const contentType = res.headers.get("Content-Type") ?? "";
  const isJson = contentType.includes("application/json");
  if (!res.ok || isJson) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      callbacks.onError(
        new ApiError(
          ErrorCodes.INTERNAL_ERROR,
          `Non-JSON response (status ${res.status})`,
          res.status,
        ),
      );
      return;
    }
    const result = body as {
      ok?: boolean;
      error?: { code: string; message: string; details?: unknown };
    };
    if (result && typeof result === "object" && result.ok === false && result.error) {
      callbacks.onError(
        new ApiError(result.error.code, result.error.message, res.status, result.error.details),
      );
      return;
    }
    callbacks.onError(
      new ApiError(
        ErrorCodes.INTERNAL_ERROR,
        `Malformed API response (status ${res.status})`,
        res.status,
      ),
    );
    return;
  }

  if (!res.body) {
    callbacks.onError(new ApiError(ErrorCodes.INTERNAL_ERROR, "Response had no body", res.status));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // Carry-over buffer: SSE frames are delimited by \n\n, but a single
  // network read may deliver a partial frame. Hold the tail until we
  // see the next delimiter.
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Drain every complete frame from the buffer.
      let delimIdx = buffer.indexOf("\n\n");
      while (delimIdx !== -1) {
        const frame = buffer.slice(0, delimIdx);
        buffer = buffer.slice(delimIdx + 2);
        const result = handleFrame(frame, callbacks);
        if (result === "done") {
          // Stop reading; the route may close after the done frame and
          // we don't want to block on a closed stream.
          callbacks.onDone();
          await reader.cancel().catch(() => {});
          return;
        }
        delimIdx = buffer.indexOf("\n\n");
      }
    }
    // Stream ended cleanly without an explicit done event — flush any
    // residual frame, then signal done so the UI can re-enable submit.
    if (buffer.trim().length > 0) {
      handleFrame(buffer, callbacks);
    }
    callbacks.onDone();
  } catch (cause) {
    if (controller.signal.aborted) {
      callbacks.onError(new ApiError("ABORTED", "request aborted", 0));
      return;
    }
    callbacks.onError(
      new ApiError(
        "NETWORK_ERROR",
        cause instanceof Error ? cause.message : "stream read failed",
        0,
      ),
    );
  }
}

/**
 * Parse a single SSE frame and dispatch the right callback. Returns
 * "done" if this frame was the terminal `event: done` frame so the
 * caller can stop reading.
 */
function handleFrame(rawFrame: string, callbacks: AskStreamCallbacks): "done" | "more" {
  const frame = rawFrame.trim();
  if (frame.length === 0) return "more";

  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // SSE comment / keep-alive.
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  const dataStr = dataLines.join("\n");

  if (event === "done") return "done";
  if (dataStr.length === 0) return "more";

  let payload: unknown;
  try {
    payload = JSON.parse(dataStr);
  } catch {
    // A malformed payload is non-fatal: skip the frame so a single bad
    // chunk doesn't tear down the whole stream.
    return "more";
  }

  if (event === "citations") {
    if (Array.isArray(payload)) {
      callbacks.onCitations(payload as AskCitation[]);
    }
    return "more";
  }

  // Default `message` event — token chunk. Accept either {text: "..."}
  // or a bare string for forward-compat with raw token streams.
  if (typeof payload === "string") {
    callbacks.onDelta(payload);
  } else if (payload && typeof payload === "object" && "text" in payload) {
    const text = (payload as { text?: unknown }).text;
    if (typeof text === "string") callbacks.onDelta(text);
  }
  return "more";
}

function readLoginUrlFromMeta(): string | null {
  if (typeof document === "undefined") return null;
  const meta = document.querySelector('meta[name="loomwiki-access-login-url"]');
  if (!meta) return null;
  const url = meta.getAttribute("content");
  return url && url.length > 0 ? url : null;
}
