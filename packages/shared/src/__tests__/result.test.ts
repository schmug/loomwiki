// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { id } from "../id.js";
import { apiErr, apiOk } from "../result.js";

describe("ApiResult helpers", () => {
  it("apiOk wraps data in a success variant", () => {
    const r = apiOk({ status: "ok" as const });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.status).toBe("ok");
  });

  it("apiErr produces an error variant with the given code", () => {
    const r = apiErr("not_found", "missing");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("not_found");
      expect(r.error.message).toBe("missing");
    }
  });
});

describe("id()", () => {
  it("returns a UUIDv7-shaped string with the version nibble set to 7", () => {
    const value = id();
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
