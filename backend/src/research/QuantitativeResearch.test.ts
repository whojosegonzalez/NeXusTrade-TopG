/**
 * Phase 12.94-D Milestone D.1 Test Suite: Quantitative Research Engine
 *
 * Verifies event-specific causal data joins, trajectory ambiguity handling,
 * anti-lookahead feature boundaries, provenance preservation, fail-closed eligibility
 * gating, exact signed dust cash-flow accounting, and zero-imputation invariants.
 */

import { describe, expect, it } from "vitest";
import type {
  CandidateDecisionRecord,
  CandidateMetricsSnapshot,
  MarketObservationRecord,
  StratifiedSamplingRecord,
} from "../telemetry/TelemetryTypes.js";
import type { ExecutableQuoteRecord, SimulatedFillRecord } from "../execution/ExecutionTypes.js";
import {
  TelemetryExecutionJoinEngine,
  extractDecisionFeatures,
} from "./TelemetryExecutionJoinEngine.js";
import {
  computeResearchFinancialAccounting,
  evaluateResearchEligibility,
} from "./ResearchEligibilityGate.js";
import type { JoinedResearchRecord } from "./ResearchTypes.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

function createMockDecision(
  overrides: Partial<CandidateDecisionRecord> = {},
): CandidateDecisionRecord {
  const defaultMetrics: CandidateMetricsSnapshot = {
    tokenAgeSec: 3600,
    liquidityUsd: 50_000,
    marketCapUsd: 150_000,
    lmcRatio: 0.333,
    lpBurnPct: 95.0,
    spotPriceUsd: 0.00015,
    spotPriceSol: 0.000001,
    volume5mUsd: 12_500,
    txCount5m: 85,
    buys5m: 60,
    sells5m: 25,
    metricProvenance: {
      tokenAgeSec: "DERIVED",
      liquidityUsd: "OBSERVED",
      marketCapUsd: "OBSERVED",
      lmcRatio: "DERIVED",
      lpBurnPct: "OBSERVED",
      spotPriceUsd: "OBSERVED",
      spotPriceSol: "OBSERVED",
      volume5mUsd: "OBSERVED",
      txCount5m: "OBSERVED",
      buys5m: "OBSERVED",
      sells5m: "OBSERVED",
    },
  };

  return {
    eventId: "event-dec-1",
    sessionId: "session-test-1",
    generationId: "gen-1",
    mintAddress: "TokenMint111111111111111111111111111111111111",
    poolId: "pool-amm-1",
    symbol: "TEST",
    sourceTimestampMs: 1792000000000,
    ingestionTimestampMs: 1792000000500,
    decisionTimestampMs: 1792000001000,
    strategyRevision: "strategy-v1",
    decisionCohort: "EXECUTED_BUY",
    filterEvaluations: [],
    metricsSnapshot: defaultMetrics,
    missingFields: [],
    providerIdentity: "dexscreener",
    ...overrides,
  };
}

function createMockObservation(
  overrides: Partial<MarketObservationRecord> = {},
): MarketObservationRecord {
  return {
    observationId: "obs-1",
    sessionId: "session-test-1",
    generationId: "gen-1",
    mintAddress: "TokenMint111111111111111111111111111111111111",
    poolId: "pool-amm-1",
    actualResponsePoolId: "pool-amm-1",
    sourceTimestampMs: 1792000060000, // +60s
    ingestionTimestampMs: 1792000060200,
    responseReceivedMs: 1792000060200,
    dataFreshnessMs: 500,
    measurementWindow: {
      windowStartMs: 1792000000000,
      windowEndMs: 1792000060000,
      durationSec: 60,
    },
    providerIdentity: "dexscreener",
    priceMetrics: {
      spotPriceUsd: 0.00018,
      spotPriceSol: 0.0000012,
      priceSource: "POOL_RESERVE",
    },
    liquidityMetrics: {
      baseReserve: 500_000_000,
      quoteReserve: 50.0,
      liquidityUsd: 55_000,
    },
    flowMetrics: {
      txCount: 120,
      buys: 90,
      sells: 30,
      volumeUsd: 20_000,
      netBuyerVolumeUsd: 8_000,
    },
    missingFields: [],
    strategyRevision: "strategy-v1",
    ...overrides,
  };
}

