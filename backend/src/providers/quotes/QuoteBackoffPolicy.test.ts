import { describe, expect, it } from "vitest";

import { QuoteBackoffPolicy } from "./QuoteBackoffPolicy.js";

describe("QuoteBackoffPolicy", () => {
  it("opens, increases, expires, and resets cooldowns", () => {
    let nowMs = 1_000;
    const policy = new QuoteBackoffPolicy({
      enabled: true,
      baseCooldownMs: 100,
      maxCooldownMs: 250,
      multiplier: 2,
      jitterPct: 0,
      clock: () => nowMs,
    });

    expect(policy.getDecision("JUPITER").active).toBe(false);

    expect(policy.recordRateLimit("JUPITER")).toMatchObject({
      active: true,
      remainingMs: 100,
      consecutiveRateLimits: 1,
    });

    nowMs = 1_050;
    expect(policy.recordRateLimit("JUPITER")).toMatchObject({
      active: true,
      remainingMs: 200,
      consecutiveRateLimits: 2,
    });

    nowMs = 1_251;
    expect(policy.getDecision("JUPITER").active).toBe(false);

    policy.recordRateLimit("JUPITER");
    policy.recordSuccess("JUPITER");
    expect(policy.getDecision("JUPITER").active).toBe(false);
  });

  it("isolates providers and operations", () => {
    const policy = new QuoteBackoffPolicy({
      enabled: true,
      baseCooldownMs: 100,
      maxCooldownMs: 100,
      multiplier: 2,
      jitterPct: 0,
      clock: () => 1_000,
    });

    policy.recordRateLimit("JUPITER", "quote");

    expect(policy.getDecision("JUPITER", "quote").active).toBe(true);
    expect(policy.getDecision("JUPITER", "price").active).toBe(false);
    expect(policy.getDecision("DEXSCREENER", "quote").active).toBe(false);
  });
});
