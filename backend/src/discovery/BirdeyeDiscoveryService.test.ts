import { describe, expect, it, vi } from "vitest";
import { BirdeyeDiscoveryService } from "./BirdeyeDiscoveryService.js";
import { BirdeyeBudgetTracker } from "../services/BirdeyeBudgetTracker.js";

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
});
