// SPDX-License-Identifier: Apache-2.0

// Wire-shape tests for the M7 inbox API helpers. Pinning the request
// URLs + bodies prevents drift from the worker route registration.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countProposals,
  getProposal,
  getRunStatus,
  listProposals,
  mergeProposal,
  rejectProposal,
  triggerIngest,
} from "./api-inbox";

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

describe("api-inbox", () => {
  it("listProposals defaults to status=pending", async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true, data: { proposals: [] } }));
    const out = await listProposals();
    expect(out.proposals).toEqual([]);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/proposals?status=pending");
  });

  it("countProposals hits the count=true variant", async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, { ok: true, data: { status: "pending", count: 7 } }),
    );
    const out = await countProposals("pending");
    expect(out.count).toBe(7);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/proposals?count=true&status=pending");
  });

  it("getProposal encodes the id", async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true, data: { proposal: { id: "abc" } } }));
    await getProposal("abc/def");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/proposals/abc%2Fdef");
  });

  it("mergeProposal POSTs with before_sha", async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, {
        ok: true,
        data: { merged: true, page_path: "/wiki/x.md", sha: "abc" },
      }),
    );
    const out = await mergeProposal("p1", "deadbeef");
    expect(out.merged).toBe(true);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ before_sha: "deadbeef" }));
  });

  it("mergeProposal omits before_sha when not provided", async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, {
        ok: true,
        data: { merged: true, page_path: "/wiki/x.md", sha: "abc" },
      }),
    );
    await mergeProposal("p1");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({}));
  });

  it("rejectProposal POSTs", async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, { ok: true, data: { rejected: true, proposal_id: "p1" } }),
    );
    await rejectProposal("p1");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/proposals/p1/reject");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
  });

  it("triggerIngest hits POST /api/rooms/:rid/ingest", async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, {
        ok: true,
        data: { run_id: "01970000-0000-7000-8000-000000000001", status: "running" },
      }),
    );
    const out = await triggerIngest("room-uuid");
    expect(out.status).toBe("running");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/rooms/room-uuid/ingest");
  });

  it("getRunStatus shape", async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, {
        ok: true,
        data: { run: { id: "r1", status: "succeeded" } },
      }),
    );
    const out = await getRunStatus("r1");
    expect(out.run.status).toBe("succeeded");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/runs/r1");
  });
});