describe("Phase 12.94-D Milestone D.1: Quantitative Research Engine", () => {
  describe("RF-D1: Point-in-Time Join Integrity & Temporal Causality", () => {
    it("RF-D1.1: handles empty dataset and empty sessions without error", () => {
      const joiner = new TelemetryExecutionJoinEngine();
      const results = joiner.joinTelemetryAndExecution({
        decisions: [],
        observations: [],
      });
      expect(results).toHaveLength(0);
    });

    it("RF-D1.2: joins B-only telemetry in OBSERVATIONAL_ONLY mode with zero quotes and zero fabrication", () => {
      const joiner = new TelemetryExecutionJoinEngine({ mode: "OBSERVATIONAL_ONLY" });
      const decision = createMockDecision();
      const obs = createMockObservation();

      const results = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [obs],
      });

      expect(results).toHaveLength(1);
      const record = results[0]!;
      expect(record.decisionEventId).toBe(decision.eventId);
      expect(record.evaluationMode).toBe("OBSERVATIONAL_ONLY");
      expect(record.trajectoryLinkStatus).toBe("EXPLICIT_LINK");
      expect(record.forwardObservations).toHaveLength(1);
      expect(record.quote).toBeUndefined();
      expect(record.fill).toBeUndefined();
      expect(record.eligibility.isEligible).toBe(true);
    });

    it("RF-D1.3: preserves metric provenance and never zero-imputes placeholder or unavailable fields", () => {
      const decision = createMockDecision({
        metricsSnapshot: {
          tokenAgeSec: null,
          liquidityUsd: 0,
          marketCapUsd: 100_000,
          lmcRatio: null,
          lpBurnPct: null, // missing field
          spotPriceUsd: 0.0001,
          spotPriceSol: null,
          volume5mUsd: null,
          txCount5m: null,
          buys5m: null,
          sells5m: null,
          metricProvenance: {
            lpBurnPct: "UNAVAILABLE",
            tokenAgeSec: "PLACEHOLDER",
            volume5mUsd: "UNAVAILABLE",
          },
        },
      });

      const features = extractDecisionFeatures(decision);

      expect(features.lpBurnPct.isAvailable).toBe(false);
      expect(features.lpBurnPct.value).toBeNull();
      expect(features.lpBurnPct.provenance).toBe("UNAVAILABLE");

      expect(features.tokenAgeSec.isAvailable).toBe(false);
      expect(features.tokenAgeSec.provenance).toBe("PLACEHOLDER");

      expect(features.volume5mUsd.isAvailable).toBe(false);
      expect(features.volume5mUsd.value).toBeNull();

      expect(features.baseReserve.isAvailable).toBe(false);
      expect(features.baseReserve.unavailabilityReason).toBe(
        "NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT",
      );
    });

    it("RF-D1.4: flags AMBIGUOUS_TRAJECTORY when multiple decisions share a pool without explicit link", () => {
      const joiner = new TelemetryExecutionJoinEngine({ mode: "OBSERVATIONAL_ONLY" });
      const dec1 = createMockDecision({
        eventId: "dec-1",
        decisionTimestampMs: 1792000001000,
      });
      const dec2 = createMockDecision({
        eventId: "dec-2",
        decisionTimestampMs: 1792000010000, // 9 seconds later on the same pool
      });
      const obs = createMockObservation({
        sourceTimestampMs: 1792000060000,
      });

      const results = joiner.joinTelemetryAndExecution({
        decisions: [dec1, dec2],
        observations: [obs],
      });

      expect(results).toHaveLength(2);
      expect(results[0]!.trajectoryLinkStatus).toBe("AMBIGUOUS_TRAJECTORY");
      expect(results[1]!.trajectoryLinkStatus).toBe("AMBIGUOUS_TRAJECTORY");

      // By default, ambiguous trajectories fail closed in eligibility check
      expect(results[0]!.eligibility.isEligible).toBe(false);
      expect(results[0]!.eligibility.rejectionReasons).toContain(
        "AMBIGUOUS_TRAJECTORY_MULTIPLE_DECISIONS",
      );
    });

    it("RF-D1.5: enforces Feature Availability Boundary and rejects late-received observation from features", () => {
      const decision = createMockDecision({
        decisionTimestampMs: 1792000001000,
      });

      // An observation whose source time is before decision, but whose receipt time is AFTER decision!
      const lateObs = createMockObservation({
        sourceTimestampMs: 1792000000500, // before decision
        ingestionTimestampMs: 1792000002000, // 1000ms AFTER decision!
        responseReceivedMs: 1792000002000,
      });

      const features = extractDecisionFeatures(decision, lateObs);

      // Must be quarantined to prevent lookahead leakage!
      expect(features.baseReserve.isAvailable).toBe(false);
      expect(features.baseReserve.unavailabilityReason).toBe("LATE_RECEIPT_LOOKAHEAD_PREVENTION");
    });

    it("RF-D1.6: rejects synthetic replay when reserve snapshot is missing or post-dates decision", () => {
      const joiner = new TelemetryExecutionJoinEngine({ mode: "SYNTHETIC_REPLAY" });
      const decision = createMockDecision({
        decisionTimestampMs: 1792000001000,
      });
      // Observation is strictly after decision (forward label only)
      const forwardObs = createMockObservation({
        sourceTimestampMs: 1792000060000,
        ingestionTimestampMs: 1792000060500,
      });

      const results = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [forwardObs],
        mode: "SYNTHETIC_REPLAY",
      });

      expect(results).toHaveLength(1);
      const record = results[0]!;
      expect(record.evaluationMode).toBe("SYNTHETIC_REPLAY");
      // Fails closed: cannot replay execution without causal entry reserves
      expect(record.eligibility.isEligible).toBe(false);
      expect(
        record.eligibility.rejectionReasons.some((r) =>
          r.includes("NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT"),
        ),
      ).toBe(true);
    });
  });

  describe("RF-D2: Fail-Closed Eligibility Gating & Exact Financial Accounting", () => {
    it("RF-D2.1: fails closed when forward observation has mismatched pool ID", () => {
      const record: Omit<JoinedResearchRecord, "eligibility"> = {
        joinId: "join-test",
        sessionId: "session-test-1",
        generationId: "gen-1",
        decisionEventId: "dec-1",
        mintAddress: "TokenMint111111111111111111111111111111111111",
        poolId: "pool-tracked-alpha",
        symbol: "TEST",
        decisionTimestampMs: 1792000001000,
        sourceTimestampMs: 1792000000000,
        ingestionTimestampMs: 1792000000500,
        decisionCohort: "EXECUTED_BUY",
        strategyRevision: "strategy-v1",
        evaluationMode: "OBSERVATIONAL_ONLY",
        trajectoryLinkStatus: "EXPLICIT_LINK",
        features: extractDecisionFeatures(createMockDecision()),
        forwardObservations: [
          createMockObservation({
            poolId: "pool-tracked-alpha",
            actualResponsePoolId: "mismatched-pool-beta", // POOL MISMATCH!
          }),
        ],
      };

      const result = evaluateResearchEligibility(record);
      expect(result.isEligible).toBe(false);
      expect(
        result.rejectionReasons.some((r) => r.includes("FORWARD_OBSERVATION_POOL_MISMATCH")),
      ).toBe(true);
    });

    it("RF-D2.2: links exact StratifiedSamplingRecord and preserves sampling probability metadata", () => {
      const joiner = new TelemetryExecutionJoinEngine({ mode: "OBSERVATIONAL_ONLY" });
      const decision = createMockDecision({ eventId: "dec-strat-1" });
      const samplingRecord: StratifiedSamplingRecord = {
        trackingId: "track-1",
        sessionId: decision.sessionId,
        generationId: decision.generationId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        decisionEventId: decision.eventId,
        tier: "NEAR_MISS_CANDIDATE",
        samplingProbability: 0.125,
        effectiveInclusionProbability: 0.125,
        ipwEstimable: true,
        selectionSeed: "seed-1",
        trackingStartedMs: decision.decisionTimestampMs,
        trackingExpiresMs: decision.decisionTimestampMs + 3600_000,
        currentSamplingIntervalMs: 60_000,
        observationCount: 3,
        initialPriceSol: 0.000001,
        peakPriceSol: 0.0000015,
        peakGainPct: 50.0,
        troughPriceSol: 0.0000009,
        maxDrawdownPct: 10.0,
        latestPriceSol: 0.0000014,
        status: "TRACKING_ACTIVE",
      };

      const results = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [],
        samplingRecords: [samplingRecord],
      });

      expect(results).toHaveLength(1);
      const meta = results[0]!.samplingMetadata;
      expect(meta).toBeDefined();
      expect(meta!.trackingId).toBe("track-1");
      expect(meta!.tier).toBe("NEAR_MISS_CANDIDATE");
      expect(meta!.samplingProbability).toBe(0.125);
      expect(meta!.effectiveInclusionProbability).toBe(0.125);
      expect(meta!.ipwEstimable).toBe(true);
    });

    it("RF-D2.3: computes exact signed negative cash flow on fee-dominated dust exits without double-debiting priority fees", () => {
      // Mock a sell fill returning 1 lamport gross proceeds and 15,000 lamports network fee (5000 base + 10000 priority)
      const mockSellFill: SimulatedFillRecord = {
        fillId: "fill-dust-1",
        quoteId: "quote-dust-1",
        decisionEventId: "dec-1",
        mintAddress: "TokenMint111111111111111111111111111111111111",
        poolId: "pool-amm-1",
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: "synthetic_amm_reserve",
        side: "SELL",
        executionOutcome: "FILLED",
        attemptedSizeSol: 0.001,
        filledSizeSol: 0.0, // 12.94-C zero-clipped
        attemptedTokens: 1000,
        filledTokens: 1000,
        remainingTokens: 0,
        effectivePriceSol: 0.000000001,
        grossProceedsSol: 0.000000001, // 1 lamport gross
        netProceedsSol: 0.0, // 12.94-C clamped
        priceImpactBps: 50,
        maxSlippageBps: 200,
        realizedSlippageBps: 10,
        networkFeeLamports: 15_000, // external fee = 15,000 lamports (base + priority)
        priorityFeeLamports: 10_000, // component already inside networkFeeLamports
        ataRentDepositLamports: 0,
        ataRentRefundLamports: 0,
        sellabilityStatus: "FULLY_SELLABLE",
        fillTimestampMs: 1792000060000,
        fillSlot: 100,
        executionDelayMs: 250,
      };

      const accounting = computeResearchFinancialAccounting(mockSellFill);

      // External network fee is 15,000 lamports = 0.000015 SOL
      expect(accounting.externalNetworkFeeLamports).toBe(15_000);
      expect(accounting.externalNetworkFeeSol).toBe(0.000015);
      expect(accounting.priorityFeeLamports).toBe(10_000);

      // Signed net cash movement: 1 lamport - 15,000 lamports = -14,999 lamports = -0.000014999 SOL
      // Priority fee is NOT subtracted a second time!
      expect(accounting.signedNetCashFlowSol).toBeCloseTo(-0.000014999, 9);
      expect(accounting.isSubmarginalDust).toBe(true);
      expect(accounting.financialState).toBe("REALIZED_LIQUIDATION");
    });

    it("RF-D2.4: preserves full unsold inventory and zero network gas on PREFLIGHT_SIMULATION_REJECTED", () => {
      const mockPreflightRejectFill: SimulatedFillRecord = {
        fillId: "fill-preflight-1",
        quoteId: "quote-1",
        decisionEventId: "dec-1",
        mintAddress: "TokenMint111111111111111111111111111111111111",
        poolId: "pool-amm-1",
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: "synthetic_amm_reserve",
        side: "SELL",
        executionOutcome: "PREFLIGHT_SIMULATION_REJECTED",
        attemptedSizeSol: 0.5,
        filledSizeSol: 0,
        attemptedTokens: 50_000,
        filledTokens: 0,
        remainingTokens: 50_000, // 100% inventory preserved!
        effectivePriceSol: 0,
        grossProceedsSol: 0,
        netProceedsSol: 0,
        priceImpactBps: 3500,
        maxSlippageBps: 500,
        realizedSlippageBps: 0,
        networkFeeLamports: 0, // Preflight simulation charges zero gas
        priorityFeeLamports: 0,
        sellabilityStatus: "UNSELLABLE_EXCESSIVE_IMPACT",
        conservativeWriteDownSol: 0.5,
        fillTimestampMs: 1792000060000,
        fillSlot: 101,
        executionDelayMs: 50,
      };

      const accounting = computeResearchFinancialAccounting(mockPreflightRejectFill);
      expect(accounting.financialState).toBe("PREFLIGHT_REJECTION");
      expect(accounting.signedNetCashFlowSol).toBe(0);
      expect(accounting.unrealizedImpairmentSol).toBe(0.5);
    });

    it("RF-D2.5: rejects synthetic replay on unsupported MULTI_HOP or CROSS_POOL_DIVERGENCE quotes", () => {
      const mockMultiHopQuote: ExecutableQuoteRecord = {
        quoteId: "quote-multihop-1",
        sessionId: "session-test-1",
        generationId: "gen-1",
        decisionEventId: "dec-1",
        mintAddress: "TokenMint111111111111111111111111111111111111",
        poolId: "pool-amm-1",
        priceTier: "TIER_2_POOL_RESERVE",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        inputMint: WSOL_MINT,
        outputMint: "TokenMint111111111111111111111111111111111111",
        inAmountRaw: "100000000",
        inAmountUi: 0.1,
        expectedOutAmountRaw: "1000000000",
        expectedOutAmountUi: 1000,
        minimumOutAmountRaw: "990000000",
        minimumOutAmountUi: 990,
        priceImpactPct: 0.01,
        maxSlippageBps: 100,
        poolInternalFeeLamports: 250_000,
        poolInternalFeeSol: 0.00025,
        routeType: "MULTI_HOP", // MULTI-HOP!
        routePlan: [],
        quoteInitiatedMs: 1792000001000,
        quoteReceivedMs: 1792000001050,
        contextSlot: 100,
        validUntilMs: 1792000011000,
      };

      const record: Omit<JoinedResearchRecord, "eligibility"> = {
        joinId: "join-test",
        sessionId: "session-test-1",
        generationId: "gen-1",
        decisionEventId: "dec-1",
        mintAddress: "TokenMint111111111111111111111111111111111111",
        poolId: "pool-amm-1",
        symbol: "TEST",
        decisionTimestampMs: 1792000001000,
        sourceTimestampMs: 1792000000000,
        ingestionTimestampMs: 1792000000500,
        decisionCohort: "EXECUTED_BUY",
        strategyRevision: "strategy-v1",
        evaluationMode: "SYNTHETIC_REPLAY",
        trajectoryLinkStatus: "EXPLICIT_LINK",
        features: extractDecisionFeatures(createMockDecision()),
        quote: mockMultiHopQuote,
        forwardObservations: [],
      };

      const result = evaluateResearchEligibility(record, { mode: "SYNTHETIC_REPLAY" });
      expect(result.isEligible).toBe(false);
      expect(result.rejectionReasons).toContain("UNSUPPORTED_ROUTE_TYPE: MULTI_HOP");
    });
  });
});
