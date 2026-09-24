import { describe, expect, it } from "vitest";

import { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { RaydiumPoolPreflightService } from "./RaydiumPoolPreflightService.js";
import { RaydiumPreflightCache } from "./RaydiumPreflightCache.js";

describe("RaydiumPoolPreflightService", () => {
  it("checks Raydium API v3 pools by mint pair and caches found pools", async () => {
    const requestedUrls: string[] = [];
    const service = createService(async (input) => {
      requestedUrls.push(String(input));

      return jsonResponse({
        success: true,
        data: {
          data: [
            {
              id: "pool_1",
              type: "CPMM",
            },
          ],
        },
      });
    });

    const first = await service.check({
      inputMint: "mint_a",
      outputMint: "mint_b",
    });
    const second = await service.check({
      inputMint: "mint_b",
      outputMint: "mint_a",
    });

    expect(first).toMatchObject({
      status: "FOUND",
      poolsFound: 1,
      productTypes: ["CPMM"],
      cacheStatus: "MISS",
    });
    expect(second).toMatchObject({
      status: "FOUND",
      poolsFound: 1,
      cacheStatus: "HIT",
    });
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toBe(
      "https://api-v3.raydium.io/pools/info/mint?mint1=mint_a&mint2=mint_b&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=5&page=1",
    );
  });

  it("returns NO_POOL for successful empty pool responses", async () => {
    const service = createService(async () =>
      jsonResponse({
        success: true,
        data: {
          data: [],
        },
      }),
    );

    await expect(
      service.check({
        inputMint: "mint_a",
        outputMint: "mint_b",
      }),
    ).resolves.toMatchObject({
      status: "NO_POOL",
      poolsFound: 0,
    });
  });

  it("classifies API v3 success=false preflight messages", async () => {
    const service = createService(async () =>
      jsonResponse({
        success: false,
        msg: "REQ_INPUT_MINT_ERROR",
      }),
    );

    await expect(
      service.check({
        inputMint: "mint_a",
        outputMint: "mint_b",
      }),
    ).resolves.toMatchObject({
      status: "FAILED",
      failureDetail: "REQ_INPUT_MINT_ERROR",
      message: "REQ_INPUT_MINT_ERROR",
    });
  });
});

function createService(fetchImpl: typeof fetch): RaydiumPoolPreflightService {
  return new RaydiumPoolPreflightService({
    enabled: true,
    httpClient: new ProviderHttpClient({
      provider: "RAYDIUM",
      baseUrl: "https://api-v3.raydium.io",
      timeoutMs: 1_000,
      rateLimitPerMinute: 60,
      fetchImpl,
    }),
    cache: new RaydiumPreflightCache({
      ttlMs: 60_000,
    }),
    allowRawPayloadLogging: false,
    poolType: "all",
    sortField: "liquidity",
    sortType: "desc",
    pageSize: 5,
    page: 1,
    maxErrorMessageLength: 240,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}
