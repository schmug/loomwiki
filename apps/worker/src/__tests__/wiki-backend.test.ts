// SPDX-License-Identifier: Apache-2.0

// Tests for the wiki-backend abstraction. Both backends must satisfy
// the same contract; we run a parameterized suite to keep them in step.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryWikiBackend,
  KvWikiBackend,
  type WikiBackend,
  type WikiPageRecord,
} from "../lib/wiki-backend.js";

async function clearKv(): Promise<void> {
  const list = await env.WIKI_KV.list();
  for (const k of list.keys) {
    await env.WIKI_KV.delete(k.name);
  }
}

const cases: { name: string; make: () => WikiBackend; cleanup: () => Promise<void> }[] = [
  {
    name: "InMemoryWikiBackend",
    make: () => new InMemoryWikiBackend(),
    cleanup: async () => {
      // each `make()` produces a fresh store
    },
  },
  {
    name: "KvWikiBackend",
    make: () => new KvWikiBackend(env.WIKI_KV),
    cleanup: clearKv,
  },
];

describe.each(cases)("$name conforms to WikiBackend contract", ({ make, cleanup }) => {
  let backend: WikiBackend;
  beforeEach(async () => {
    await cleanup();
    backend = make();
  });
  afterEach(async () => {
    await cleanup();
  });

  it("returns null on read of missing path", async () => {
    expect(await backend.read("/wiki/missing.md")).toBeNull();
  });

  it("round-trips a write and a read", async () => {
    const record: WikiPageRecord = {
      path: "/wiki/concepts/dmarc.md",
      raw: "---\ntitle: DMARC\n---\n\nbody\n",
      sha: "deadbeef",
    };
    await backend.write(record);
    const read = await backend.read(record.path);
    expect(read).not.toBeNull();
    expect(read?.path).toBe(record.path);
    expect(read?.raw).toBe(record.raw);
    expect(read?.sha).toBe(record.sha);
  });

  it("delete is idempotent on missing paths", async () => {
    await expect(backend.delete("/wiki/missing.md")).resolves.toBeUndefined();
  });

  it("delete removes the page", async () => {
    await backend.write({ path: "/wiki/x.md", raw: "x", sha: "1" });
    await backend.delete("/wiki/x.md");
    expect(await backend.read("/wiki/x.md")).toBeNull();
  });

  it("listPaths returns sorted page paths", async () => {
    await backend.write({ path: "/wiki/b.md", raw: "b", sha: "1" });
    await backend.write({ path: "/wiki/a.md", raw: "a", sha: "1" });
    await backend.write({ path: "/wiki/concepts/c.md", raw: "c", sha: "1" });
    expect(await backend.listPaths()).toEqual(["/wiki/a.md", "/wiki/b.md", "/wiki/concepts/c.md"]);
  });
});
