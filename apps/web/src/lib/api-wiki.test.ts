// SPDX-License-Identifier: Apache-2.0

// Pins the wiki API helpers' contract: 409 surfaces as a typed
// WikiConflictError carrying the merge payload; happy-path GET/PUT
// shapes match the worker's wire format.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WikiConflictError, fetchWikiPage, fetchWikiTree, saveWikiPage } from "./api-wiki";
import type { WikiConflictDetails, WikiPagePayload } from "./types";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => response);
  vi.stubGlobal("fetch", f);
  return f;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const FRONTMATTER = {
  title: "DMARC",
  kind: "concept" as const,
  created: "2026-05-04",
  last_updated: "2026-05-04",
  status: "draft" as const,
};

describe("fetchWikiTree", () => {
  it("returns the unwrapped paths array", async () => {
    mockFetch(
      jsonResponse(200, {
        ok: true,
        data: { paths: ["/wiki/_index.md", "/wiki/concepts/dmarc.md"] },
      }),
    );
    const out = await fetchWikiTree();
    expect(out.paths).toEqual(["/wiki/_index.md", "/wiki/concepts/dmarc.md"]);
  });
});

describe("fetchWikiPage", () => {
  it("unwraps `.page` from the response", async () => {
    const page: WikiPagePayload = {
      path: "/wiki/concepts/dmarc.md",
      frontmatter: FRONTMATTER,
      body: "**DMARC**",
      sha: "abc",
    };
    mockFetch(jsonResponse(200, { ok: true, data: { page } }));
    const out = await fetchWikiPage("/wiki/concepts/dmarc.md");
    expect(out.path).toBe("/wiki/concepts/dmarc.md");
  });
});

describe("saveWikiPage", () => {
  it("returns the updated page on 200", async () => {
    const page: WikiPagePayload = {
      path: "/wiki/concepts/dmarc.md",
      frontmatter: FRONTMATTER,
      body: "second",
      sha: "newsha",
    };
    mockFetch(jsonResponse(200, { ok: true, data: { page } }));
    const out = await saveWikiPage("/wiki/concepts/dmarc.md", {
      frontmatter: FRONTMATTER,
      body: "second",
      before_sha: "oldsha",
    });
    expect(out.sha).toBe("newsha");
  });

  it("throws WikiConflictError on 409 with the merge payload", async () => {
    const details: WikiConflictDetails = {
      path: "/wiki/concepts/dmarc.md",
      current_sha: "newer",
      current_raw: "---\ntitle: X\n---\n\nincoming",
      base_sha: "newer",
      base_raw: "---\ntitle: X\n---\n\nincoming",
      attempted_frontmatter: FRONTMATTER,
      attempted_body: "local",
    };
    mockFetch(
      jsonResponse(409, {
        ok: false,
        error: { code: "CONFLICT", message: "conflict", details },
      }),
    );
    try {
      await saveWikiPage("/wiki/concepts/dmarc.md", {
        frontmatter: FRONTMATTER,
        body: "local",
        before_sha: "oldsha",
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WikiConflictError);
      expect((err as WikiConflictError).details.current_sha).toBe("newer");
    }
  });
});
