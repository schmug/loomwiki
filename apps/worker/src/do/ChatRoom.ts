// SPDX-License-Identifier: Apache-2.0

// Stub ChatRoom Durable Object. Real implementation lands in M2 (SPEC §9).
// Declared here so the binding in wrangler.jsonc is satisfied in M0 — the spec
// (CLAUDE.md) requires all bindings be declared up front to prevent schema drift.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

export class ChatRoom extends DurableObject<Env> {
  override fetch(_request: Request): Response {
    return new Response(
      JSON.stringify({
        ok: false,
        error: { code: "not_implemented", message: "ChatRoom DO arrives in M2" },
      }),
      { status: 501, headers: { "content-type": "application/json" } },
    );
  }
}
