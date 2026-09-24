import { describe, expect, it } from "vitest";

import { ProviderRateLimiter } from "./providerRateLimiter.js";

describe("ProviderRateLimiter", () => {
  it("delays once the per-minute provider limit is reached", async () => {
    let nowMs = 1_000;
    const waited: number[] = [];
    const limiter = new ProviderRateLimiter(
      () => nowMs,
      async (delayMs) => {
        waited.push(delayMs);
        nowMs += delayMs;
      },
    );

    expect(await limiter.waitForSlot("MOCK", 1)).toEqual({ waitedMs: 0, delayed: false });
    expect(await limiter.waitForSlot("MOCK", 1)).toEqual({ waitedMs: 60_000, delayed: true });
    expect(waited).toEqual([60_000]);
  });
});
