// SPDX-License-Identifier: Apache-2.0

// Rolling 1-second window rate limiter for ChatRoom (SPEC §9: 100 msg/sec
// per room). Lives in DO instance memory only — hibernation drops the
// window, which is the desired behavior (a freshly-woken room cannot have
// been over the limit a millisecond ago).

export class RollingWindowLimiter {
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly hits: number[] = [];

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /**
   * Records a hit at `now` (millis) and returns whether it is permitted.
   * Side-effecting: the hit is recorded only if it is permitted, so a
   * rejected call does not consume capacity.
   */
  tryAcquire(now: number): boolean {
    const cutoff = now - this.windowMs;
    while (this.hits.length > 0) {
      const head = this.hits[0];
      if (head !== undefined && head <= cutoff) this.hits.shift();
      else break;
    }
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }

  /** Test seam — number of hits currently inside the window. */
  size(): number {
    return this.hits.length;
  }
}
