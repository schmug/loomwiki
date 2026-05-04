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
   * List all page paths the backend knows about, sorted ascending.
   * Used by the wiki-tree route. POC scale, no pagination.
   */
  listPaths(): Promise<string[]>;
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
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page: { keys: { name: string }[]; list_complete: boolean; cursor?: string } =
        await this.kv.list({ prefix: KV_PREFIX, cursor });
      for (const k of page.keys) {
        out.push(k.name.slice(KV_PREFIX.length));
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined);
    out.sort();
    return out;
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
    return [...this.store.keys()].sort();
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
