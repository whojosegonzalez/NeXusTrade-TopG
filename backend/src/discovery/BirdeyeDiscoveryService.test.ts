import { describe, expect, it, vi } from "vitest";
import { BirdeyeDiscoveryService } from "./BirdeyeDiscoveryService.js";
import { BirdeyeBudgetTracker } from "../services/BirdeyeBudgetTracker.js";
import { CandidateWatchlistService } from "../candidate-scanner/CandidateWatchlistService.js";
import type { ScannedPoolRecord } from "../candidate-scanner/CandidateScannerTypes.js";

describe("BirdeyeDiscoveryService", () => {
  it("handles missing API key gracefully without errors", async () => {
    const logs: string[] = [];
    const service = new BirdeyeDiscoveryService({
      apiKey: "",
      logger: (msg) => logs.push(msg),
    });

    const probe = await service.probeSmartMoney();
    expect(probe.supported).toBe(false);
    expect(probe.status).toBe(401);
    expect(service.isSmartMoneyAvailable()).toBe(false);
    expect(logs.some((l) => l.includes("No Birdeye API key"))).toBe(true);

    const tokens = await service.fetchTrendingTokens();
    expect(tokens).toEqual([]);
  });

  it("handles 403 Forbidden on smart-money probe without throwing and flags unavailable", async () => {
    const logs: string[] = [];
    const mockFetch = vi.fn().mockResolvedValue({
      status: 403,
      ok: false,
    });

    const service = new BirdeyeDiscoveryService({
      apiKey: "test-birdeye-key",
      fetchFn: mockFetch as unknown as typeof fetch,
      logger: (msg) => logs.push(msg),
    });

    const probe = await service.probeSmartMoney();
    expect(probe.supported).toBe(false);
    expect(probe.status).toBe(403);
    expect(service.isSmartMoneyAvailable()).toBe(false);
    expect(logs.some((l) => l.includes("Standard plan active"))).toBe(true);
  });

  it("handles 200 OK on smart-money probe and flags available", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
    });

    const service = new BirdeyeDiscoveryService({
      apiKey: "test-birdeye-key",
      fetchFn: mockFetch as unknown as typeof fetch,
      logger: () => {},
    });

    const probe = await service.probeSmartMoney();
    expect(probe.supported).toBe(true);
    expect(probe.status).toBe(200);
    expect(service.isSmartMoneyAvailable()).toBe(true);
  });

  it("handles network error during smart-money probe gracefully", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network timeout"));

    const service = new BirdeyeDiscoveryService({
      apiKey: "test-birdeye-key",
      fetchFn: mockFetch as unknown as typeof fetch,
      logger: () => {},
    });

    const probe = await service.probeSmartMoney();
    expect(probe.supported).toBe(false);
    expect(probe.status).toBe(0);
    expect(service.isSmartMoneyAvailable()).toBe(false);
  });

  it("fetches and parses trending tokens, updating budget tracker", async () => {
    const tracker = new BirdeyeBudgetTracker({ monthlyCuLimit: 1000 });
    const mockTrendingResponse = {
      data: {
        tokens: [
          {
            address: "TokenMint1111111111111111111111111111111111",
            symbol: "ALPHA",
            name: "Alpha Token",
            decimals: 6,
            liquidity: 150_000,
            price: 1.25,
            volume24hUSD: 500_000,
            rank: 1,
          },
          {
            // Missing symbol, should be filtered out
            address: "TokenMint2222222222222222222222222222222222",
            symbol: "",
          },
        ],
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(mockTrendingResponse),
    });

    const service = new BirdeyeDiscoveryService({
      apiKey: "test-birdeye-key",
      budgetTracker: tracker,
      fetchFn: mockFetch as unknown as typeof fetch,
      logger: () => {},
    });

    const nowMs = 1_000_000;
    const tokens = await service.fetchTrendingTokens(20, nowMs);

    expect(tokens.length).toBe(1);
    expect(tokens[0]?.symbol).toBe("ALPHA");
    expect(tokens[0]?.address).toBe("TokenMint1111111111111111111111111111111111");
    expect(tokens[0]?.volume24hUSD).toBe(500_000);
    expect(tracker.getSnapshot().monthlyCuUsed).toBe(25);
    expect(tracker.getSnapshot().totalTrendingPolls).toBe(1);

    // Immediate second poll should be throttled and return cached tokens without calling fetch again
    const throttledTokens = await service.fetchTrendingTokens(20, nowMs + 10_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(throttledTokens.length).toBe(1);
    expect(throttledTokens[0]?.symbol).toBe("ALPHA");
  });

  it("handles fetch failure gracefully and returns cached tokens", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("500 Internal Server Error"));
    const service = new BirdeyeDiscoveryService({
      apiKey: "test-birdeye-key",
      fetchFn: mockFetch as unknown as typeof fetch,
      logger: () => {},
    });

    const tokens = await service.fetchTrendingTokens(20, 1_000_000);
    expect(tokens).toEqual([]);
  });

  it("converts trending token into ScannedPoolRecord and admits into CandidateWatchlistService", async () => {
    const watchlistService = new CandidateWatchlistService();
    const token = {
      address: "BirdeyeTrending11111111111111111111111111111",
      symbol: "TREND",
      name: "Trending Token",
      decimals: 9,
      liquidity: 45_000,
      price: 0.15,
      volume24hUSD: 600_000,
      rank: 1,
    };

    const currentNow = 1_700_000_000_000;
    const currentNowSec = Math.floor(currentNow / 1000);
    const trendingRecord: ScannedPoolRecord = {
      poolId: `birdeye-${token.address.slice(0, 8)}`,
      mintAddress: token.address,
      symbol: token.symbol,
      decimals: token.decimals ?? 9,
      baseMint: token.address,
      liquidityUsd: token.liquidity ?? 40_000,
      marketCapUsd: (token.liquidity ?? 40_000) * 3,
      openTimeSec: currentNowSec - 3600,
      lpBurnPct: 100,
      mintAuthority: null,
      freezeAuthority: null,
      volume5mUsd: token.volume24hUSD ? Math.round(token.volume24hUSD / 288) : 10_000,
      txCount5m: 25,
      buys5m: 16,
      sells5m: 9,
      spotPriceUsd: token.price > 0 ? token.price : 0.05,
      fetchedAt: new Date(currentNow).toISOString(),
    };

    const admitted = watchlistService.admitOrUpdate(trendingRecord, currentNowSec);
    expect(admitted).not.toBeNull();
    expect(admitted?.symbol).toBe("TREND");
    expect(admitted?.mintAddress).toBe(token.address);
    expect(admitted?.status).toBe("WATCHING");
  });
});
