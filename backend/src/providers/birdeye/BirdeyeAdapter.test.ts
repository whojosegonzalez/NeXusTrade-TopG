import { describe, expect, it } from "vitest";
import { parseTokenMintAddress } from "@nexustrade/shared";

import { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { BirdeyeAdapter } from "./BirdeyeAdapter.js";
import { BirdeyeBudgetTracker } from "./BirdeyeBudgetTracker.js";
import { BirdeyeCache } from "./BirdeyeCache.js";

const MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");

describe("BirdeyeAdapter", () => {
  it("fetches and caches price responses", async () => {
    let fetchCount = 0;
    const adapter = createAdapter(async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            value: 175.5,
            symbol: "SOL",
          },
        }),
        { status: 200 },
      );
    });

    const first = await adapter.getPrice(MINT);
    const second = await adapter.getPrice(MINT);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fetchCount).toBe(1);
    expect(first.ok ? first.data.priceUsd : undefined).toBe(175.5);
    expect(second.warnings).toContain("Birdeye cache hit.");
  });

  it("skips live requests when the run budget is exhausted", async () => {
    const adapter = createAdapter(
      async () => new Response(JSON.stringify({ success: true, data: { value: 1 } })),
      {
        maxRequestsPerRun: 0,
        maxCuPerRun: 0,
      },
    );

    const result = await adapter.getPrice(MINT);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.message).toMatch(/budget/i);
  });
});

function createAdapter(
  fetchImpl: typeof fetch,
  budget = {
    maxRequestsPerRun: 10,
    maxCuPerRun: 100,
  },
): BirdeyeAdapter {
  return new BirdeyeAdapter({
    httpClient: new ProviderHttpClient({
      provider: "BIRDEYE",
      baseUrl: "https://public-api.birdeye.so",
      timeoutMs: 1_000,
      rateLimitPerMinute: 60,
      defaultHeaders: {
        "X-API-KEY": "test-key",
        "x-chain": "solana",
      },
      fetchImpl,
    }),
    maxRetries: 0,
    retryBackoffMs: 0,
    allowRawPayloadLogging: false,
    priceEnabled: true,
    tokenOverviewEnabled: true,
    cacheEnabled: true,
    overviewFrames: ["1m", "5m"],
    budget: new BirdeyeBudgetTracker(budget),
    cache: new BirdeyeCache({
      ttlMs: 300_000,
    }),
  });
}
