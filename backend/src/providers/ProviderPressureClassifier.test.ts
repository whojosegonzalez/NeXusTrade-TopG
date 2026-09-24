import { describe, expect, it } from "vitest";

import type { ProviderHealthRecord } from "../db/schema/index.js";
import { stringifyJson } from "../db/utils/json.js";
import {
  classifyProviderHealthRow,
  summarizeProviderPressureMetrics,
} from "./ProviderPressureClassifier.js";

describe("ProviderPressureClassifier", () => {
  it("classifies router cache, cooldown, unavailable, disabled, and live rows", () => {
    expect(classifyProviderHealthRow(providerHealth("JUPITER", "OK"))).toBe("LIVE_PROVIDER");
    expect(
      classifyProviderHealthRow(providerHealth("JUPITER", "DEGRADED", { quoteSource: "CACHE" })),
    ).toBe("ROUTER_CACHE");
    expect(
      classifyProviderHealthRow(
        providerHealth("JUPITER", "RATE_LIMITED", { quoteSource: "SKIPPED_COOLDOWN" }),
      ),
    ).toBe("ROUTER_COOLDOWN");
    expect(
      classifyProviderHealthRow(
        providerHealth("HELIUS", "RATE_LIMITED", {
          heliusEvidenceSource: "SKIPPED_COOLDOWN",
        }),
      ),
    ).toBe("ROUTER_COOLDOWN");
    expect(
      classifyProviderHealthRow(providerHealth("JUPITER", "ERROR", { quoteSource: "UNAVAILABLE" })),
    ).toBe("ROUTER_UNAVAILABLE");
    expect(classifyProviderHealthRow(providerHealth("JUPITER", "DISABLED"))).toBe("DISABLED");
  });

  it("summarizes live provider pressure separately from router bookkeeping", () => {
    const metrics = summarizeProviderPressureMetrics([
      providerHealth("JUPITER", "OK"),
      providerHealth("JUPITER", "RATE_LIMITED"),
      providerHealth("JUPITER", "RATE_LIMITED", { quoteSource: "SKIPPED_COOLDOWN" }),
      providerHealth("JUPITER", "DEGRADED", { quoteSource: "CACHE" }),
    ]);

    expect(metrics.totalRows).toBe(4);
    expect(metrics.liveRows).toBe(2);
    expect(metrics.routerRows).toBe(2);
    expect(metrics.liveRateLimitedPct).toBe(50);
    expect(metrics.combinedRateLimitedPct).toBe(50);
    expect(metrics.routerCacheHits).toBe(1);
    expect(metrics.routerCooldownSkips).toBe(1);
    expect(metrics.routerCooldownSkipPct).toBe(50);
  });

  it("summarizes quote source types and fallback reasons from provider context", () => {
    const metrics = summarizeProviderPressureMetrics([
      providerHealth("JUPITER", "DEGRADED", {
        quoteSource: "CACHE",
        quoteSourceType: "CACHE",
        quoteFallbackReason: "NONE",
      }),
      providerHealth("RAYDIUM", "OK", {
        quoteSource: "LIVE",
        quoteSourceType: "LIVE",
        quoteFallbackReason: "JUPITER_RATE_LIMITED",
      }),
    ]);

    expect(metrics.quoteSourceTypeCounts).toEqual({
      CACHE: 1,
      LIVE: 1,
    });
    expect(metrics.quoteFallbackReasonCounts).toEqual({
      JUPITER_RATE_LIMITED: 1,
      NONE: 1,
    });
  });

  it("attributes quote demand controls without counting them as live provider pressure", () => {
    const metrics = summarizeProviderPressureMetrics([
      providerHealth("JUPITER", "DEGRADED", {
        quoteDemandAction: "SUCCESS_CACHE_HIT",
      }),
      providerHealth("RAYDIUM", "ERROR", {
        quoteDemandAction: "VENUE_GUARD_SKIP",
        raydiumVenueGuardDecision: "SKIP_NO_RAYDIUM_VENUE",
        raydiumVenueGuardReason: "non-raydium-venues-observed",
      }),
      providerHealth("JUPITER", "OK", {
        quoteDemandAction: "SCHEDULED_LIVE_CALL",
        quoteSchedulerWaitMs: 1_100,
      }),
    ]);

    expect(metrics.liveRows).toBe(0);
    expect(metrics.quoteDemandActionCounts).toEqual({
      SCHEDULED_LIVE_CALL: 1,
      SUCCESS_CACHE_HIT: 1,
      VENUE_GUARD_SKIP: 1,
    });
    expect(metrics.quoteSchedulerWaitMsTotal).toBe(1_100);
    expect(metrics.raydiumVenueGuardDecisionCounts).toEqual({ SKIP_NO_RAYDIUM_VENUE: 1 });
    expect(metrics.liveQuoteCallsAvoidedEstimate).toBe(2);
  });

  it("separates Jupiter local demand deferrals from upstream rate limits", () => {
    const metrics = summarizeProviderPressureMetrics([
      providerHealth("JUPITER", "ERROR", {
        operation: "quote",
        quoteDemandAction: "JUPITER_DEMAND_DEFERRED",
        jupiterDemandAction: "DEFERRED_WINDOW_BUDGET",
        jupiterDemandOperation: "QUOTE",
        jupiterDemandPriority: "NORMAL",
        jupiterEffectiveIntervalMs: 1_250,
        jupiterAdaptiveLevel: 0,
        jupiterSharedWindowUsage: 48,
      }),
      providerHealth("JUPITER", "RATE_LIMITED", {
        operation: "price",
        jupiterDemandAction: "LIVE_ALLOWED",
        jupiterDemandOperation: "PRICE",
        jupiterDemandPriority: "LOW",
        jupiterControllerRateLimitObserved: true,
        jupiterEffectiveIntervalMs: 2_500,
        jupiterAdaptiveLevel: 1,
        jupiterSharedWindowUsage: 10,
      }),
    ]);

    expect(metrics.jupiterDemandActionCounts).toEqual({
      DEFERRED_WINDOW_BUDGET: 1,
      LIVE_ALLOWED: 1,
    });
    expect(metrics.jupiterDemandDeferredCount).toBe(1);
    expect(metrics.jupiterControllerRateLimitObservedCount).toBe(1);
    expect(metrics.jupiterEffectiveIntervalMsAverage).toBe(1_875);
    expect(metrics.jupiterAdaptiveLevelMax).toBe(1);
    expect(metrics.jupiterSharedWindowUsageMax).toBe(48);
  });

  it("summarizes Raydium and Helius diagnostic context", () => {
    const metrics = summarizeProviderPressureMetrics([
      providerHealth("RAYDIUM", "ERROR", {
        raydiumFailureCategory: "NO_ROUTE",
        raydiumFailureDetail: "NO_ROUTE",
        raydiumPreflightStatus: "NO_POOL",
        raydiumPreflightFailureDetail: "NO_ROUTE",
        httpEndpointIds: "RAYDIUM_COMPUTE_SWAP_BASE_IN:2|RAYDIUM_POOL_PREFLIGHT:1",
        httpAttemptOutcomes: "OK:1|HTTP_ERROR:2",
        httpStatusCodes: "200:1|400:2",
        quoteLatestAttemptOutcome: "FAILURE",
        quoteLastSuccessfulProvider: "JUPITER",
        quoteLatestVsLastSuccessDivergence: true,
      }),
      providerHealth("RAYDIUM", "OK", {
        raydiumFailureCategory: "NONE",
        raydiumFailureDetail: "NONE",
        raydiumPreflightStatus: "FOUND",
      }),
      providerHealth("HELIUS", "OK", {
        heliusEvidenceSource: "CACHE",
        heliusCacheStatus: "HIT",
      }),
      providerHealth("HELIUS", "RATE_LIMITED", {
        heliusEvidenceSource: "SKIPPED_COOLDOWN",
        heliusCacheStatus: "MISS",
      }),
    ]);

    expect(metrics.raydiumFailureCategoryCounts).toEqual({
      NONE: 1,
      NO_ROUTE: 1,
    });
    expect(metrics.raydiumFailureDetailCounts).toEqual({
      NONE: 1,
      NO_ROUTE: 1,
    });
    expect(metrics.raydiumPreflightStatusCounts).toEqual({
      FOUND: 1,
      NO_POOL: 1,
    });
    expect(metrics.raydiumPreflightFailureDetailCounts).toEqual({
      NO_ROUTE: 1,
    });
    expect(metrics.httpEndpointIdCounts).toEqual({
      RAYDIUM_COMPUTE_SWAP_BASE_IN: 2,
      RAYDIUM_POOL_PREFLIGHT: 1,
    });
    expect(metrics.httpAttemptOutcomeCounts).toEqual({
      HTTP_ERROR: 2,
      OK: 1,
    });
    expect(metrics.httpStatusCodeCounts).toEqual({
      "200": 1,
      "400": 2,
    });
    expect(metrics.quoteLatestAttemptOutcomeCounts).toEqual({
      FAILURE: 1,
    });
    expect(metrics.quoteLastSuccessfulProviderCounts).toEqual({
      JUPITER: 1,
    });
    expect(metrics.quoteLatestVsLastSuccessDivergenceCounts).toEqual({
      true: 1,
    });
    expect(metrics.heliusEvidenceSourceCounts).toEqual({
      CACHE: 1,
      SKIPPED_COOLDOWN: 1,
    });
    expect(metrics.heliusCacheStatusCounts).toEqual({
      HIT: 1,
      MISS: 1,
    });
    expect(metrics.routerCacheHits).toBe(1);
    expect(metrics.routerCooldownSkips).toBe(1);
  });

  it("summarizes Birdeye diagnostic context", () => {
    const metrics = summarizeProviderPressureMetrics([
      providerHealth("BIRDEYE", "OK", {
        birdeyeEndpoint: "/defi/price",
        birdeyeCacheStatus: "MISS",
        birdeyeFailureCategory: "NONE",
        birdeyeSelectionReason: "WATCH_RISK_PASS",
      }),
      providerHealth("BIRDEYE", "DEGRADED", {
        birdeyeEndpoint: "/defi/token_overview",
        birdeyeCacheStatus: "HIT",
        birdeyeFailureCategory: "NONE",
        birdeyeSelectionReason: "WATCH_RISK_PASS",
      }),
      providerHealth("BIRDEYE", "ERROR", {
        birdeyeEndpoint: "/defi/token_overview",
        birdeyeCacheStatus: "MISS",
        birdeyeFailureCategory: "BIRDEYE_CU_BUDGET_EXHAUSTED",
        birdeyeSelectionReason: "HIGH_SCORE_SKIP",
        birdeyeBudgetReason: "CU_BUDGET_EXHAUSTED",
      }),
    ]);

    expect(metrics.birdeyeEndpointCounts).toEqual({
      "/defi/price": 1,
      "/defi/token_overview": 2,
    });
    expect(metrics.birdeyeCacheStatusCounts).toEqual({
      HIT: 1,
      MISS: 2,
    });
    expect(metrics.birdeyeFailureCategoryCounts).toEqual({
      BIRDEYE_CU_BUDGET_EXHAUSTED: 1,
      NONE: 2,
    });
    expect(metrics.birdeyeSelectionReasonCounts).toEqual({
      HIGH_SCORE_SKIP: 1,
      WATCH_RISK_PASS: 2,
    });
    expect(metrics.birdeyeBudgetReasonCounts).toEqual({
      CU_BUDGET_EXHAUSTED: 1,
    });
    expect(metrics.routerCacheHits).toBe(1);
  });

  it("summarizes authority fallback, RPC, and DAS diagnostic context", () => {
    const metrics = summarizeProviderPressureMetrics([
      providerHealth("SOLANA_RPC", "OK", {
        authorityEvidenceSource: "SOLANA_RPC_JSON_PARSED",
        mintAuthorityState: "DISABLED",
        freezeAuthorityState: "PRESENT",
        rpcCacheStatus: "MISS",
        rpcFailureCategory: "NONE",
      }),
      providerHealth("SOLANA_RPC", "DEGRADED", {
        authorityEvidenceSource: "SOLANA_RPC_BASE64_LAYOUT",
        mintAuthorityState: "DISABLED",
        freezeAuthorityState: "DISABLED",
        rpcCacheStatus: "HIT",
      }),
      providerHealth("QUICKNODE_DAS", "OK", {
        dasProvider: "QUICKNODE_DAS",
        dasFailureCategory: "NONE",
      }),
      providerHealth("ALCHEMY_DAS", "ERROR", {
        dasProvider: "ALCHEMY_DAS",
        dasFailureCategory: "INVALID_ASSET",
      }),
    ]);

    expect(metrics.authorityEvidenceSourceCounts).toEqual({
      SOLANA_RPC_BASE64_LAYOUT: 1,
      SOLANA_RPC_JSON_PARSED: 1,
    });
    expect(metrics.mintAuthorityStateCounts).toEqual({
      DISABLED: 2,
    });
    expect(metrics.freezeAuthorityStateCounts).toEqual({
      DISABLED: 1,
      PRESENT: 1,
    });
    expect(metrics.rpcCacheStatusCounts).toEqual({
      HIT: 1,
      MISS: 1,
    });
    expect(metrics.rpcFailureCategoryCounts).toEqual({
      NONE: 1,
    });
    expect(metrics.dasProviderCounts).toEqual({
      ALCHEMY_DAS: 1,
      QUICKNODE_DAS: 1,
    });
    expect(metrics.dasFailureCategoryCounts).toEqual({
      INVALID_ASSET: 1,
      NONE: 1,
    });
    expect(metrics.routerCacheHits).toBe(1);
  });
});

function providerHealth(
  provider: string,
  status: ProviderHealthRecord["status"],
  context?: Readonly<Record<string, unknown>>,
): ProviderHealthRecord {
  return {
    id: `${provider}_${status}_${context?.quoteSource ?? "live"}`,
    sessionId: null,
    provider,
    timestampMs: 1_800_000_000_000,
    status,
    latencyMs: 10,
    rateLimited: status === "RATE_LIMITED",
    errorMessage: null,
    creditsUsed: null,
    contextJson: context ? stringifyJson(context) : null,
  };
}
