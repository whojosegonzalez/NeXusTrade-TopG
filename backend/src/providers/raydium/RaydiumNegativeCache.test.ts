import { describe, expect, it } from "vitest";

import {
  createProviderError,
  parseTokenMintAddress,
  providerFailure,
  type QuoteRequest,
} from "@nexustrade/shared";

import { RaydiumNegativeCache } from "./RaydiumNegativeCache.js";

const request: QuoteRequest = {
  inputMint: parseTokenMintAddress("So11111111111111111111111111111111111111112"),
  outputMint: parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  amountRaw: "10000000",
};

describe("RaydiumNegativeCache", () => {
  it("retains Raydium-specific deterministic no-route evidence", () => {
    const cache = new RaydiumNegativeCache({ enabled: true, ttlMs: 1_000, maxEntries: 10 });
    const failure = providerFailure({
      provider: "RAYDIUM",
      error: createProviderError({ code: "NOT_FOUND", message: "No pool.", retryable: false }),
    });

    cache.set("RAYDIUM", request, failure, "NO_POOL");

    expect(cache.get("RAYDIUM", request).entry?.reason).toBe("NO_POOL");
  });
});
