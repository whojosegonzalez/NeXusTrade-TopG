import { describe, expect, it } from "vitest";

import {
  createProviderError,
  parseTokenMintAddress,
  providerFailure,
  type QuoteRequest,
} from "@nexustrade/shared";

import { QuoteNegativeCache } from "./QuoteNegativeCache.js";

const request: QuoteRequest = {
  inputMint: parseTokenMintAddress("So11111111111111111111111111111111111111112"),
  outputMint: parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  amountRaw: "10000000",
};

describe("QuoteNegativeCache", () => {
  it("returns a bounded TTL hit for deterministic quote failures", () => {
    let nowMs = 1_000;
    const cache = new QuoteNegativeCache({
      enabled: true,
      ttlMs: 100,
      maxEntries: 1,
      clock: () => nowMs,
    });
    const failure = providerFailure({
      provider: "RAYDIUM",
      error: createProviderError({ code: "NOT_FOUND", message: "No route.", retryable: false }),
    });

    expect(cache.get("RAYDIUM", request).status).toBe("MISS");
    expect(cache.set("RAYDIUM", request, failure, "NO_ROUTE")).toBe("SET");
    expect(cache.get("RAYDIUM", request)).toMatchObject({ status: "HIT", ttlMs: 100 });

    nowMs = 1_101;
    expect(cache.get("RAYDIUM", request).status).toBe("EXPIRED");
  });

  it("evicts the oldest request when the entry bound is exceeded", () => {
    const cache = new QuoteNegativeCache({ enabled: true, ttlMs: 1_000, maxEntries: 1 });
    const failure = providerFailure({
      provider: "RAYDIUM",
      error: createProviderError({ code: "NOT_FOUND", message: "No route.", retryable: false }),
    });
    const secondRequest = { ...request, amountRaw: "20000000" };

    cache.set("RAYDIUM", request, failure, "NO_ROUTE");
    cache.set("RAYDIUM", secondRequest, failure, "NO_ROUTE");

    expect(cache.get("RAYDIUM", request).status).toBe("MISS");
    expect(cache.get("RAYDIUM", secondRequest).status).toBe("HIT");
  });
});
