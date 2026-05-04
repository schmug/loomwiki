// SPDX-License-Identifier: Apache-2.0

// Wiki content storage abstraction. Backend interface plus two
// implementations:
//   - KvWikiBackend: production v0.0.1 backend, stores pages in
//     env.WIKI_KV. Durable, supports listing, supports the SHA we use
//     as the optimistic-lock token.
//   - InMemoryWikiBackend: test fake. Identical surface; tests can
//     mutate state directly.
//
// Why an abstraction at all? M4.5 will replace the KV backend with a
// git-backed implementation that talks to Cloudflare Artifacts via the
// repo's HTTPS remote. Keeping the route layer behind this interface
// means M4.5 is a one-file swap, not a rewrite. ADR-0003 is the long
// version of why this lives at this seam.

import type { KVNamespace } from "@cloudflare/workers-types";

const KV_PREFIX = "wiki:";

// listPaths() filters down to entries that begin with `/wiki/`. M5
// added writeFile for non-wiki paths (e.g. `/rooms/<slug>/log/...`)
// stored under the same KV prefix; without the filter, those paths
// would leak into `GET /api/wiki-tree` and the wiki UI would try to
// render them as wiki pages and hit a 400 from validateWikiPath.
const WIKI_PATH_PREFIX = "/wiki/";

// Defense-in-depth path filter for writeFile. The wiki API uses
// validateWikiPath (anchored to /wiki/**); the M5 chat-log module uses
// its own tighter regex (anchored to /rooms/<slug>/log/<date>.md). The
// backend accepts the union of both prefixes — anything else is a bug
// in the caller and the backend refuses to materialize it. This guards
// the eventual M4.5 git backend from being asked to write `/AGENTS.md`,
// `/etc/passwd`, or a path with `..` if a future caller forgets to
// validate first.
const WRITE_FILE_PATH_REGEX = /^\/(wiki|rooms)\/[a-z0-9_][a-z0-9_/-]*\.md$/;

export interface WikiPageRecord {
  /** Path under the vault, e.g. `/wiki/concepts/dmarc.md`. */
  path: string;
  /** Raw page content (frontmatter + body). */
  raw: string;
  /** Optimistic-locking token (SHA-256 of `raw` at write time). */
  sha: string;
}

export interface WikiBackend {
  /**
   * Read a page. Returns `null` if the page does not exist.
   * Distinguishes from a thrown error (which means the backend itself
   * misbehaved, e.g. KV unavailable).
   */
  read(path: string): Promise<WikiPageRecord | null>;

  /**
   * Write a page. The caller is responsible for pre-checking
   * `before_sha` against the current record; this method does NOT do
   * its own conflict detection (the route layer owns that).
   */
  write(record: WikiPageRecord): Promise<void>;

  /**
   * Delete a page. Idempotent — deleting a missing page is not an
   * error.
   */
  delete(path: string): Promise<void>;

  /**
   * List page paths under `/wiki/`, sorted ascending. Used by the
   * wiki-tree route. POC scale, no pagination. Implementations MUST
   * exclude non-wiki entries (e.g. M5's `/rooms/**` chat logs that
   * share the underlying KV prefix) so the tree only contains pages
   * the wiki API can serve.
   */
  listPaths(): Promise<string[]>;

  /**
   * Write a non-wiki vault file (M5 chat logs, future: top-level
   * /AGENTS.md). Computes the SHA from `content` itself and stores
   * both. Rejects any path outside the {/wiki, /rooms} union with a
   * thrown Error — callers MUST pre-validate with their own
   * tighter validator (e.g. `validateChatLogPath`); this method is
   * only a defense-in-depth backstop, not the primary gate.
   */
  writeFile(path: string, content: string): Promise<{ sha: string }>;
}

export function isWriteFilePathAllowed(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 256) return false;
  if (path.includes("..") || path.includes("//")) return false;
  return WRITE_FILE_PATH_REGEX.test(path);
}

function assertWriteFilePathAllowed(path: string): void {
  if (!isWriteFilePathAllowed(path)) {
    throw new Error(`writeFile rejected path outside /wiki|/rooms allowlist: ${path}`);
  }
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// ---------- KV-backed implementation ----------

export class KvWikiBackend implements WikiBackend {
  constructor(private readonly kv: KVNamespace) {}

  async read(path: string): Promise<WikiPageRecord | null> {
    const key = KV_PREFIX + path;
    const value = await this.kv.getWithMetadata<{ sha: string }>(key, "text");
    if (value.value === null) return null;
    const sha = value.metadata?.sha;
    if (typeof sha !== "string" || sha.length === 0) {
      // Migration / ingest from a malformed write. Caller will handle
      // the inconsistency by recomputing or rejecting; we surface the
      // raw content with an empty sha so the route layer notices.
      return { path, raw: value.value, sha: "" };
    }
    return { path, raw: value.value, sha };
  }

  async write(record: WikiPageRecord): Promise<void> {
    const key = KV_PREFIX + record.path;
    await this.kv.put(key, record.raw, { metadata: { sha: record.sha } });
  }

  async delete(path: string): Promise<void> {
    await this.kv.delete(KV_PREFIX + path);
  }

  async listPaths(): Promise<string[]> {
    // KV list is paginated under the hood. Loop until cursor is gone.
    // We list under the broader `wiki:` prefix (which also stores
    // M5's `/rooms/**` chat logs) and filter to `/wiki/**` so the
    // wiki-tree route only ever sees wiki pages.
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page: { keys: { name: string }[]; list_complete: boolean; cursor?: string } =
        await this.kv.list({ prefix: KV_PREFIX, cursor });
      for (const k of page.keys) {
        const path = k.name.slice(KV_PREFIX.length);
        if (path.startsWith(WIKI_PATH_PREFIX)) out.push(path);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined);
    out.sort();
    return out;
  }

  async writeFile(path: string, content: string): Promise<{ sha: string }> {
    assertWriteFilePathAllowed(path);
    const sha = await sha256Hex(content);
    await this.kv.put(KV_PREFIX + path, content, { metadata: { sha } });
    return { sha };
  }
}

// ---------- In-memory implementation (tests + fake fixture) ----------

export class InMemoryWikiBackend implements WikiBackend {
  private readonly store = new Map<string, WikiPageRecord>();

  async read(path: string): Promise<WikiPageRecord | null> {
    return this.store.get(path) ?? null;
  }

  async write(record: WikiPageRecord): Promise<void> {
    this.store.set(record.path, { ...record });
  }

  async delete(path: string): Promise<void> {
    this.store.delete(path);
  }

  async listPaths(): Promise<string[]> {
    return [...this.store.keys()].filter((p) => p.startsWith(WIKI_PATH_PREFIX)).sort();
  }

  async writeFile(path: string, content: string): Promise<{ sha: string }> {
    assertWriteFilePathAllowed(path);
    const sha = await sha256Hex(content);
    this.store.set(path, { path, raw: content, sha });
    return { sha };
  }

  /** Test helper: total page count. */
  size(): number {
    return this.store.size;
  }

  /** Test helper: clear all entries. */
  clear(): void {
    this.store.clear();
  }
}
