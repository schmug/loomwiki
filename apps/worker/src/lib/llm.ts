// SPDX-License-Identifier: Apache-2.0

// Single LLM call site. Every other module — rag.ts, the future M7
// IngestAgent, the future M8 admin tools — calls `chat()` /
// `chatStream()` and never touches `env.AI` directly. This means
// swapping the default model, adding a new BYOK provider, or routing
// through AI Gateway is a one-file change here.
//
// Routing:
//   - When env.AI_GATEWAY_ID is set → call the AI Gateway endpoint
//     `https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY}/workers-ai/run/{model}`.
//     This gives us caching, observability, and a hard daily cap on
//     the gateway side.
//   - When env.AI_GATEWAY_ID is empty → call `env.AI.run(model, ...)`
//     directly. Loses the global cap layer; used in local dev with no
//     gateway provisioned and as a fallback if the gateway is down.
//
// BYOK is a placeholder in M6 — `byok.ts` always returns null. The
// call site below already invokes the lookup so M8's plug-in point
// is "decrypt instead of returning null", not "wire up the call".

import type { Env } from "../env.js";
import { getBYOK, resolveProviderForModel } from "./byok.js";

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatResult {
  text: string;
  model: string;
  usage: ChatUsage;
}

export interface ChatOptions {
  env: Env;
  /** User-facing prompt content. */
  prompt: string;
  /** Optional system message; defaults to a neutral assistant prompt. */
  system?: string;
  /** Override the default model. Use the Workers AI catalog id (`@cf/...`). */
  model?: string;
  /** Workspace id; needed for the BYOK lookup. */
  workspaceId?: string;
  /** Override the BYOK lookup result (testing seam). */
  byokOverride?: string | null;
  /** Sampling. Optional; the worker leaves model defaults intact when omitted. */
  temperature?: number;
  /** Token budget. Optional; same. */
  maxTokens?: number;
  /**
   * Output format hint. M7 uses "json_object" for the ingest agent's
   * structured-output enforcement. Models that don't support the
   * directive ignore it silently — callers must still parse defensively
   * (the agent does this with retry-on-parse-fail).
   */
  responseFormat?: "text" | "json_object";
}

const DEFAULT_SYSTEM = "You are a helpful, concise assistant.";

let warnedDevModel = false;
function warnDevModelOnce(): void {
  if (warnedDevModel) return;
  warnedDevModel = true;
  const nodeEnv = typeof process !== "undefined" && process.env ? process.env.NODE_ENV : undefined;
  if (nodeEnv !== "production") {
    console.warn(
      "[loomwiki] llm.chat: BYOK miss — using Workers AI default. In dev this still spends free-tier neurons; consider configuring BYOK or LLM_DAILY_LIMIT_PER_USER caps for cost control.",
    );
  }
}

interface ResolvedRoute {
  /** AI Gateway URL when configured; null = use env.AI binding directly. */
  gatewayUrl: string | null;
  model: string;
  /** When BYOK is in play, the provider key route ("anthropic", etc.). M6 always Workers AI. */
  byokProvider: "workers_ai";
}

function resolveRoute(opts: ChatOptions): ResolvedRoute {
  const model = opts.model && opts.model.length > 0 ? opts.model : opts.env.DEFAULT_LLM_MODEL;
  const gw = opts.env.AI_GATEWAY_ID;
  const acct = opts.env.CF_ACCOUNT_ID;
  if (gw && gw.length > 0 && acct && acct.length > 0) {
    return {
      gatewayUrl: `https://gateway.ai.cloudflare.com/v1/${acct}/${gw}/workers-ai/run/${model}`,
      model,
      byokProvider: "workers_ai",
    };
  }
  return { gatewayUrl: null, model, byokProvider: "workers_ai" };
}

// Guard against the env.AI binding being absent (e.g. local-dev configs
// that omit it because Wrangler refuses to start `wrangler dev` for
// remote-only bindings without a login). Without this, downstream code
// fails with the inscrutable `Cannot read properties of undefined
// (reading 'run')` mid-stream.
function requireAiBinding(opts: ChatOptions): void {
  if (!opts.env.AI || typeof opts.env.AI.run !== "function") {
    throw new Error(
      "llm: env.AI binding is not available. Configure AI_GATEWAY_ID + CF_ACCOUNT_ID, or run with `wrangler dev --remote --config wrangler.jsonc`. (See DEPLOY.md §AI Search + /ask + cost guards.)",
    );
  }
}

