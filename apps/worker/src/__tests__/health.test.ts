// SPDX-License-Identifier: Apache-2.0

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /api/health", () => {
  it("returns ApiResult<ok> with status, version, and commit", async () => {
    const res = await SELF.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      data?: { status: string; version: string; commit: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.status).toBe("ok");
    expect(body.data?.version).toBe("0.0.1");
    expect(typeof body.data?.commit).toBe("string");
    expect((body.data?.commit ?? "").length).toBeGreaterThan(0);
  });

  it("returns ApiResult<err> for an unknown route", async () => {
    const res = await SELF.fetch("https://example.com/api/does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("NOT_FOUND");
  });
});
