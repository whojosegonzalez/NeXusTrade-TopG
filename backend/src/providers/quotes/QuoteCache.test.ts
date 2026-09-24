import { describe, expect, it } from "vitest";

import { parseTokenMintAddress, providerSuccess, type QuoteRequest } from "@nexustrade/shared";

import { QuoteCache } from "./QuoteCache.js";

const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const USDC_MINT = parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const request: QuoteRequest = {
  inputMint: SOL_MINT,
  outputMint: USDC_MINT,
  amountRaw: "10000000",
};
const quote = providerSuccess({
  provider: "JUPITER" as const,
  data: {
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    inputAmountRaw: "10000000",
    outputAmountRaw: "1000000",
    source: "JUPITER" as const,
    fetchedAt: new Date("2026-07-11T00:00:00.000Z"),
  },
});

describe("QuoteCache", () => {
  it("returns misses, hits, and expiry", () => {
    let nowMs = 1_000;
    const cache = new QuoteCache({
      enabled: true,
      ttlMs: 100,
      maxEntries: 10,
      clock: () => nowMs,
    });

    expect(cache.get("JUPITER", request).status).toBe("MISS");

    cache.set("JUPITER", request, quote);
    expect(cache.get("JUPITER", request)).toMatchObject({
      status: "HIT",
      cacheAgeMs: 0,
      cacheTtlMs: 100,
    });

    nowMs = 1_101;
    expect(cache.get("JUPITER", request).status).toBe("EXPIRED");
  });

  it("separates request identities and evicts overflow", () => {
    const cache = new QuoteCache({
      enabled: true,
      ttlMs: 1_000,
      maxEntries: 1,
      clock: () => 1_000,
    });
    const secondRequest = { ...request, amountRaw: "20000000" };

    cache.set("JUPITER", request, quote);
    cache.set("JUPITER", secondRequest, quote);

    expect(cache.get("JUPITER", request).status).toBe("MISS");
    expect(cache.get("JUPITER", secondRequest).status).toBe("HIT");
  });

  it("can be disabled", () => {
    const cache = new QuoteCache({
      enabled: false,
      ttlMs: 1_000,
      maxEntries: 10,
    });

    cache.set("JUPITER", request, quote);

    expect(cache.get("JUPITER", request).status).toBe("DISABLED");
    expect(cache.size()).toBe(0);
  });
});
