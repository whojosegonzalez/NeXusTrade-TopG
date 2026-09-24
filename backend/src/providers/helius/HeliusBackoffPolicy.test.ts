import { describe, expect, it } from "vitest";

import { HeliusBackoffPolicy } from "./HeliusBackoffPolicy.js";

describe("HeliusBackoffPolicy", () => {
  it("applies exponential cooldowns and clears after success", () => {
    let now = 1_000;
    const policy = new HeliusBackoffPolicy({
      enabled: true,
      baseCooldownMs: 100,
      maxCooldownMs: 250,
      now: () => now,
    });

    expect(policy.getDecision("getAsset")).toEqual({
      active: false,
      remainingMs: 0,
    });

    policy.recordRateLimit("getAsset");

    expect(policy.getDecision("getAsset")).toEqual({
      active: true,
      remainingMs: 100,
    });

    now = 1_101;
    policy.recordRateLimit("getAsset");

    expect(policy.getDecision("getAsset")).toEqual({
      active: true,
      remainingMs: 200,
    });

    policy.recordSuccess("getAsset");

    expect(policy.getDecision("getAsset")).toEqual({
      active: false,
      remainingMs: 0,
    });
  });
});
