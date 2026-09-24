import { describe, expect, it } from "vitest";

import { RaydiumPreflightCache } from "./RaydiumPreflightCache.js";

describe("RaydiumPreflightCache", () => {
  it("uses mint-pair order-independent keys and expires entries by ttl", () => {
    let now = 1_000;
    const cache = new RaydiumPreflightCache({
      ttlMs: 500,
      now: () => now,
    });

    cache.set({
      inputMint: "mint_a",
      outputMint: "mint_b",
      status: "FOUND",
      poolsFound: 2,
      productTypes: ["CPMM"],
    });

    expect(cache.get("mint_b", "mint_a")).toMatchObject({
      status: "FOUND",
      poolsFound: 2,
    });

    now = 1_501;

    expect(cache.get("mint_a", "mint_b")).toBeUndefined();
  });
});
