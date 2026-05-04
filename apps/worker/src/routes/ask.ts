// SPDX-License-Identifier: Apache-2.0

// RAG ask endpoint. Streams text deltas as SSE, then a single
// `citations` event with WikiSearchResult[]-shaped payload, then
// `done`. The cost guard charges per call (not per token) BEFORE the
// LLM runs — a mid-stream client disconnect does NOT roll the counter
// back, because the upstream provider already billed.
//
// POST /api/ask
//   body: { question: string }   (AskRequestSchema)
//   200:  text/event-stream
//         data: {"delta":"..."}  (repeated)
//         event: citations\ndata: [...]
//         event: done\ndata: {}
//   400:  VALIDATION_FAILED
//   429:  RATE_LIMITED { details: { limit, used, scope, reset_at } }
//
// If askWithRag throws synchronously the central error middleware
// converts to JSON. Errors that surface DURING iteration cannot be
// converted (headers already flushed); we log + abort so the SSE
// client sees a truncated stream.

import { AskRequestSchema } from "@loomwiki/schema";
import { ErrorCodes, LoomwikiError } from "@loomwiki/shared";
import { Hono } from "hono";
import { assertWithinLimit } from "../lib/cost-guard.js";
import { askWithRag } from "../lib/rag.js";
import type { AuthEnv } from "../middleware/auth.js";

const SSE_HEADERS: HeadersInit = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  // Disables proxy buffering on nginx-fronted deployments. Harmless
  // on Cloudflare's edge, load-bearing for self-hosted reverse-proxy
  // setups in the M9 ops guide.
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
};

function sseLine(event: string | null, data: unknown): string {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  return event === null ? payload : `event: ${event}\n${payload}`;
}

export const askRoute = new Hono<AuthEnv>().post("/ask", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = AskRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new LoomwikiError(ErrorCodes.VALIDATION_FAILED, "Invalid ask request", {
      status: 400,
      details: parsed.error.issues,
    });
  }

  // Charge BEFORE the LLM call. See cost-guard.ts module note:
  // disconnect mid-stream does not refund; the provider already billed.
  await assertWithinLimit({
    env: c.env,
    workspaceId: c.var.workspace.id,
    userId: c.var.user.id,
    kind: "ask",
  });

  const result = await askWithRag({
    env: c.env,
    question: parsed.data.question,
    workspaceId: c.var.workspace.id,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const delta of result.stream) {
          // Skip empty chunks — they would emit `data: {"delta":""}` which is
          // wire-noise the client has to filter anyway.
          if (delta.length === 0) continue;
          controller.enqueue(encoder.encode(sseLine(null, { delta })));
        }
        controller.enqueue(encoder.encode(sseLine("citations", result.citations)));
        controller.enqueue(encoder.encode(sseLine("done", {})));
        controller.close();
      } catch (err) {
        // Headers are already flushed; the only honest signal we can
        // give is to close abruptly. Log so operators can correlate
        // the truncation with worker tail logs.
        console.error("[loomwiki] ask stream aborted", err);
        try {
          controller.error(err);
        } catch {
          // controller may already be closed — swallow.
        }
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
});
