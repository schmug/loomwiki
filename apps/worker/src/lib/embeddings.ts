// SPDX-License-Identifier: Apache-2.0

// Embedding generator. Wraps `env.AI.run('@cf/baai/bge-base-en-v1.5')`
// (or the Gateway equivalent) and batches inputs to keep request size
// inside Workers AI limits.
//
// Used by the M6 admin reindex path (when AI Search is unavailable and
// we want to compute query-side embeddings ourselves) and by the future
// M7 ingest agent for similarity-based proposal de-duplication.
//
// Batch size cap of 32 mirrors Workers AI's documented per-request
// input cap. Larger inputs split across multiple round trips, in
// order, results concatenated.

import type { Env } from "../env.js";

const BATCH_SIZE = 32;

export interface EmbedOptions {
  env: Env;
  texts: string[];
  /** Override the default embedding model (advanced). */
  model?: string;
}

/**
 * Embed an array of texts. Returns one vector per input in the same
 * order. Empty input array returns empty result.
 */
export async function embed(opts: EmbedOptions): Promise<number[][]> {
  if (opts.texts.length === 0) return [];
  const model = opts.model && opts.model.length > 0 ? opts.model : opts.env.EMBEDDING_MODEL;

  const out: number[][] = [];
  for (let i = 0; i < opts.texts.length; i += BATCH_SIZE) {
    const batch = opts.texts.slice(i, i + BATCH_SIZE);
    const vectors = await embedBatch(opts.env, model, batch);
    out.push(...vectors);
  }
  return out;
}

interface EmbeddingResponse {
  data?: number[][];
  shape?: number[];
}

async function embedBatch(env: Env, model: string, texts: string[]): Promise<number[][]> {
  const gw = env.AI_GATEWAY_ID;
  const acct = env.CF_ACCOUNT_ID;
  const useGateway = gw && gw.length > 0 && acct && acct.length > 0;

  if (useGateway) {
    const url = `https://gateway.ai.cloudflare.com/v1/${acct}/${gw}/workers-ai/run/${model}`;
    const res = await fetch(url, {
      method: "POST",
      headers: gatewayHeaders(env),
      body: JSON.stringify({ text: texts }),
    });
    if (!res.ok) {
      throw new Error(`embeddings: gateway ${res.status}`);
    }
    const json = (await res.json()) as { result?: EmbeddingResponse };
    return json.result?.data ?? [];
  }

  const result = (await env.AI.run(model, { text: texts })) as EmbeddingResponse;
  return result.data ?? [];
}

function gatewayHeaders(env: Env): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (env.AI_GATEWAY_TOKEN && env.AI_GATEWAY_TOKEN.length > 0) {
    h.Authorization = `Bearer ${env.AI_GATEWAY_TOKEN}`;
  }
  return h;
}
