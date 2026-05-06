// SPDX-License-Identifier: Apache-2.0

// Fake LLM for the ingest-agent tests. Returns scripted responses in
// FIFO order — set up an array of replies, each call shifts the head.
// Falls back to throwing when the script is exhausted so a test that
// triggers more LLM calls than expected fails loudly.

import type { IngestAgentResponse } from "@loomwiki/schema";
import type { LlmFn } from "../../agents/ingest-agent.js";

export interface FakeLlmCall {
  system: string;
  prompt: string;
}

export interface FakeLlmFixture {
  fn: LlmFn;
  calls: FakeLlmCall[];
}

/**
 * Build a fake LLM that returns the given text replies. Each entry
 * is consumed once. After exhaustion, further calls throw so the test
 * surfaces the unexpected extra invocation.
 */
export function fakeLlm(replies: string[]): FakeLlmFixture {
  const calls: FakeLlmCall[] = [];
  let i = 0;
  const fn: LlmFn = async ({ system, prompt }) => {
    calls.push({ system, prompt });
    if (i >= replies.length) {
      throw new Error(`fakeLlm: out of scripted replies (call #${i + 1})`);
    }
    const text = replies[i] ?? "";
    i++;
    return { text };
  };
  return { fn, calls };
}

/** Convenience: serialize an IngestAgentResponse to the on-wire JSON shape. */
export function jsonResponse(response: IngestAgentResponse): string {
  return JSON.stringify(response);
}
