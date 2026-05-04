// SPDX-License-Identifier: Apache-2.0

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { embed } from "../lib/embeddings.js";

interface RunCall {
  model: string;
  body: unknown;
}

function fakeAi(handler: (texts: string[]) => number[][]): {
  calls: RunCall[];
  binding: Env["AI"];
} {
  const calls: RunCall[] = [];
  return {
    calls,
    binding: {
      async run(model: string, body: unknown) {
        const texts = (body as { text: string[] }).text;
        calls.push({ model, body });
        return { data: handler(texts), shape: [texts.length, 768] };
      },
    },
  };
}

describe("embed", () => {
  it("returns one vector per input in stable order", async () => {
    const ai = fakeAi((texts) => texts.map((_, i) => [i, i + 1, i + 2]));
    const e = { ...env, AI: ai.binding, AI_GATEWAY_ID: "" } as Env;

    const result = await embed({ env: e, texts: ["a", "b", "c"] });
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual([0, 1, 2]);
    expect(result[2]).toEqual([2, 3, 4]);
    expect(ai.calls).toHaveLength(1);
  });

  it("returns [] for empty input without calling the model", async () => {
    const ai = fakeAi(() => {
      throw new Error("should not be called");
    });
    const e = { ...env, AI: ai.binding, AI_GATEWAY_ID: "" } as Env;
    const result = await embed({ env: e, texts: [] });
    expect(result).toEqual([]);
    expect(ai.calls).toHaveLength(0);
  });

  it("batches inputs in groups of 32", async () => {
    const ai = fakeAi((texts) => texts.map(() => [0]));
    const e = { ...env, AI: ai.binding, AI_GATEWAY_ID: "" } as Env;

    const inputs = Array.from({ length: 70 }, (_, i) => `t${i}`);
    const result = await embed({ env: e, texts: inputs });
    expect(result).toHaveLength(70);
    expect(ai.calls).toHaveLength(3); // ceil(70/32) = 3
    expect((ai.calls[0]?.body as { text: string[] }).text).toHaveLength(32);
    expect((ai.calls[1]?.body as { text: string[] }).text).toHaveLength(32);
    expect((ai.calls[2]?.body as { text: string[] }).text).toHaveLength(6);
  });
});
