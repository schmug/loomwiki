// SPDX-License-Identifier: Apache-2.0

// Wire-shape tests for the M8 settings API helpers. Pinning request
// URLs + bodies prevents drift from the worker route registration.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BYOKKeyMetadata,
  type WorkspaceSettings,
  deleteBYOK,
  getAgentsMd,
  getWorkspaceSettings,
  listBYOK,
  setAgentsMd,
  setBYOK,
  setWorkspaceSettings,
} from "./api-settings";

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

const META: BYOKKeyMetadata = {
  workspace_id: "ws-1",
  provider: "anthropic",
  has_key: true,
  created_at: 1_700_000_000,
  created_by: "u-1",
  last_used_at: null,
};

const SETTINGS: WorkspaceSettings = {
  workspace_id: "ws-1",
  timezone: "UTC",
  default_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  updated_at: 1_700_000_000,
  updated_by: "u-1",
};

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api-settings", () => {
  it("listBYOK GETs /api/settings/byok and unwraps keys", async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true, data: { keys: [META] } }));
    const out = await listBYOK();
    expect(out).toEqual([META]);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/settings/byok");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("GET");
  });

  it("setBYOK PUTs the key payload to the provider path", async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true, data: META }));
    const out = await setBYOK("anthropic", "sk-test-123");
    expect(out).toEqual(META);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/settings/byok/anthropic");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ key: "sk-test-123" }));
  });

  it("setBYOK encodes the provider segment", async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true, data: META }));
    await setBYOK("a/b", "k");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/settings/byok/a%2Fb");
  });

  it("deleteBYOK DELETEs the provider path", async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, { ok: true, data: { deleted: true, provider: "openai" } }),
    );
    await deleteBYOK("openai");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/settings/byok/openai");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("DELETE");
  });

  it("getAgentsMd GETs /api/settings/agentsmd", async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, { ok: true, data: { content: "# AGENTS\n", sha: "abc" } }),
    );
    const out = await getAgentsMd();
    expect(out).toEqual({ content: "# AGENTS\n", sha: "abc" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/settings/agentsmd");
  });

  it("setAgentsMd PUTs body with confirmed flag", async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true, data: { saved: true, sha: "def" } }));
    const out = await setAgentsMd("# new", true);
    expect(out).toEqual({ saved: true, sha: "def" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/settings/agentsmd");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ content: "# new", confirmed: true }));
  });

  it("getWorkspaceSettings GETs /api/settings/workspace and unwraps settings", async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true, data: { settings: SETTINGS } }));
    const out = await getWorkspaceSettings();
    expect(out).toEqual(SETTINGS);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/settings/workspace");
  });

  it("setWorkspaceSettings PUTs timezone + default_model and unwraps settings", async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true, data: { settings: SETTINGS } }));
    const out = await setWorkspaceSettings({
      timezone: "America/Los_Angeles",
      default_model: "byok:openai",
    });
    expect(out).toEqual(SETTINGS);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(
      JSON.stringify({
        timezone: "America/Los_Angeles",
        default_model: "byok:openai",
      }),
    );
  });
});
