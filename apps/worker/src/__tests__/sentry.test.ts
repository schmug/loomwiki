// SPDX-License-Identifier: Apache-2.0

// Sentry envelope-sender tests. Mocks global fetch to capture the
// outgoing payload and assert PII scrubbing + correlation id tagging.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureException, parseDsn, scrubPII, sendEvent } from "../lib/sentry.js";

const VALID_DSN = "https://abc123@o0.ingest.us.sentry.io/42";

describe("parseDsn", () => {
  it("parses a typical Sentry DSN", () => {
    const parsed = parseDsn(VALID_DSN);
    expect(parsed).not.toBeNull();
    expect(parsed?.host).toBe("o0.ingest.us.sentry.io");
    expect(parsed?.projectId).toBe("42");
    expect(parsed?.publicKey).toBe("abc123");
  });

  it("rejects empty / non-https / malformed DSNs", () => {
    expect(parseDsn("")).toBeNull();
    expect(parseDsn("http://x@y/1")).toBeNull();
    expect(parseDsn("not a url")).toBeNull();
    expect(parseDsn("https://o0.ingest.us.sentry.io/42")).toBeNull(); // no public key
  });
});

describe("scrubPII", () => {
  it("strips known-PII field names from objects", () => {
    const out = scrubPII({
      email: "user@example.com",
      display_name: "Cory",
      api_key: "sk-leak",
      authorization: "Bearer xxx",
      workspace_id: "01900000-0000-7000-8000-000000000000",
      safe_key: "safe value",
    });
    expect(out).toEqual({ safe_key: "safe value" });
  });

  it("redacts email-shaped strings inside string values", () => {
    expect(scrubPII("contact: alice@example.com")).toBe("contact: [redacted-email]");
  });

  it("recurses into arrays and nested objects", () => {
    const out = scrubPII({
      messages: [{ author: { email: "a@b.com" }, body: "hi alice@example.com" }],
    });
    expect(out).toEqual({
      messages: [{ author: {}, body: "hi [redacted-email]" }],
    });
  });

  it("preserves null / undefined / numbers / booleans", () => {
    expect(scrubPII(null)).toBeNull();
    expect(scrubPII(undefined)).toBeUndefined();
    expect(scrubPII(42)).toBe(42);
    expect(scrubPII(true)).toBe(true);
  });
});

describe("sendEvent + captureException", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the project store endpoint with the X-Sentry-Auth header", async () => {
    await sendEvent(VALID_DSN, {
      event_id: "0".repeat(32),
      timestamp: "2026-01-01T00:00:00.000Z",
      platform: "javascript",
      level: "error",
      logger: "loomwiki",
      tags: {},
      extra: {},
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("unreachable");
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe("https://o0.ingest.us.sentry.io/api/42/store/");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Sentry-Auth"]).toContain("sentry_key=abc123");
  });

  it("sendEvent silently no-ops on a missing / invalid DSN", async () => {
    await sendEvent("", {
      event_id: "0".repeat(32),
      timestamp: "2026-01-01T00:00:00.000Z",
      platform: "javascript",
      level: "error",
      logger: "loomwiki",
      tags: {},
      extra: {},
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("captureException scrubs PII before sending", async () => {
    const env = { SENTRY_DSN: VALID_DSN };
    captureException(env, new Error("boom"), undefined, {
      request_id: "req-1",
      user_id: "01900000-0000-7000-8000-000000000099",
      extra: {
        email: "leak@example.com",
        body: "user contact: leak@example.com",
        workspace_id: "01900000-0000-7000-8000-000000000000",
        safe: "ok",
      },
    });
    // captureException is fire-and-forget; await a tick so the
    // sendEvent promise resolves into the fetch mock.
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("unreachable");
    const [, init] = call as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // PII removed
    expect(JSON.stringify(body)).not.toContain("leak@example.com");
    expect(JSON.stringify(body)).not.toContain("workspace_id");
    expect(body.extra).not.toHaveProperty("email");
    expect(body.extra).toHaveProperty("safe", "ok");
    // request_id + user_id present in tags
    expect(body.tags.request_id).toBe("req-1");
    expect(body.tags.user_id).toBe("01900000-0000-7000-8000-000000000099");
    // Exception captured
    expect(body.exception.values[0].type).toBe("Error");
    expect(body.exception.values[0].value).toBe("boom");
  });

  it("captureException no-ops when SENTRY_DSN is unset", async () => {
    captureException({} as { SENTRY_DSN?: string }, new Error("x"), undefined);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
