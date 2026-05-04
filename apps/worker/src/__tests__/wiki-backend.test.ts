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
  isWriteFilePathAllowed,
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

  it("writeFile materializes a /rooms/** path and computes the sha", async () => {
    const path = "/rooms/general/log/2026-05-03.md";
    const content = "frontmatter\n---\n## 14:32 alice\n\nhi\n";
    const result = await backend.writeFile(path, content);
    expect(result.sha).toMatch(/^[0-9a-f]{64}$/);
    const round = await backend.read(path);
    expect(round?.raw).toBe(content);
    expect(round?.sha).toBe(result.sha);
  });

  it("writeFile produces byte-identical output on a re-write of the same content", async () => {
    const path = "/rooms/general/log/2026-05-03.md";
    const content = "stable content\n";
    const a = await backend.writeFile(path, content);
    const b = await backend.writeFile(path, content);
    expect(a.sha).toBe(b.sha);
    expect((await backend.read(path))?.raw).toBe(content);
  });

  it("writeFile rejects a path outside the /wiki|/rooms allowlist", async () => {
    await expect(backend.writeFile("/AGENTS.md", "x")).rejects.toThrow(/allowlist|outside/i);
    await expect(backend.writeFile("/etc/passwd.md", "x")).rejects.toThrow();
    await expect(backend.writeFile("/wiki/../escape.md", "x")).rejects.toThrow();
    await expect(backend.writeFile("/rooms//double.md", "x")).rejects.toThrow();
  });

  it("listPaths excludes /rooms/** chat-log entries (regression: wiki-tree leak)", async () => {
    // M5 stores chat logs at `/rooms/<slug>/log/<date>.md` via
    // writeFile; the KV layer shares a prefix with /wiki/** entries.
    // listPaths must filter so the wiki tree only contains wiki pages.
    await backend.write({ path: "/wiki/concepts/dmarc.md", raw: "x", sha: "1" });
    await backend.writeFile("/rooms/general/log/2026-05-03.md", "log content\n");
    const paths = await backend.listPaths();
    expect(paths).toEqual(["/wiki/concepts/dmarc.md"]);
    // Sanity: the chat log is still readable directly.
    expect((await backend.read("/rooms/general/log/2026-05-03.md"))?.raw).toBe("log content\n");
  });
});

describe("isWriteFilePathAllowed", () => {
  it("accepts /wiki/** and /rooms/** markdown paths", () => {
    expect(isWriteFilePathAllowed("/wiki/_index.md")).toBe(true);
    expect(isWriteFilePathAllowed("/wiki/concepts/dmarc.md")).toBe(true);
    expect(isWriteFilePathAllowed("/rooms/general/log/2026-05-03.md")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isWriteFilePathAllowed("/AGENTS.md")).toBe(false);
    expect(isWriteFilePathAllowed("/wiki/Concepts.md")).toBe(false); // uppercase
    expect(isWriteFilePathAllowed("/rooms/general/log/2026-05-03")).toBe(false); // no .md
    expect(isWriteFilePathAllowed("/rooms/../escape.md")).toBe(false);
    expect(isWriteFilePathAllowed("/wiki//double.md")).toBe(false);
    expect(isWriteFilePathAllowed("")).toBe(false);
  });
});
