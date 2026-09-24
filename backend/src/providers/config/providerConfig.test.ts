import { describe, expect, it } from "vitest";

import { createProviderConfig } from "./providerConfig.js";

describe("createProviderConfig", () => {
  it("uses documented Raydium preflight, quote-journal, and Jupiter demand defaults", () => {
    const config = createProviderConfig({});

    expect(config.raydium).toMatchObject({
      preflightPoolType: "all",
      preflightSortField: "liquidity",
      preflightSortType: "desc",
      preflightPageSize: 5,
      preflightPage: 1,
    });
    expect(config.quoteResilience.attemptJournal).toMatchObject({
      enabled: true,
      ttlMs: 300_000,
      maxEntries: 1_000,
    });
    expect(config.quoteResilience).toMatchObject({
      scheduler: { enabled: true, jupiterMinIntervalMs: 1_100, raydiumMinIntervalMs: 250 },
      singleFlight: { enabled: true, ttlMs: 15_000 },
      negativeCache: { enabled: true, ttlMs: 120_000, maxEntries: 1_000 },
      planner: {
        enabled: true,
        maxCandidatesPerCycle: 20,
        recencyWeight: 4,
        liquidityWeight: 3,
        volumeWeight: 3,
        ageWeight: 2,
        priorEvidenceWeight: 2,
      },
    });
    expect(config.raydium).toMatchObject({
      venueGuardEnabled: true,
      skipWhenDexScreenerVenueAbsent: true,
      negativeCacheTtlMs: 300_000,
      negativeCacheMaxEntries: 1_000,
    });
    expect(config.jupiter.demandController).toMatchObject({
      enabled: true,
      windowMs: 60_000,
      maxLiveRequestsPerWindow: 48,
      baseMinIntervalMs: 1_250,
      maxIntervalMs: 15_000,
      adaptiveEnabled: true,
      rateLimitMultiplier: 2,
      successDecayCount: 4,
      maxLowPriorityRequestsPerWindow: 12,
      deferLowPriorityFirst: true,
      respectRetryAfter: true,
    });
  });

  it("rejects invalid Raydium preflight options", () => {
    expect(() =>
      createProviderConfig({
        RAYDIUM_PREFLIGHT_POOL_TYPE: "bad",
      }),
    ).toThrow("RAYDIUM_PREFLIGHT_POOL_TYPE");
    expect(() =>
      createProviderConfig({
        RAYDIUM_PREFLIGHT_PAGE_SIZE: "1001",
      }),
    ).toThrow("RAYDIUM_PREFLIGHT_PAGE_SIZE");
    expect(() =>
      createProviderConfig({
        QUOTE_NEGATIVE_CACHE_TTL_MS: "0",
      }),
    ).toThrow("QUOTE_NEGATIVE_CACHE_TTL_MS");
    expect(() =>
      createProviderConfig({
        JUPITER_DEMAND_BASE_MIN_INTERVAL_MS: "15001",
        JUPITER_DEMAND_MAX_INTERVAL_MS: "15000",
      }),
    ).toThrow("JUPITER_DEMAND_BASE_MIN_INTERVAL_MS");
    expect(() =>
      createProviderConfig({
        QUOTE_BUDGET_MAX_CANDIDATES_PER_CYCLE: "0",
      }),
    ).toThrow("QUOTE_BUDGET_MAX_CANDIDATES_PER_CYCLE");
    expect(() =>
      createProviderConfig({
        QUOTE_BUDGET_LIQUIDITY_WEIGHT: "-1",
      }),
    ).toThrow("QUOTE_BUDGET_LIQUIDITY_WEIGHT");
  });
});
