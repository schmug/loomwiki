// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { RollingWindowLimiter } from "../lib/rate-limit.js";

describe("RollingWindowLimiter", () => {
  it("permits up to `limit` hits in a window then rejects", () => {
    const lim = new RollingWindowLimiter(3, 1000);
    expect(lim.tryAcquire(0)).toBe(true);
    expect(lim.tryAcquire(100)).toBe(true);
    expect(lim.tryAcquire(200)).toBe(true);
    expect(lim.tryAcquire(300)).toBe(false);
  });

  it("recovers capacity once old hits fall outside the window", () => {
    const lim = new RollingWindowLimiter(2, 1000);
    expect(lim.tryAcquire(0)).toBe(true);
    expect(lim.tryAcquire(500)).toBe(true);
    expect(lim.tryAcquire(900)).toBe(false);
    // First hit (t=0) is now outside the window from t=1100.
    expect(lim.tryAcquire(1100)).toBe(true);
  });

  it("does not consume capacity on a rejected call", () => {
    const lim = new RollingWindowLimiter(1, 1000);
    expect(lim.tryAcquire(0)).toBe(true);
    expect(lim.tryAcquire(100)).toBe(false);
    expect(lim.tryAcquire(200)).toBe(false);
    expect(lim.size()).toBe(1);
  });
});