interface WorkersAiRunBody {
  messages: { role: "system" | "user"; content: string }[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /**
   * Workers AI structured-output directive (M7). Honored by the
   * llama-3.3-70b-instruct-fp8-fast catalog model; ignored by smaller
   * fallback models. The ingest agent treats parse failures as
   * "retry up to 2x" so a non-honoring model still works.
   */
  response_format?: { type: "json_object" };
}

function buildBody(opts: ChatOptions, stream: boolean): WorkersAiRunBody {
  const body: WorkersAiRunBody = {
    messages: [
      { role: "system", content: opts.system ?? DEFAULT_SYSTEM },
      { role: "user", content: opts.prompt },
    ],
    stream,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.responseFormat === "json_object") {
    body.response_format = { type: "json_object" };
  }
  return body;
}

async function maybeBYOK(opts: ChatOptions): Promise<string | null> {
  if (opts.byokOverride !== undefined) return opts.byokOverride;
  if (!opts.workspaceId) return null;
  // M8: route by model. Workers AI ids (`@cf/...`) skip the BYOK
  // lookup entirely (resolveProviderForModel returns null). The
  // `byok:<provider>` sentinel models — set as the workspace default
  // via /settings/workspace — and canonical SDK shapes (claude-*, gpt-*,
  // gemini-*) resolve to the matching provider. v0.0.1's chat() call
  // sites still default to Workers AI when BYOK is null; M6 wired the
  // call sites correctly, so only the provider resolution moved.
  const model = opts.model && opts.model.length > 0 ? opts.model : opts.env.DEFAULT_LLM_MODEL;
  const provider = resolveProviderForModel(model);
  if (provider === null) return null;
  return getBYOK(opts.env, opts.workspaceId, provider);
}

/** Non-streaming chat completion. Returns the full text. */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const route = resolveRoute(opts);
  if (route.gatewayUrl === null) requireAiBinding(opts);
  const byok = await maybeBYOK(opts);
  if (byok === null) warnDevModelOnce();

  const body = buildBody(opts, false);

  if (route.gatewayUrl !== null) {
    const res = await fetch(route.gatewayUrl, {
      method: "POST",
      headers: gatewayHeaders(opts.env),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`llm.chat: gateway ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const json = (await res.json()) as { result?: { response?: string }; usage?: ChatUsage };
    return {
      text: json.result?.response ?? "",
      model: route.model,
      usage: json.usage ?? {},
    };
  }

  const result = (await opts.env.AI.run(route.model, body)) as {
    response?: string;
    usage?: ChatUsage;
  };
  return {
    text: result.response ?? "",
    model: route.model,
    usage: result.usage ?? {},
  };
}

export interface ChatStreamChunk {
  delta: string;
  done: boolean;
  model: string;
}

/**
 * Streaming chat completion. Yields one chunk per server-side update.
 * The final chunk has `done: true` and `delta: ""`.
 *
 * Implementation reads from the underlying SSE-style stream and
 * forwards parsed `delta` strings. Workers AI emits `data: {...}\n\n`
 * lines containing `{ response: "<token>" }`; non-JSON lines (e.g.
 * `data: [DONE]`) terminate the stream.
 */
export async function* chatStream(opts: ChatOptions): AsyncIterable<ChatStreamChunk> {
  const route = resolveRoute(opts);
  if (route.gatewayUrl === null) requireAiBinding(opts);
  const byok = await maybeBYOK(opts);
  if (byok === null) warnDevModelOnce();

  const body = buildBody(opts, true);

  let stream: ReadableStream<Uint8Array> | null = null;
  if (route.gatewayUrl !== null) {
    const res = await fetch(route.gatewayUrl, {
      method: "POST",
      headers: gatewayHeaders(opts.env),
      body: JSON.stringify(body),
    });
    if (!res.ok || res.body === null) {
      throw new Error(`llm.chatStream: gateway ${res.status}`);
    }
    stream = res.body;
  } else {
    const result = (await opts.env.AI.run(route.model, body)) as
      | ReadableStream<Uint8Array>
      | { response?: string };
    if (result instanceof ReadableStream) {
      stream = result;
    } else {
      // Some Workers AI models ignore `stream: true` and return the
      // full response. Surface as a single chunk so callers don't
      // special-case.
      yield { delta: result.response ?? "", done: false, model: route.model };
      yield { delta: "", done: true, model: route.model };
      return;
    }
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Process complete SSE events (separated by blank lines).
      while (true) {
        const split = buffer.indexOf("\n\n");
        if (split === -1) break;
        const event = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const dataLine = event.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (payload === "[DONE]" || payload.length === 0) continue;
        try {
          const parsed = JSON.parse(payload) as { response?: string };
          if (typeof parsed.response === "string" && parsed.response.length > 0) {
            yield { delta: parsed.response, done: false, model: route.model };
          }
        } catch {
          // Non-JSON payload — drop. Workers AI occasionally emits
          // `data: ` keep-alive frames; ignoring them is correct.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { delta: "", done: true, model: route.model };
}

function gatewayHeaders(env: Env): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (env.AI_GATEWAY_TOKEN && env.AI_GATEWAY_TOKEN.length > 0) {
    h.Authorization = `Bearer ${env.AI_GATEWAY_TOKEN}`;
  }
  return h;
}
