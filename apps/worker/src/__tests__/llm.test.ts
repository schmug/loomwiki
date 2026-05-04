// SPDX-License-Identifier: Apache-2.0

// M6 LLM-abstraction tests. Verifies:
//   - Default + override model selection
//   - Direct AI binding path
//   - AI Gateway path (URL composition + auth header)
//   - Stream chunking for SSE-style upstreams
//   - BYOK override hook

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";
import { chat, chatStream } from "../lib/llm.js";

interface RunCall {
  model: string;
  body: unknown;
}

function fakeAi(
  handler: (model: string, body: unknown) => Promise<unknown> | unknown,
): { calls: RunCall[]; binding: Env["AI"] } {
  const calls: RunCall[] = [];
  return {
    calls,
    binding: {
      async run(model: string, body: unknown) {
        calls.push({ model, body });
        return await handler(model, body);
      },
    },
  };
}

function envOverride(overrides: Partial<Env>): Env {
  return { ...env, ...overrides } as Env;
}

describe("chat (non-streaming)", () => {
  it("uses DEFAULT_LLM_MODEL when no model override is provided", async () => {
    const ai = fakeAi(async () => ({ response: "hello" }));
    const e = envOverride({ AI: ai.binding, AI_GATEWAY_ID: "" });

    const result = await chat({ env: e, prompt: "hi" });
    expect(result.text).toBe("hello");
    expect(result.model).toBe(env.DEFAULT_LLM_MODEL);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]?.model).toBe(env.DEFAULT_LLM_MODEL);
  });

  it("respects the model override", async () => {
    const ai = fakeAi(async () => ({ response: "x" }));
    const e = envOverride({ AI: ai.binding, AI_GATEWAY_ID: "" });

    await chat({ env: e, prompt: "hi", model: "@cf/meta/llama-3.2-3b-instruct" });
    expect(ai.calls[0]?.model).toBe("@cf/meta/llama-3.2-3b-instruct");
  });

  it("composes the AI Gateway URL when AI_GATEWAY_ID + CF_ACCOUNT_ID are set", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { response: "via gateway" } }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    try {
      const ai = fakeAi(async () => {
        throw new Error("should not be called when gateway is configured");
      });
      const e = envOverride({
        AI: ai.binding,
        AI_GATEWAY_ID: "loomwiki-gw",
        CF_ACCOUNT_ID: "abcdef0123",
      });

      const result = await chat({ env: e, prompt: "hi" });
      expect(result.text).toBe("via gateway");
      expect(fetchSpy).toHaveBeenCalledOnce();
      const url = fetchSpy.mock.calls[0]?.[0] as string;
      expect(url).toBe(
        `https://gateway.ai.cloudflare.com/v1/abcdef0123/loomwiki-gw/workers-ai/run/${env.DEFAULT_LLM_MODEL}`,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("attaches Bearer token when AI_GATEWAY_TOKEN is set", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { response: "ok" } }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const ai = fakeAi(async () => ({ response: "x" }));
      const e = envOverride({
        AI: ai.binding,
        AI_GATEWAY_ID: "g",
        CF_ACCOUNT_ID: "a",
        AI_GATEWAY_TOKEN: "secret-token",
      });
      await chat({ env: e, prompt: "hi" });
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer secret-token");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("invokes BYOK lookup when workspaceId is provided (M6 returns null but path runs)", async () => {
    const ai = fakeAi(async () => ({ response: "ok" }));
    const e = envOverride({ AI: ai.binding, AI_GATEWAY_ID: "" });
    // No throws — exercise the path. The byokOverride argument lets
    // us short-circuit the D1 query that getBYOK would do.
    await chat({ env: e, prompt: "hi", workspaceId: "ws", byokOverride: null });
    expect(ai.calls).toHaveLength(1);
  });
});

describe("chatStream", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards SSE delta chunks and emits a terminating done", async () => {
    // Build a ReadableStream that emits two SSE events then closes.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"response":"Hello "}\n\n'));
        controller.enqueue(encoder.encode('data: {"response":"world"}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const ai = fakeAi(async () => body);
    const e = envOverride({ AI: ai.binding, AI_GATEWAY_ID: "" });

    const out: string[] = [];
    let saw_done = false;
    for await (const chunk of chatStream({ env: e, prompt: "hi" })) {
      if (chunk.done) saw_done = true;
      else out.push(chunk.delta);
    }
    expect(out.join("")).toBe("Hello world");
    expect(saw_done).toBe(true);
  });

  it("yields a single chunk + done when the model returns a non-stream response", async () => {
    // Some Workers AI models ignore stream:true. The wrapper must
    // still surface a usable shape.
    const ai = fakeAi(async () => ({ response: "non-streaming text" }));
    const e = envOverride({ AI: ai.binding, AI_GATEWAY_ID: "" });

    const chunks: string[] = [];
    for await (const c of chatStream({ env: e, prompt: "hi" })) {
      if (!c.done) chunks.push(c.delta);
    }
    expect(chunks).toEqual(["non-streaming text"]);
  });
});
