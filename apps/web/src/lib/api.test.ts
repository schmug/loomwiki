// SPDX-License-Identifier: Apache-2.0

// Pins the contract:
//   - 200 ApiResult<ok> → returns the unwrapped data
//   - 4xx ApiResult<err> → throws ApiError with the typed code
//   - 401 → throws AuthRequiredError carrying the meta-tagged login URL
//   - non-JSON → throws ApiError(INTERNAL_ERROR)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, AuthRequiredError, apiGet, apiPost } from "./api";

function mockFetch(response: Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clearHeadMetas(): void {
  for (const m of Array.from(document.head.querySelectorAll("meta"))) {
    m.remove();
  }
}

beforeEach(() => {
  clearHeadMetas();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiGet", () => {
  it("returns the unwrapped data on ApiResult<ok>", async () => {
    mockFetch(jsonResponse(200, { ok: true, data: { hello: "world" } }));
    const data = await apiGet<{ hello: string }>("/api/whatever");
    expect(data).toEqual({ hello: "world" });
  });

  it("throws ApiError with the typed code on ApiResult<err>", async () => {
    mockFetch(jsonResponse(404, { ok: false, error: { code: "NOT_FOUND", message: "nope" } }));
    await expect(apiGet("/api/missing")).rejects.toMatchObject({
      name: "ApiError",
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("throws AuthRequiredError with the login URL meta on 401", async () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "loomwiki-access-login-url");
    meta.setAttribute("content", "https://team.cloudflareaccess.com/login");
    document.head.appendChild(meta);

    mockFetch(jsonResponse(401, { ok: false, error: { code: "AUTH_REQUIRED", message: "x" } }));

    await expect(apiGet("/api/me")).rejects.toBeInstanceOf(AuthRequiredError);
    try {
      await apiGet("/api/me");
    } catch (err) {
      expect((err as AuthRequiredError).loginUrl).toBe("https://team.cloudflareaccess.com/login");
    }
  });

  it("throws AuthRequiredError with null login URL when meta is absent", async () => {
    mockFetch(jsonResponse(401, { ok: false, error: { code: "AUTH_REQUIRED", message: "x" } }));
    try {
      await apiGet("/api/me");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthRequiredError);
      expect((err as AuthRequiredError).loginUrl).toBeNull();
    }
  });

  it("throws ApiError(INTERNAL_ERROR) on non-JSON body", async () => {
    mockFetch(new Response("<html>500</html>", { status: 500 }));
    await expect(apiGet("/api/x")).rejects.toMatchObject({
      name: "ApiError",
      code: "INTERNAL_ERROR",
      status: 500,
    });
  });

  it("sends credentials=include and no Content-Type on GET", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, data: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiGet("/api/health");
    const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
    const init = call?.[1];
    expect(init?.credentials).toBe("include");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBeUndefined();
    expect(headers?.Accept).toBe("application/json");
  });
});

describe("apiPost", () => {
  it("serializes the body and sets Content-Type", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, data: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await apiPost("/api/x", { foo: "bar" });

    const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
    const init = call?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ foo: "bar" }));
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBe("application/json");
  });

  it("preserves status code on ApiError so callers can branch", async () => {
    mockFetch(jsonResponse(409, { ok: false, error: { code: "CONFLICT", message: "dup" } }));
    try {
      await apiPost("/api/rooms", { slug: "x" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).code).toBe("CONFLICT");
    }
  });
});
