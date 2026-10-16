/**
 * Phase 12.94-D Milestone D.1 Test Suite: Quantitative Research Engine
 *
 * Verifies event-specific causal data joins, trajectory ambiguity and attribution handling,
 * anti-lookahead feature boundaries, provenance preservation, fail-closed eligibility
 * gating, exact signed BUY/SELL financial accounting, composite identity joins,
 * duplicate quarantine, session finality, and readiness audit validity.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import type {
  CandidateDecisionRecord,
  CandidateMetricsSnapshot,
  MarketObservationRecord,
  SessionTelemetryMeta,
  SessionTelemetrySummary,
  StratifiedSamplingRecord,
} from "../telemetry/TelemetryTypes.js";
import type { ExecutableQuoteRecord, SimulatedFillRecord } from "../execution/ExecutionTypes.js";
import {
  TelemetryExecutionJoinEngine,
  extractDecisionFeatures,
} from "./TelemetryExecutionJoinEngine.js";
import {
  computeResearchFinancialAccounting,
  determineSessionStatus,
  evaluateResearchEligibility,
} from "./ResearchEligibilityGate.js";
import type {
  DecisionFeatureVector,
  JoinedResearchRecord,
  ProvenanceFeature,
} from "./ResearchTypes.js";
// @ts-expect-error - audit-research-readiness is an executable ESM script outside backend/src
import { runReadinessAudit } from "../../../scripts/audit-research-readiness.mjs";
import {
  createShadowEvaluationRecord,
  validateShadowEvaluationRecord,
  validateShadowEvaluationEligibility,
} from "./ShadowEvaluationContract.js";
import { validateClockMonotonicity } from "./ClockMonotonicityValidator.js";
import {
  computeHajekMean,
  computeHorvitzThompsonTotal,
  computeTwoWayClusterCovariance,
  computeAmmRoundTripWaterfall,
} from "./StatisticalOracles.js";
import { parseFedoraArchiveDirectory } from "./FedoraArchiveParser.js";
// @ts-expect-error - audit-windows-legacy-inventory is an executable ESM script outside backend/src
import { inspectWindowsLegacySessions } from "../../../scripts/audit-windows-legacy-inventory.mjs";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

function createMockMeta(overrides: Partial<SessionTelemetryMeta> = {}): SessionTelemetryMeta {
  return {
    sessionId: "session-test-1",
    generationId: "gen-1",
    strategyRevision: "strategy-v1",
    startedAtIso: "2026-10-15T00:00:00.000Z",
    closedAtIso: "2026-10-15T01:00:00.000Z",
    initialWalletBalanceSol: 7.9259,
    environment: {
      platform: "win32",
      nodeVersion: "v20.0.0",
    },
    sessionStatus: "FINALIZED",
    isInterruptedSession: false,
    ...overrides,
  };
}

function createMockSummary(
  overrides: Partial<SessionTelemetrySummary> = {},
): SessionTelemetrySummary {
  return {
    sessionId: "session-test-1",
    generationId: "gen-1",
    strategyRevision: "strategy-v1",
    startedAtIso: "2026-10-15T00:00:00.000Z",
    closedAtIso: "2026-10-15T01:00:00.000Z",
    totalCandidatesScreened: 10,
    totalDecisionsRecorded: 1,
    decisionWriteFailures: 0,
    cohortBreakdown: {
      filteredRejected: 0,
      watchlistRadar: 0,
      triggerRejected: 0,
      executedBuy: 1,
    },
    topRejectionReasons: {},
    totalMarketObservationsRecorded: 1,
    totalStratifiedCandidatesTracked: 1,
    missedWinnersCount: 0,
    avoidedRugsCount: 0,
    isCompleteSession: true,
    isInterruptedSession: false,
    ...overrides,
  };
}

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

function createMockFeatures(overrides: Partial<DecisionFeatureVector> = {}): DecisionFeatureVector {
  const dummyFeature = (val: number | null = null): ProvenanceFeature<number> => ({
    value: val,
    provenance: val !== null ? "OBSERVED" : "UNAVAILABLE",
    isAvailable: val !== null,
  });
  return {
    tokenAgeSec: dummyFeature(100),
    liquidityUsd: dummyFeature(50000),
    marketCapUsd: dummyFeature(100000),
    lmcRatio: dummyFeature(0.5),
    lpBurnPct: dummyFeature(95.0),
    spotPriceUsd: dummyFeature(0.001),
    spotPriceSol: dummyFeature(0.00001),
    volume5mUsd: dummyFeature(25000),
    txCount5m: dummyFeature(50),
    buys5m: dummyFeature(35),
    sells5m: dummyFeature(15),
    baseReserve: dummyFeature(1000),
    quoteReserve: dummyFeature(50),
    top10ConcentrationPct: dummyFeature(20),
    devHoldingPct: dummyFeature(5),
    ...overrides,
  };
}

describe("Phase 12.94-D Milestone D.1: Quantitative Research Engine", () => {
  describe("D1-AUD-01: Observation Attribution & Positive Pool Identity Verification", () => {
    it("RF-D1.1: distinguishes UNIQUELY_INFERRED from EXPLICIT_LINK on forward observations", () => {
      const joiner = new TelemetryExecutionJoinEngine({ mode: "OBSERVATIONAL_ONLY" });
      const decision = createMockDecision();
      const meta = createMockMeta();
      const summary = createMockSummary();

      // Case A: Unlinked observation (no initiatingEventId) -> UNIQUELY_INFERRED
      const unlinkedObs = createMockObservation();
      const resA = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [unlinkedObs],
        sessionMeta: meta,
        sessionSummary: summary,
      });

      expect(resA).toHaveLength(1);
      expect(resA[0]!.trajectoryLinkStatus).toBe("UNIQUELY_INFERRED");
      expect(resA[0]!.eligibility.isEligible).toBe(true);
      expect(resA[0]!.eligibility.warnings).toContain(
        "TRAJECTORY_UNIQUELY_INFERRED: outcome linked by unique pool candidate without explicit initiating ID",
      );

      // Case B: Explicitly linked observation (has initiatingEventId) -> EXPLICIT_LINK
      const explicitObs = {
        ...createMockObservation(),
        initiatingEventId: decision.eventId,
      };
      const resB = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [explicitObs as unknown as MarketObservationRecord],
        sessionMeta: meta,
        sessionSummary: summary,
      });

      expect(resB).toHaveLength(1);
      expect(resB[0]!.trajectoryLinkStatus).toBe("EXPLICIT_LINK");
      expect(resB[0]!.eligibility.isEligible).toBe(true);
    });

    it("RF-D1.2: fails closed when forward observation has missing actualResponsePoolId", () => {
      const decision = createMockDecision();
      const obsMissingPool = createMockObservation({
        actualResponsePoolId: undefined, // Missing!
      });

      const joiner = new TelemetryExecutionJoinEngine({ mode: "OBSERVATIONAL_ONLY" });
      const results = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [obsMissingPool],
        sessionMeta: createMockMeta(),
        sessionSummary: createMockSummary(),
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.eligibility.isEligible).toBe(false);
      expect(
        results[0]!.eligibility.rejectionReasons.some((r) =>
          r.includes("FORWARD_OBSERVATION_POOL_UNVERIFIED"),
        ),
      ).toBe(true);
    });

    it("RF-D1.3: rejects pre-decision snapshot with wrong actualResponsePoolId and discards reserves", () => {
      const decision = createMockDecision({
        decisionTimestampMs: 1792000001000,
      });

      // Pre-decision observation with wrong pool ID!
      const wrongPoolPreDecisionObs = createMockObservation({
        poolId: decision.poolId,
        actualResponsePoolId: "mismatched-pool-beta", // WRONG POOL!
        sourceTimestampMs: 1792000000500,
        ingestionTimestampMs: 1792000000800,
        responseReceivedMs: 1792000000800,
      });

      const features = extractDecisionFeatures(decision, wrongPoolPreDecisionObs);
      expect(features.baseReserve.isAvailable).toBe(false);
      expect(features.baseReserve.unavailabilityReason).toBe("POOL_IDENTITY_MISMATCH_DISCARDED");
      expect(features.quoteReserve.isAvailable).toBe(false);

      const joiner = new TelemetryExecutionJoinEngine({ mode: "SYNTHETIC_REPLAY" });
      const results = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [wrongPoolPreDecisionObs],
        sessionMeta: createMockMeta(),
        sessionSummary: createMockSummary(),
        mode: "SYNTHETIC_REPLAY",
      });

      expect(results[0]!.eligibility.isEligible).toBe(false);
      expect(
        results[0]!.eligibility.rejectionReasons.some((r) =>
          r.includes("NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT"),
        ),
      ).toBe(true);
    });

    it("RF-D1.4: groups observations and decisions with generationId to prevent cross-generation conflation", () => {
      const joiner = new TelemetryExecutionJoinEngine({ mode: "OBSERVATIONAL_ONLY" });
      const decGen1 = createMockDecision({
        eventId: "dec-gen-1",
        generationId: "gen-1",
        decisionTimestampMs: 1792000001000,
      });
      const decGen2 = createMockDecision({
        eventId: "dec-gen-2",
        generationId: "gen-2", // DIFFERENT GENERATION!
        decisionTimestampMs: 1792000002000,
      });

      const obsGen1 = createMockObservation({
        generationId: "gen-1",
        sourceTimestampMs: 1792000060000,
      });

      const results = joiner.joinTelemetryAndExecution({
        decisions: [decGen1, decGen2],
        observations: [obsGen1],
        allowUnfinalizedSession: true,
      });

      expect(results).toHaveLength(2);
      // Gen 1 has the observation
      expect(results[0]!.generationId).toBe("gen-1");
      expect(results[0]!.trajectoryLinkStatus).toBe("UNIQUELY_INFERRED");
      expect(results[0]!.forwardObservations).toHaveLength(1);

      // Gen 2 must NOT conflate Gen 1's observation!
      expect(results[1]!.generationId).toBe("gen-2");
      expect(results[1]!.trajectoryLinkStatus).toBe("NO_OBSERVATIONS_FOUND");
      expect(results[1]!.forwardObservations).toHaveLength(0);
    });

    it("RF-D1.5: flags AMBIGUOUS_TRAJECTORY and fails closed when multiple decisions share a pool without explicit link", () => {
      const joiner = new TelemetryExecutionJoinEngine({ mode: "OBSERVATIONAL_ONLY" });
      const dec1 = createMockDecision({
        eventId: "dec-same-1",
        decisionTimestampMs: 1792000001000,
      });
      const dec2 = createMockDecision({
        eventId: "dec-same-2",
        decisionTimestampMs: 1792000005000, // 4 seconds later on same pool
      });
      const obs = createMockObservation({
        sourceTimestampMs: 1792000060000,
      });

      const results = joiner.joinTelemetryAndExecution({
        decisions: [dec1, dec2],
        observations: [obs],
        sessionMeta: createMockMeta(),
        sessionSummary: createMockSummary({ totalDecisionsRecorded: 2 }),
      });

      expect(results).toHaveLength(2);
      expect(results[0]!.trajectoryLinkStatus).toBe("AMBIGUOUS_TRAJECTORY");
      expect(results[1]!.trajectoryLinkStatus).toBe("AMBIGUOUS_TRAJECTORY");
      expect(results[0]!.eligibility.isEligible).toBe(false);
      expect(results[0]!.eligibility.rejectionReasons).toContain(
        "AMBIGUOUS_TRAJECTORY_MULTIPLE_DECISIONS: multiple decisions share this pool without explicit link",
      );
    });

    it("RF-D1.6: preserves metric provenance and never zero-imputes placeholder or unavailable fields", () => {
      const decision = createMockDecision({
        metricsSnapshot: {
          tokenAgeSec: null,
          liquidityUsd: 0,
          marketCapUsd: 100_000,
          lmcRatio: null,
          lpBurnPct: null,
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
  });

  describe("D1-AUD-02: Composite Joins, Duplicate Quarantine & Session Finality", () => {
    it("RF-D2.1: rejects cross-session quote linkage and verifies composite identity", () => {
      const joiner = new TelemetryExecutionJoinEngine({ mode: "SYNTHETIC_REPLAY" });
      const decision = createMockDecision({
        sessionId: "session-valid",
        eventId: "dec-target-1",
      });

      // Quote has the target decisionEventId, but sessionId is 'EVIL'!
      const crossSessionQuote: ExecutableQuoteRecord = {
        quoteId: "quote-evil-1",
        sessionId: "session-EVIL", // CROSS-SESSION!
        generationId: decision.generationId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_2_POOL_RESERVE",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        inputMint: WSOL_MINT,
        outputMint: decision.mintAddress,
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
        routeType: "DIRECT_TRACKED_POOL",
        routePlan: [],
        quoteInitiatedMs: 1792000001000,
        quoteReceivedMs: 1792000001050,
        contextSlot: 100,
        validUntilMs: 1792000011000,
      };

      const results = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [],
        quotes: [crossSessionQuote],
        allowUnfinalizedSession: true,
        mode: "SYNTHETIC_REPLAY",
      });

      expect(results).toHaveLength(1);
      // Quote must NOT be attached to the valid decision!
      expect(results[0]!.quote).toBeUndefined();
      expect(results[0]!.eligibility.isEligible).toBe(false);
      expect(results[0]!.eligibility.rejectionReasons).toContain(
        "SYNTHETIC_REPLAY_MISSING_QUOTE: synthetic replay requires an executable quote record",
      );
    });

    it("RF-D2.2: quarantines duplicate quote identities instead of silently overwriting", () => {
      const joiner = new TelemetryExecutionJoinEngine({ mode: "OBSERVATIONAL_ONLY" });
      const decision = createMockDecision({ eventId: "dec-dup-1" });

      const quoteA: ExecutableQuoteRecord = {
        quoteId: "quote-A",
        sessionId: decision.sessionId,
        generationId: decision.generationId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_2_POOL_RESERVE",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        inputMint: WSOL_MINT,
        outputMint: decision.mintAddress,
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
        routeType: "DIRECT_TRACKED_POOL",
        routePlan: [],
        quoteInitiatedMs: 1792000001000,
        quoteReceivedMs: 1792000001050,
        contextSlot: 100,
        validUntilMs: 1792000011000,
      };

      const quoteB: ExecutableQuoteRecord = {
        ...quoteA,
        quoteId: "quote-B-DUPLICATE",
      };

      const results = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [],
        quotes: [quoteA, quoteB], // DUPLICATE ON SAME COMPOSITE KEY!
        allowUnfinalizedSession: true,
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.isDuplicateQuarantined).toBe(true);
      expect(results[0]!.quote).toBeUndefined(); // Quarantined
      expect(results[0]!.eligibility.isEligible).toBe(false);
      expect(
        results[0]!.eligibility.rejectionReasons.some((r) =>
          r.includes("DUPLICATE_IDENTITY_QUARANTINED"),
        ),
      ).toBe(true);
    });

    it("RF-D2.3: enforces session finality and rejects unfinalized or interrupted sessions", () => {
      const joiner = new TelemetryExecutionJoinEngine({ mode: "OBSERVATIONAL_ONLY" });
      const decision = createMockDecision();

      // Case 1: No session metadata provided -> fails closed
      const res1 = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [],
      });
      expect(res1[0]!.eligibility.isEligible).toBe(false);
      expect(
        res1[0]!.eligibility.rejectionReasons.some((r) =>
          r.includes("SESSION_INTERRUPTED_OR_UNFINALIZED"),
        ),
      ).toBe(true);

      // Case 2: Interrupted session -> fails closed
      const interruptedMeta = createMockMeta({ isInterruptedSession: true });
      const interruptedSummary = createMockSummary({
        isInterruptedSession: true,
        isCompleteSession: false,
      });
      const res2 = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [],
        sessionMeta: interruptedMeta,
        sessionSummary: interruptedSummary,
      });
      expect(res2[0]!.sessionStatus).toBe("INTERRUPTED");
      expect(res2[0]!.eligibility.isEligible).toBe(false);

      // Case 3: Exploratory override -> allows unfinalized session with warning
      const res3 = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [],
        allowUnfinalizedSession: true,
      });
      expect(res3[0]!.eligibility.isEligible).toBe(true);
      expect(
        res3[0]!.eligibility.warnings.some((w) =>
          w.includes("OBSERVATIONAL_EXPLORATION_UNFINALIZED_SESSION"),
        ),
      ).toBe(true);
    });

    it("RF-D2.4: verifies full shared composite identities and causal order across quote and fill in SYNTHETIC_REPLAY", () => {
      const decision = createMockDecision();
      const preObs = createMockObservation({
        sourceTimestampMs: 1792000000500,
        ingestionTimestampMs: 1792000000800,
        responseReceivedMs: 1792000000800,
      });

      const validQuote: ExecutableQuoteRecord = {
        quoteId: "quote-1",
        sessionId: decision.sessionId,
        generationId: decision.generationId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_2_POOL_RESERVE",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        inputMint: WSOL_MINT,
        outputMint: decision.mintAddress,
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
        routeType: "DIRECT_TRACKED_POOL",
        routePlan: [],
        quoteInitiatedMs: 1792000001000,
        quoteReceivedMs: 1792000001050,
        contextSlot: 100,
        validUntilMs: 1792000011000,
      };

      // Fill whose timestamp is BEFORE quote initiated time (causal time inversion!)
      const invertedFill: SimulatedFillRecord = {
        fillId: "fill-inverted",
        quoteId: validQuote.quoteId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        executionOutcome: "FILLED",
        attemptedSizeSol: 0.1,
        filledSizeSol: 0.1,
        attemptedTokens: 1000,
        filledTokens: 1000,
        remainingTokens: 0,
        effectivePriceSol: 0.0001,
        grossProceedsSol: 0,
        netProceedsSol: 0,
        priceImpactBps: 10,
        maxSlippageBps: 100,
        realizedSlippageBps: 2,
        networkFeeLamports: 15_000,
        priorityFeeLamports: 10_000,
        ataRentDepositLamports: 0,
        ataRentRefundLamports: 0,
        sellabilityStatus: "FULLY_SELLABLE",
        fillTimestampMs: 1792000000900, // BEFORE quote initiation (1792000001000)!
        fillSlot: 100,
        executionDelayMs: 50,
      };

      const joiner = new TelemetryExecutionJoinEngine({ mode: "SYNTHETIC_REPLAY" });
      const results = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [preObs],
        quotes: [validQuote],
        fills: [invertedFill],
        sessionMeta: createMockMeta(),
        sessionSummary: createMockSummary(),
        mode: "SYNTHETIC_REPLAY",
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.eligibility.isEligible).toBe(false);
      expect(
        results[0]!.eligibility.rejectionReasons.some((r) =>
          r.includes("FILL_CAUSAL_TIME_INVERSION"),
        ),
      ).toBe(true);
    });

    it("RF-D2.5: links exact StratifiedSamplingRecord and preserves sampling probability metadata", () => {
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
        allowUnfinalizedSession: true,
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

    it("RF-D2.6: quarantines duplicate fill records on the same quote composite key", () => {
      const joiner = new TelemetryExecutionJoinEngine({ mode: "SYNTHETIC_REPLAY" });
      const decision = createMockDecision({ eventId: "dec-dup-fill" });
      const preObs = createMockObservation({
        sourceTimestampMs: 1792000000500,
        ingestionTimestampMs: 1792000000800,
        responseReceivedMs: 1792000000800,
      });

      const quote: ExecutableQuoteRecord = {
        quoteId: "quote-fill-dup",
        sessionId: decision.sessionId,
        generationId: decision.generationId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_2_POOL_RESERVE",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        inputMint: WSOL_MINT,
        outputMint: decision.mintAddress,
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
        routeType: "DIRECT_TRACKED_POOL",
        routePlan: [],
        quoteInitiatedMs: 1792000001000,
        quoteReceivedMs: 1792000001050,
        contextSlot: 100,
        validUntilMs: 1792000011000,
      };

      const fillA: SimulatedFillRecord = {
        fillId: "fill-A",
        quoteId: quote.quoteId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        executionOutcome: "FILLED",
        attemptedSizeSol: 0.1,
        filledSizeSol: 0.1,
        attemptedTokens: 1000,
        filledTokens: 1000,
        remainingTokens: 0,
        effectivePriceSol: 0.0001,
        grossProceedsSol: 0,
        netProceedsSol: 0,
        priceImpactBps: 10,
        maxSlippageBps: 100,
        realizedSlippageBps: 2,
        networkFeeLamports: 15_000,
        priorityFeeLamports: 10_000,
        ataRentDepositLamports: 0,
        ataRentRefundLamports: 0,
        sellabilityStatus: "FULLY_SELLABLE",
        fillTimestampMs: 1792000001100,
        fillSlot: 100,
        executionDelayMs: 50,
      };

      const fillB: SimulatedFillRecord = {
        ...fillA,
        fillId: "fill-B-DUPLICATE",
      };

      const results = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [preObs],
        quotes: [quote],
        fills: [fillA, fillB], // DUPLICATE FILL!
        sessionMeta: createMockMeta(),
        sessionSummary: createMockSummary(),
        mode: "SYNTHETIC_REPLAY",
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.isDuplicateQuarantined).toBe(true);
      expect(results[0]!.fill).toBeUndefined(); // Quarantined
      expect(results[0]!.eligibility.isEligible).toBe(false);
      expect(
        results[0]!.eligibility.rejectionReasons.some((r) =>
          r.includes("DUPLICATE_IDENTITY_QUARANTINED"),
        ),
      ).toBe(true);
    });

    it("RF-D2.7: determines session status correctly from meta and summary", () => {
      expect(determineSessionStatus(null, null)).toBe("UNFINALIZED");
      expect(
        determineSessionStatus(createMockMeta({ isInterruptedSession: true }), createMockSummary()),
      ).toBe("INTERRUPTED");
      expect(determineSessionStatus(createMockMeta(), createMockSummary())).toBe("FINALIZED");
    });
  });

  describe("D1-AUD-03: Temporal Causality & Anti-Lookahead Boundaries", () => {
    it("RF-D3.1: rejects decision lookahead when ingestionTimestampMs > decisionTimestampMs", () => {
      const decision = createMockDecision({
        decisionTimestampMs: 1792000001000,
        sourceTimestampMs: 1792000000000,
        ingestionTimestampMs: 1792000002000, // 1000ms AFTER decision!
      });

      const features = extractDecisionFeatures(decision);
      // All decision features must be marked unavailable
      expect(features.liquidityUsd.isAvailable).toBe(false);
      expect(features.liquidityUsd.unavailabilityReason).toBe("LATE_RECEIPT_LOOKAHEAD_PREVENTION");
      expect(features.marketCapUsd.isAvailable).toBe(false);

      const record: Omit<JoinedResearchRecord, "eligibility"> = {
        joinId: "join-test",
        sessionId: decision.sessionId,
        generationId: decision.generationId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        symbol: decision.symbol,
        decisionTimestampMs: decision.decisionTimestampMs,
        sourceTimestampMs: decision.sourceTimestampMs,
        ingestionTimestampMs: decision.ingestionTimestampMs,
        decisionCohort: decision.decisionCohort,
        strategyRevision: decision.strategyRevision,
        evaluationMode: "OBSERVATIONAL_ONLY",
        trajectoryLinkStatus: "NO_OBSERVATIONS_FOUND",
        sessionStatus: "FINALIZED",
        features,
        forwardObservations: [],
      };

      const eligibility = evaluateResearchEligibility(record, { allowUnfinalizedSession: true });
      expect(eligibility.isEligible).toBe(false);
      expect(
        eligibility.rejectionReasons.some((r) => r.includes("DECISION_LOOKAHEAD_LEAKAGE")),
      ).toBe(true);
    });

    it("RF-D3.2: rejects decision with impossible negative ingestion lag", () => {
      const decision = createMockDecision({
        sourceTimestampMs: 1792000005000,
        ingestionTimestampMs: 1792000001000, // -4000ms lag! Inverted timestamps!
        decisionTimestampMs: 1792000006000,
      });

      const features = extractDecisionFeatures(decision);
      expect(features.liquidityUsd.isAvailable).toBe(false);
      expect(features.liquidityUsd.unavailabilityReason).toBe("IMPOSSIBLE_TIMESTAMP_ORDERING");

      const record: Omit<JoinedResearchRecord, "eligibility"> = {
        joinId: "join-test",
        sessionId: decision.sessionId,
        generationId: decision.generationId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        symbol: decision.symbol,
        decisionTimestampMs: decision.decisionTimestampMs,
        sourceTimestampMs: decision.sourceTimestampMs,
        ingestionTimestampMs: decision.ingestionTimestampMs,
        decisionCohort: decision.decisionCohort,
        strategyRevision: decision.strategyRevision,
        evaluationMode: "OBSERVATIONAL_ONLY",
        trajectoryLinkStatus: "NO_OBSERVATIONS_FOUND",
        sessionStatus: "FINALIZED",
        features,
        forwardObservations: [],
      };

      const eligibility = evaluateResearchEligibility(record, { allowUnfinalizedSession: true });
      expect(eligibility.isEligible).toBe(false);
      expect(
        eligibility.rejectionReasons.some((r) => r.includes("IMPOSSIBLE_TIMESTAMP_ORDERING")),
      ).toBe(true);
    });

    it("RF-D3.3: fails closed on stale forward observation exceeding MAX_DATA_FRESHNESS", () => {
      const staleObs = createMockObservation({
        dataFreshnessMs: 250_000, // 250s exceeds 180s limit!
      });

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
        evaluationMode: "OBSERVATIONAL_ONLY",
        trajectoryLinkStatus: "UNIQUELY_INFERRED",
        sessionStatus: "FINALIZED",
        features: extractDecisionFeatures(createMockDecision()),
        forwardObservations: [staleObs],
      };

      const result = evaluateResearchEligibility(record, { allowUnfinalizedSession: true });
      expect(result.isEligible).toBe(false);
      expect(result.rejectionReasons.some((r) => r.includes("FORWARD_OBSERVATION_STALE"))).toBe(
        true,
      );
    });
  });

  describe("D1-AUD-04: BUY/SELL Financial Accounting Symmetry", () => {
    it("RF-D4.1: computes signed negative cash flow and OPEN_POSITION state on successful BUY", () => {
      const mockBuyFill: SimulatedFillRecord = {
        fillId: "fill-buy-1",
        quoteId: "quote-buy-1",
        decisionEventId: "dec-1",
        mintAddress: "TokenMint111111111111111111111111111111111111",
        poolId: "pool-amm-1",
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        executionOutcome: "FILLED",
        attemptedSizeSol: 0.5,
        filledSizeSol: 0.5,
        attemptedTokens: 500_000,
        filledTokens: 500_000,
        remainingTokens: 500_000,
        effectivePriceSol: 0.000001,
        grossProceedsSol: 0,
        netProceedsSol: 0,
        priceImpactBps: 25,
        maxSlippageBps: 100,
        realizedSlippageBps: 5,
        networkFeeLamports: 15_000,
        priorityFeeLamports: 10_000,
        ataRentDepositLamports: 2_039_280,
        ataRentRefundLamports: 0,
        sellabilityStatus: "FULLY_SELLABLE",
        fillTimestampMs: 1792000001100,
        fillSlot: 100,
        executionDelayMs: 100,
      };

      const accounting = computeResearchFinancialAccounting(mockBuyFill);

      expect(accounting.side).toBe("BUY");
      expect(accounting.financialState).toBe("OPEN_POSITION");
      // 0.5 SOL = 500,000,000 lamports. Total debit = 500,000,000 + 15,000 + 2,039,280 = 502,054,280 lamports
      expect(accounting.signedNetCashFlowLamports).toBe(-502054280n);
      expect(accounting.signedNetCashFlowSol).toBeCloseTo(-0.50205428, 8);
      expect(accounting.capitalTiedUpSol).toBeCloseTo(0.50203928, 8);
    });

    it("RF-D4.2: computes zero cash debit on PREFLIGHT_SIMULATION_REJECTED BUY", () => {
      const mockPreflightBuyFill: SimulatedFillRecord = {
        fillId: "fill-buy-reject",
        quoteId: "quote-1",
        decisionEventId: "dec-1",
        mintAddress: "TokenMint111111111111111111111111111111111111",
        poolId: "pool-amm-1",
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        executionOutcome: "PREFLIGHT_SIMULATION_REJECTED",
        attemptedSizeSol: 0.5,
        filledSizeSol: 0,
        attemptedTokens: 500_000,
        filledTokens: 0,
        remainingTokens: 0,
        effectivePriceSol: 0,
        grossProceedsSol: 0,
        netProceedsSol: 0,
        priceImpactBps: 0,
        maxSlippageBps: 100,
        realizedSlippageBps: 0,
        networkFeeLamports: 0,
        priorityFeeLamports: 0,
        sellabilityStatus: "UNSELLABLE_NO_ROUTE",
        fillTimestampMs: 1792000001100,
        fillSlot: 100,
        executionDelayMs: 50,
      };

      const accounting = computeResearchFinancialAccounting(mockPreflightBuyFill);
      expect(accounting.financialState).toBe("PREFLIGHT_REJECTION");
      expect(accounting.signedNetCashFlowLamports).toBe(0n);
      expect(accounting.signedNetCashFlowSol).toBe(0);
    });

    it("RF-D4.3: does not infer SELL cost basis from token quantity", () => {
      const mockSellFill: SimulatedFillRecord = {
        fillId: "fill-sell-1",
        quoteId: "quote-sell-1",
        decisionEventId: "dec-1",
        mintAddress: "TokenMint111111111111111111111111111111111111",
        poolId: "pool-amm-1",
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: "synthetic_amm_reserve",
        side: "SELL",
        executionOutcome: "FILLED",
        attemptedSizeSol: 0,
        filledSizeSol: 0,
        attemptedTokens: 1000,
        filledTokens: 1000,
        remainingTokens: 0,
        effectivePriceSol: 0.0001,
        grossProceedsSol: 0.1,
        netProceedsSol: 0.1,
        priceImpactBps: 10,
        maxSlippageBps: 100,
        realizedSlippageBps: 2,
        networkFeeLamports: 15_000,
        priorityFeeLamports: 10_000,
        ataRentDepositLamports: 0,
        ataRentRefundLamports: 2_039_280,
        sellabilityStatus: "FULLY_SELLABLE",
        fillTimestampMs: 1792000060000,
        fillSlot: 101,
        executionDelayMs: 100,
      };

      const quote: ExecutableQuoteRecord = {
        quoteId: "quote-sell-1",
        sessionId: "session-test-1",
        generationId: "gen-1",
        decisionEventId: "dec-1",
        mintAddress: "TokenMint111111111111111111111111111111111111",
        poolId: "pool-amm-1",
        priceTier: "TIER_2_POOL_RESERVE",
        providerIdentity: "synthetic_amm_reserve",
        side: "SELL",
        inputMint: "TokenMint111111111111111111111111111111111111",
        outputMint: WSOL_MINT,
        inAmountRaw: "1000000000",
        inAmountUi: 1000, // 1000 TOKENS!
        expectedOutAmountRaw: "100000000",
        expectedOutAmountUi: 0.1,
        minimumOutAmountRaw: "99000000",
        minimumOutAmountUi: 0.099,
        priceImpactPct: 0.01,
        maxSlippageBps: 100,
        poolInternalFeeLamports: 250_000,
        poolInternalFeeSol: 0.00025,
        routeType: "DIRECT_TRACKED_POOL",
        routePlan: [],
        quoteInitiatedMs: 1792000060000,
        quoteReceivedMs: 1792000060050,
        contextSlot: 101,
        validUntilMs: 1792000070000,
      };

      // Called without initialTotalOutlaySol option
      const accounting = computeResearchFinancialAccounting(mockSellFill, quote);
      expect(accounting.side).toBe("SELL");
      // capitalTiedUpSol must be undefined, NEVER 1000 SOL!
      expect(accounting.capitalTiedUpSol).toBeUndefined();
    });

    it("RF-D4.4: executes complete Buy / Hold / Sell cash-and-inventory waterfall", () => {
      // 1. BUY: 0.1 SOL outlay, 15k fee, 2,039,280 ATA deposit -> 100,000 tokens
      const buyFill: SimulatedFillRecord = {
        fillId: "fill-buy",
        quoteId: "quote-buy",
        decisionEventId: "dec-buy",
        mintAddress: "TokenMint111111111111111111111111111111111111",
        poolId: "pool-amm-1",
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        executionOutcome: "FILLED",
        attemptedSizeSol: 0.1,
        filledSizeSol: 0.1,
        attemptedTokens: 100_000,
        filledTokens: 100_000,
        remainingTokens: 100_000,
        effectivePriceSol: 0.000001,
        grossProceedsSol: 0,
        netProceedsSol: 0,
        priceImpactBps: 10,
        maxSlippageBps: 100,
        realizedSlippageBps: 2,
        networkFeeLamports: 15_000,
        priorityFeeLamports: 10_000,
        ataRentDepositLamports: 2_039_280,
        ataRentRefundLamports: 0,
        sellabilityStatus: "FULLY_SELLABLE",
        fillTimestampMs: 1792000001000,
        fillSlot: 100,
        executionDelayMs: 50,
      };

      const buyAccounting = computeResearchFinancialAccounting(buyFill);
      expect(buyAccounting.financialState).toBe("OPEN_POSITION");
      expect(buyAccounting.signedNetCashFlowSol).toBeCloseTo(-0.10205428, 8);

      // 2. SELL: sell all 100,000 tokens for 0.15 SOL gross, 15k fee, ATA refund credit 2,039,280 lamports
      const sellFill: SimulatedFillRecord = {
        fillId: "fill-sell",
        quoteId: "quote-sell",
        decisionEventId: "dec-sell",
        mintAddress: "TokenMint111111111111111111111111111111111111",
        poolId: "pool-amm-1",
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: "synthetic_amm_reserve",
        side: "SELL",
        executionOutcome: "FILLED",
        attemptedSizeSol: 0,
        filledSizeSol: 0,
        attemptedTokens: 100_000,
        filledTokens: 100_000,
        remainingTokens: 0, // 100% liquidated
        effectivePriceSol: 0.0000015,
        grossProceedsSol: 0.15,
        netProceedsSol: 0.15,
        priceImpactBps: 15,
        maxSlippageBps: 100,
        realizedSlippageBps: 3,
        networkFeeLamports: 15_000,
        priorityFeeLamports: 10_000,
        ataRentDepositLamports: 0,
        ataRentRefundLamports: 2_039_280, // ATA REFUND CREDIT!
        sellabilityStatus: "FULLY_SELLABLE",
        fillTimestampMs: 1792000060000,
        fillSlot: 105,
        executionDelayMs: 50,
      };

      const sellAccounting = computeResearchFinancialAccounting(sellFill, undefined, {
        initialTotalOutlaySol: Math.abs(buyAccounting.signedNetCashFlowSol),
      });

      expect(sellAccounting.financialState).toBe("REALIZED_LIQUIDATION");
      // Gross 0.15 SOL = 150,000,000 lamports - 15,000 lamports fee + 2,039,280 lamports ATA refund = +152,024,280 lamports
      expect(sellAccounting.signedNetCashFlowLamports).toBe(152024280n);
      expect(sellAccounting.signedNetCashFlowSol).toBeCloseTo(0.15202428, 8);

      // Total round-trip cash movement: -0.10205428 + 0.15202428 = +0.04997000 SOL
      const roundTripSol = buyAccounting.signedNetCashFlowSol + sellAccounting.signedNetCashFlowSol;
      expect(roundTripSol).toBeCloseTo(0.04997, 8);
    });

    it("RF-D4.5: preserves signed negative cash flow in atomic lamports on fee-dominated dust exits", () => {
      const mockDustFill: SimulatedFillRecord = {
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
        filledSizeSol: 0.0,
        attemptedTokens: 1000,
        filledTokens: 1000,
        remainingTokens: 0,
        effectivePriceSol: 0.000000001,
        grossProceedsSol: 0.000000001, // 1 lamport gross proceeds
        netProceedsSol: 0.0,
        priceImpactBps: 50,
        maxSlippageBps: 200,
        realizedSlippageBps: 10,
        networkFeeLamports: 15_000, // 15,000 lamports fee
        priorityFeeLamports: 10_000,
        ataRentDepositLamports: 0,
        ataRentRefundLamports: 0,
        sellabilityStatus: "FULLY_SELLABLE",
        fillTimestampMs: 1792000060000,
        fillSlot: 100,
        executionDelayMs: 250,
      };

      const accounting = computeResearchFinancialAccounting(mockDustFill);

      expect(accounting.isSubmarginalDust).toBe(true);
      expect(accounting.financialState).toBe("REALIZED_LIQUIDATION");
      // 1 lamport - 15,000 lamports = -14,999 lamports
      expect(accounting.signedNetCashFlowLamports).toBe(-14999n);
      expect(accounting.signedNetCashFlowSol).toBeCloseTo(-0.000014999, 9);
    });
  });

  describe("D1-AUD-05: Readiness Audit Validity on Synthetic Filesystem Fixture", () => {
    it("RF-D5.1: does not falsely claim feasibility on placeholder or unverified data in audit script", () => {
      // Recreate auditor's exact reproduction scenario in an isolated temporary directory
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-readiness-test-"));
      const tempTelemetryDir = path.join(tempDir, "telemetry", "sessions");
      const tempLegacyDir = path.join(tempDir, "sessions");
      const sessionDir = path.join(tempTelemetryDir, "test-session-1");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.mkdirSync(tempLegacyDir, { recursive: true });

      const reportPath = path.join(tempDir, "AUDIT_REPORT.md");

      // 1. Candidate decision with liquidityUsd = 0 (PLACEHOLDER), buys5m = 10 (no sells or volume)
      const decisionRecord: CandidateDecisionRecord = {
        eventId: "dec-1",
        sessionId: "test-session-1",
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
        metricsSnapshot: {
          tokenAgeSec: 100,
          liquidityUsd: 0,
          marketCapUsd: 10_000,
          lmcRatio: 0.1,
          lpBurnPct: null,
          spotPriceUsd: 0.0001,
          spotPriceSol: 0.000001,
          volume5mUsd: null, // MISSING
          txCount5m: null,
          buys5m: 10,
          sells5m: null, // MISSING (no co-occurrence)
          metricProvenance: {
            liquidityUsd: "PLACEHOLDER", // PLACEHOLDER!
          },
        },
        missingFields: [],
        providerIdentity: "dexscreener",
      };
      fs.writeFileSync(
        path.join(sessionDir, "candidate-decisions.jsonl"),
        JSON.stringify(decisionRecord) + "\n",
      );

      // 2. Mismatched-pool FUTURE reserve observation (should NOT trigger H1 or verified pool)
      const futureObs = {
        observationId: "obs-future",
        sessionId: "test-session-1",
        generationId: "gen-1",
        mintAddress: "TokenMint111111111111111111111111111111111111",
        poolId: "pool-amm-1",
        actualResponsePoolId: "mismatched-pool-999", // MISMATCHED POOL!
        sourceTimestampMs: 1792000060000, // FUTURE (post-decision)
        ingestionTimestampMs: 1792000060200,
        responseReceivedMs: 1792000060200,
        dataFreshnessMs: 500,
        liquidityMetrics: {
          baseReserve: 100000,
          quoteReserve: 10,
          liquidityUsd: 5000,
        },
        missingFields: [],
        strategyRevision: "strategy-v1",
      };
      fs.writeFileSync(
        path.join(sessionDir, "market-observations.jsonl"),
        JSON.stringify(futureObs) + "\n",
      );

      // 3. Deliberately malformed fill line
      fs.writeFileSync(
        path.join(sessionDir, "simulated-fills.jsonl"),
        "{ invalid json corruption line\n",
      );

      // Run readiness audit against this fixture
      const auditResult = runReadinessAudit({
        rootDir: tempDir,
        telemetrySessionsDir: tempTelemetryDir,
        legacySessionsDir: tempLegacyDir,
        reportOutputPath: reportPath,
      });

      // Assertions matching Auditor D1-AUD-05 requirements:
      // 1. PLACEHOLDER liquidityUsd is NOT counted as available
      // 2. observationsWithVerifiedPool is 0
      expect(auditResult.observationsWithVerifiedPool).toBe(0);
      // 3. decisionsWithUsablePreDecisionReserves is 0
      expect(auditResult.decisionsWithUsablePreDecisionReserves).toBe(0);
      // 4. H1, H2, H3, H4 are all INELIGIBLE (no false FEASIBLE claims!)
      expect(auditResult.h1Feasible).toBe(false);
      expect(auditResult.h2Feasible).toBe(false);
      expect(auditResult.h3Feasible).toBe(false);
      expect(auditResult.h4Feasible).toBe(false);
      // 5. Malformed record is recorded
      expect(auditResult.totalMalformedRecordsCount).toBe(1);
      // 6. Overall status remains INSUFFICIENT_EVIDENCE
      expect(auditResult.overallReadinessStatus).toContain("INSUFFICIENT_EVIDENCE");

      // Clean up fixture
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("D1C-01: Authoritative Session Finality & Contradictory Metadata Rejection", () => {
    it("RF-D1C.1: rejects contradictory metadata where meta is UNFINALIZED but summary is complete", () => {
      const meta = createMockMeta({
        sessionStatus: "UNFINALIZED" as unknown as SessionTelemetryMeta["sessionStatus"],
        isInterruptedSession: false,
      });
      const summary = createMockSummary({
        isCompleteSession: true,
        isInterruptedSession: false,
        closedAtIso: "2026-10-15T01:00:00.000Z",
      });

      expect(determineSessionStatus(meta, summary)).toBe("UNFINALIZED");
    });

    it("RF-D1C.2: marks session INTERRUPTED if either meta or summary has interruption signals", () => {
      const metaInterrupted = createMockMeta({
        sessionStatus: "FINALIZED",
        isInterruptedSession: true,
      });
      const summaryClean = createMockSummary({
        isCompleteSession: true,
        isInterruptedSession: false,
      });
      expect(determineSessionStatus(metaInterrupted, summaryClean)).toBe("INTERRUPTED");

      const metaClean = createMockMeta({
        sessionStatus: "FINALIZED",
        isInterruptedSession: false,
      });
      const summaryInterrupted = createMockSummary({
        isCompleteSession: false,
        isInterruptedSession: true,
      });
      expect(determineSessionStatus(metaClean, summaryInterrupted)).toBe("INTERRUPTED");
    });

    it("RF-D1C.3: fails closed as UNFINALIZED if session identities, generation, or revisions mismatch", () => {
      const meta = createMockMeta({ sessionId: "session-alpha" });
      const summary = createMockSummary({ sessionId: "session-beta" });
      expect(determineSessionStatus(meta, summary)).toBe("UNFINALIZED");
    });

    it("RF-D1C.4: returns FINALIZED only when meta and summary affirmatively agree", () => {
      const meta = createMockMeta({
        sessionStatus: "FINALIZED",
        isInterruptedSession: false,
      });
      const summary = createMockSummary({
        isCompleteSession: true,
        isInterruptedSession: false,
        closedAtIso: "2026-10-15T01:00:00.000Z",
      });
      expect(determineSessionStatus(meta, summary)).toBe("FINALIZED");
    });
  });

  describe("D1C-02: Mandatory Timestamp & Quote Causality Validation", () => {
    it("RF-D1C.5: rejects record with NaN or nonfinite decision, source, or ingestion timestamps", () => {
      const decision = createMockDecision({
        decisionTimestampMs: NaN,
        sourceTimestampMs: NaN,
        ingestionTimestampMs: NaN,
      });
      const joiner = new TelemetryExecutionJoinEngine({ mode: "OBSERVATIONAL_ONLY" });
      const results = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [],
        sessionMeta: createMockMeta(),
        sessionSummary: createMockSummary(),
        mode: "OBSERVATIONAL_ONLY",
      });

      expect(results[0]!.eligibility.isEligible).toBe(false);
      expect(
        results[0]!.eligibility.rejectionReasons.some((r) =>
          r.includes("INVALID_OR_NONFINITE_MANDATORY_TIMESTAMPS"),
        ),
      ).toBe(true);
    });

    it("RF-D1C.6: rejects simulated fill that preceded receipt of the quote used to model it", () => {
      const decision = createMockDecision({
        sourceTimestampMs: 1000,
        ingestionTimestampMs: 1100,
        decisionTimestampMs: 1200,
      });
      const validPreDecisionObs = createMockObservation({
        sourceTimestampMs: 1050,
        ingestionTimestampMs: 1100,
        responseReceivedMs: 1100,
      });
      const quote: ExecutableQuoteRecord = {
        quoteId: "quote-test-1",
        sessionId: decision.sessionId,
        generationId: decision.generationId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_2_POOL_RESERVE",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        inputMint: WSOL_MINT,
        outputMint: decision.mintAddress,
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
        routeType: "DIRECT_TRACKED_POOL",
        routePlan: [],
        quoteInitiatedMs: 1200,
        quoteReceivedMs: 1800, // Quote only received at 1800!
        contextSlot: 100,
        validUntilMs: 3000,
      };

      const prematureFill: SimulatedFillRecord = {
        fillId: "fill-premature-1",
        quoteId: quote.quoteId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        executionOutcome: "FILLED",
        attemptedSizeSol: 0.1,
        filledSizeSol: 0.1,
        attemptedTokens: 1000,
        filledTokens: 1000,
        remainingTokens: 0,
        effectivePriceSol: 0.0001,
        priceImpactBps: 10,
        maxSlippageBps: 100,
        realizedSlippageBps: 2,
        networkFeeLamports: 15_000,
        priorityFeeLamports: 10_000,
        ataRentDepositLamports: 2_039_280,
        ataRentRefundLamports: 0,
        sellabilityStatus: "FULLY_SELLABLE",
        fillTimestampMs: 1300, // Precedes quoteReceivedMs of 1800!
        fillSlot: 101,
        executionDelayMs: 100,
      };

      const joiner = new TelemetryExecutionJoinEngine({ mode: "SYNTHETIC_REPLAY" });
      const results = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [validPreDecisionObs],
        quotes: [quote],
        fills: [prematureFill],
        sessionMeta: createMockMeta(),
        sessionSummary: createMockSummary(),
        mode: "SYNTHETIC_REPLAY",
      });

      expect(results[0]!.eligibility.isEligible).toBe(false);
      expect(
        results[0]!.eligibility.rejectionReasons.some((r) =>
          r.includes("FILL_PRECEDED_QUOTE_RECEIPT"),
        ),
      ).toBe(true);
    });

    it("RF-D1C.7: rejects simulated fill that exceeded quote validity bound", () => {
      const decision = createMockDecision({
        sourceTimestampMs: 1000,
        ingestionTimestampMs: 1100,
        decisionTimestampMs: 1200,
      });
      const validPreDecisionObs = createMockObservation({
        sourceTimestampMs: 1050,
        ingestionTimestampMs: 1100,
        responseReceivedMs: 1100,
      });
      const quote: ExecutableQuoteRecord = {
        quoteId: "quote-expired-1",
        sessionId: decision.sessionId,
        generationId: decision.generationId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_2_POOL_RESERVE",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        inputMint: WSOL_MINT,
        outputMint: decision.mintAddress,
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
        routeType: "DIRECT_TRACKED_POOL",
        routePlan: [],
        quoteInitiatedMs: 1200,
        quoteReceivedMs: 1250,
        contextSlot: 100,
        validUntilMs: 1500, // Expires at 1500
      };

      const expiredFill: SimulatedFillRecord = {
        fillId: "fill-expired-1",
        quoteId: quote.quoteId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        executionOutcome: "FILLED",
        attemptedSizeSol: 0.1,
        filledSizeSol: 0.1,
        attemptedTokens: 1000,
        filledTokens: 1000,
        remainingTokens: 0,
        effectivePriceSol: 0.0001,
        priceImpactBps: 10,
        maxSlippageBps: 100,
        realizedSlippageBps: 2,
        networkFeeLamports: 15_000,
        priorityFeeLamports: 10_000,
        ataRentDepositLamports: 2_039_280,
        ataRentRefundLamports: 0,
        sellabilityStatus: "FULLY_SELLABLE",
        fillTimestampMs: 1600, // 1600 > 1500 (EXPIRED!)
        fillSlot: 105,
        executionDelayMs: 350,
      };

      const joiner = new TelemetryExecutionJoinEngine({ mode: "SYNTHETIC_REPLAY" });
      const results = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [validPreDecisionObs],
        quotes: [quote],
        fills: [expiredFill],
        sessionMeta: createMockMeta(),
        sessionSummary: createMockSummary(),
        mode: "SYNTHETIC_REPLAY",
      });

      expect(results[0]!.eligibility.isEligible).toBe(false);
      expect(
        results[0]!.eligibility.rejectionReasons.some((r) => r.includes("FILL_EXPIRED_QUOTE")),
      ).toBe(true);
    });

    it("RF-D1C.8: passes valid chronological execution sequence and separate path for no-fill decisions", () => {
      const decision = createMockDecision({
        sourceTimestampMs: 1000,
        ingestionTimestampMs: 1100,
        decisionTimestampMs: 1200,
      });
      const validPreDecisionObs = createMockObservation({
        sourceTimestampMs: 1050,
        ingestionTimestampMs: 1100,
        responseReceivedMs: 1100,
      });

      // 1. Valid execution sequence: decision <= quoteInitiated <= quoteReceived <= fillTimestamp <= validUntil
      const quote: ExecutableQuoteRecord = {
        quoteId: "quote-valid-1",
        sessionId: decision.sessionId,
        generationId: decision.generationId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_2_POOL_RESERVE",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        inputMint: WSOL_MINT,
        outputMint: decision.mintAddress,
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
        routeType: "DIRECT_TRACKED_POOL",
        routePlan: [],
        quoteInitiatedMs: 1210,
        quoteReceivedMs: 1220,
        contextSlot: 100,
        validUntilMs: 2000,
      };

      const fill: SimulatedFillRecord = {
        fillId: "fill-valid-1",
        quoteId: quote.quoteId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        executionOutcome: "FILLED",
        attemptedSizeSol: 0.1,
        filledSizeSol: 0.1,
        attemptedTokens: 1000,
        filledTokens: 1000,
        remainingTokens: 0,
        effectivePriceSol: 0.0001,
        priceImpactBps: 10,
        maxSlippageBps: 100,
        realizedSlippageBps: 2,
        networkFeeLamports: 15_000,
        priorityFeeLamports: 10_000,
        ataRentDepositLamports: 2_039_280,
        ataRentRefundLamports: 0,
        sellabilityStatus: "FULLY_SELLABLE",
        fillTimestampMs: 1230, // 1220 <= 1230 <= 2000
        fillSlot: 101,
        executionDelayMs: 20,
      };

      const joiner = new TelemetryExecutionJoinEngine({ mode: "SYNTHETIC_REPLAY" });
      const results = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [validPreDecisionObs],
        quotes: [quote],
        fills: [fill],
        sessionMeta: createMockMeta(),
        sessionSummary: createMockSummary(),
        mode: "SYNTHETIC_REPLAY",
      });

      expect(results[0]!.eligibility.isEligible).toBe(true);

      // 2. Separate causal path: Observational decision with NO fill and NO quote
      const obsOnlyResults = joiner.joinTelemetryAndExecution({
        decisions: [decision],
        observations: [validPreDecisionObs],
        sessionMeta: createMockMeta(),
        sessionSummary: createMockSummary(),
        mode: "OBSERVATIONAL_ONLY",
      });

      expect(obsOnlyResults[0]!.eligibility.isEligible).toBe(true);
      expect(obsOnlyResults[0]!.quote).toBeUndefined();
      expect(obsOnlyResults[0]!.fill).toBeUndefined();
    });
  });

  describe("D1C-03: Per-Decision Hypothesis Feasibility & Cohort Eligibility", () => {
    it("RF-D1C.10: two-session cross-token fixture: does not declare H3 feasible when features are on different tokens", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-h3-test-"));
      const tempTelemetryDir = path.join(tempDir, "telemetry", "sessions");
      const tempLegacyDir = path.join(tempDir, "sessions");
      fs.mkdirSync(tempLegacyDir, { recursive: true });

      // Session 1: Token A decision has lpBurnPct = 95, but observations do NOT have devHoldingPct
      const session1Dir = path.join(tempTelemetryDir, "session-1");
      fs.mkdirSync(session1Dir, { recursive: true });
      fs.writeFileSync(
        path.join(session1Dir, "session-meta.json"),
        JSON.stringify(createMockMeta({ sessionId: "session-1" })),
      );
      fs.writeFileSync(
        path.join(session1Dir, "session-summary.json"),
        JSON.stringify(createMockSummary({ sessionId: "session-1" })),
      );
      const decTokenA = createMockDecision({
        sessionId: "session-1",
        mintAddress: "TokenMintAAAA1111111111111111111111111111111",
        poolId: "pool-A",
        metricsSnapshot: {
          tokenAgeSec: 100,
          liquidityUsd: 50000,
          marketCapUsd: 100000,
          lmcRatio: 0.5,
          lpBurnPct: 95.0, // HAS LP BURN!
          spotPriceUsd: 0.001,
          spotPriceSol: 0.00001,
          volume5mUsd: 1000,
          txCount5m: 10,
          buys5m: 5,
          sells5m: 5,
          metricProvenance: { lpBurnPct: "OBSERVED" },
        },
      });
      fs.writeFileSync(
        path.join(session1Dir, "candidate-decisions.jsonl"),
        JSON.stringify(decTokenA) + "\n",
      );
      const obsTokenA = createMockObservation({
        sessionId: "session-1",
        mintAddress: "TokenMintAAAA1111111111111111111111111111111",
        poolId: "pool-A",
        actualResponsePoolId: "pool-A",
        holderMetrics: undefined, // NO DEV HOLDING!
      });
      fs.writeFileSync(
        path.join(session1Dir, "market-observations.jsonl"),
        JSON.stringify(obsTokenA) + "\n",
      );

      // Session 2: Token B decision has NO lpBurnPct, but an observation for Token B has devHoldingPct
      const session2Dir = path.join(tempTelemetryDir, "session-2");
      fs.mkdirSync(session2Dir, { recursive: true });
      fs.writeFileSync(
        path.join(session2Dir, "session-meta.json"),
        JSON.stringify(createMockMeta({ sessionId: "session-2" })),
      );
      fs.writeFileSync(
        path.join(session2Dir, "session-summary.json"),
        JSON.stringify(createMockSummary({ sessionId: "session-2" })),
      );
      const decTokenB = createMockDecision({
        sessionId: "session-2",
        mintAddress: "TokenMintBBBB1111111111111111111111111111111",
        poolId: "pool-B",
        metricsSnapshot: {
          tokenAgeSec: 100,
          liquidityUsd: 50000,
          marketCapUsd: 100000,
          lmcRatio: 0.5,
          lpBurnPct: null, // NO LP BURN!
          spotPriceUsd: 0.001,
          spotPriceSol: 0.00001,
          volume5mUsd: 1000,
          txCount5m: 10,
          buys5m: 5,
          sells5m: 5,
          metricProvenance: { lpBurnPct: "UNAVAILABLE" },
        },
      });
      fs.writeFileSync(
        path.join(session2Dir, "candidate-decisions.jsonl"),
        JSON.stringify(decTokenB) + "\n",
      );
      const obsTokenB = createMockObservation({
        sessionId: "session-2",
        mintAddress: "TokenMintBBBB1111111111111111111111111111111",
        poolId: "pool-B",
        actualResponsePoolId: "pool-B",
        holderMetrics: {
          devHoldingPct: 15.0, // HAS DEV HOLDING!
          top10ConcentrationPct: 40.0,
          totalHolders: 150,
        },
      });
      fs.writeFileSync(
        path.join(session2Dir, "market-observations.jsonl"),
        JSON.stringify(obsTokenB) + "\n",
      );

      const auditResult = runReadinessAudit({
        rootDir: tempDir,
        telemetrySessionsDir: tempTelemetryDir,
        legacySessionsDir: tempLegacyDir,
        reportOutputPath: path.join(tempDir, "REPORT.md"),
      });

      // Assertions: H3 must be false because no single candidate has both features!
      expect(auditResult.eligibleH3DecisionsCount).toBe(0);
      expect(auditResult.h3Feasible).toBe(false);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("RF-D1C.11: unfinalized session fixture: does not declare H2 feasible when session is unfinalized", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-h2-test-"));
      const tempTelemetryDir = path.join(tempDir, "telemetry", "sessions");
      const sessionDir = path.join(tempTelemetryDir, "unfinalized-session");
      fs.mkdirSync(sessionDir, { recursive: true });

      // Session meta is ACTIVE (unfinalized!)
      fs.writeFileSync(
        path.join(sessionDir, "session-meta.json"),
        JSON.stringify(
          createMockMeta({ sessionId: "unfinalized-session", sessionStatus: "ACTIVE" }),
        ),
      );
      // Even if summary claims complete, contradictory or unfinalized state fails closed
      fs.writeFileSync(
        path.join(sessionDir, "session-summary.json"),
        JSON.stringify(
          createMockSummary({ sessionId: "unfinalized-session", isCompleteSession: true }),
        ),
      );

      // Decision has all H2 co-occurring features
      const decision = createMockDecision({
        sessionId: "unfinalized-session",
        metricsSnapshot: {
          tokenAgeSec: 100,
          liquidityUsd: 50000,
          marketCapUsd: 100000,
          lmcRatio: 0.5,
          lpBurnPct: null,
          spotPriceUsd: 0.001,
          spotPriceSol: 0.00001,
          volume5mUsd: 25000,
          txCount5m: 50,
          buys5m: 35,
          sells5m: 15,
          metricProvenance: {
            volume5mUsd: "OBSERVED",
            buys5m: "OBSERVED",
            sells5m: "OBSERVED",
          },
        },
      });
      fs.writeFileSync(
        path.join(sessionDir, "candidate-decisions.jsonl"),
        JSON.stringify(decision) + "\n",
      );

      const auditResult = runReadinessAudit({
        rootDir: tempDir,
        telemetrySessionsDir: tempTelemetryDir,
        legacySessionsDir: path.join(tempDir, "sessions"),
        reportOutputPath: path.join(tempDir, "REPORT.md"),
      });

      expect(auditResult.finalizedSessionsCount).toBe(0);
      expect(auditResult.unfinalizedSessionsCount).toBe(1);
      expect(auditResult.eligibleH2DecisionsCount).toBe(0);
      expect(auditResult.h2Feasible).toBe(false);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("RF-D1C.12: cross-generation reserve attribution fixture: does not attribute reserves from another generation", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-gen-test-"));
      const tempTelemetryDir = path.join(tempDir, "telemetry", "sessions");
      const sessionDir = path.join(tempTelemetryDir, "gen-session");
      fs.mkdirSync(sessionDir, { recursive: true });

      fs.writeFileSync(
        path.join(sessionDir, "session-meta.json"),
        JSON.stringify(createMockMeta({ sessionId: "gen-session", generationId: "gen-2" })),
      );
      fs.writeFileSync(
        path.join(sessionDir, "session-summary.json"),
        JSON.stringify(createMockSummary({ sessionId: "gen-session", generationId: "gen-2" })),
      );

      // Decision is gen-2
      const decGen2 = createMockDecision({
        sessionId: "gen-session",
        generationId: "gen-2",
        poolId: "pool-amm-1",
        decisionTimestampMs: 1792000001000,
      });
      fs.writeFileSync(
        path.join(sessionDir, "candidate-decisions.jsonl"),
        JSON.stringify(decGen2) + "\n",
      );

      // Reserve observation has gen-1 (MISMATCH!)
      const obsGen1 = createMockObservation({
        sessionId: "gen-session",
        generationId: "gen-1", // WRONG GENERATION!
        poolId: "pool-amm-1",
        actualResponsePoolId: "pool-amm-1",
        sourceTimestampMs: 1792000000500,
        ingestionTimestampMs: 1792000000800,
        responseReceivedMs: 1792000000800,
        liquidityMetrics: {
          baseReserve: 100_000,
          quoteReserve: 50,
          liquidityUsd: 10000,
        },
      });
      fs.writeFileSync(
        path.join(sessionDir, "market-observations.jsonl"),
        JSON.stringify(obsGen1) + "\n",
      );

      const auditResult = runReadinessAudit({
        rootDir: tempDir,
        telemetrySessionsDir: tempTelemetryDir,
        legacySessionsDir: path.join(tempDir, "sessions"),
        reportOutputPath: path.join(tempDir, "REPORT.md"),
      });

      expect(auditResult.eligibleH1DecisionsCount).toBe(0);
      expect(auditResult.h1Feasible).toBe(false);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("RF-D1C.13: valid candidate decision with all features matching declares hypotheses feasible", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-valid-test-"));
      const tempTelemetryDir = path.join(tempDir, "telemetry", "sessions");
      const sessionDir = path.join(tempTelemetryDir, "valid-session");
      fs.mkdirSync(sessionDir, { recursive: true });

      fs.writeFileSync(
        path.join(sessionDir, "session-meta.json"),
        JSON.stringify(createMockMeta({ sessionId: "valid-session", generationId: "gen-1" })),
      );
      fs.writeFileSync(
        path.join(sessionDir, "session-summary.json"),
        JSON.stringify(createMockSummary({ sessionId: "valid-session", generationId: "gen-1" })),
      );

      // Decision in finalized session with valid timestamps, H2 features, and lpBurnPct
      const decision = createMockDecision({
        sessionId: "valid-session",
        generationId: "gen-1",
        mintAddress: "TokenMintValid111111111111111111111111111111",
        poolId: "pool-amm-valid",
        sourceTimestampMs: 1792000000000,
        ingestionTimestampMs: 1792000000500,
        decisionTimestampMs: 1792000001000,
        metricsSnapshot: {
          tokenAgeSec: 100,
          liquidityUsd: 50000,
          marketCapUsd: 100000,
          lmcRatio: 0.5,
          lpBurnPct: 95.0,
          spotPriceUsd: 0.001,
          spotPriceSol: 0.00001,
          volume5mUsd: 25000,
          txCount5m: 50,
          buys5m: 35,
          sells5m: 15,
          metricProvenance: {
            lpBurnPct: "OBSERVED",
            volume5mUsd: "OBSERVED",
            buys5m: "OBSERVED",
            sells5m: "OBSERVED",
          },
        },
      });
      fs.writeFileSync(
        path.join(sessionDir, "candidate-decisions.jsonl"),
        JSON.stringify(decision) + "\n",
      );

      // Pre-decision observation matching this candidate with valid reserves and devHoldingPct
      const obs = createMockObservation({
        sessionId: "valid-session",
        generationId: "gen-1",
        mintAddress: "TokenMintValid111111111111111111111111111111",
        poolId: "pool-amm-valid",
        actualResponsePoolId: "pool-amm-valid",
        sourceTimestampMs: 1792000000500,
        ingestionTimestampMs: 1792000000800,
        responseReceivedMs: 1792000000800,
        liquidityMetrics: {
          baseReserve: 100_000,
          quoteReserve: 50,
          liquidityUsd: 10000,
        },
        holderMetrics: {
          devHoldingPct: 5.0,
          top10ConcentrationPct: 20.0,
          totalHolders: 150,
        },
      });
      fs.writeFileSync(
        path.join(sessionDir, "market-observations.jsonl"),
        JSON.stringify(obs) + "\n",
      );

      const auditResult = runReadinessAudit({
        rootDir: tempDir,
        telemetrySessionsDir: tempTelemetryDir,
        legacySessionsDir: path.join(tempDir, "sessions"),
        reportOutputPath: path.join(tempDir, "REPORT.md"),
      });

      expect(auditResult.finalizedSessionsCount).toBe(1);
      expect(auditResult.finalizedEligibleDecisionsCount).toBe(1);
      expect(auditResult.eligibleH1DecisionsCount).toBe(1);
      expect(auditResult.eligibleH2DecisionsCount).toBe(1);
      expect(auditResult.eligibleH3DecisionsCount).toBe(1);
      expect(auditResult.eligibleH4DecisionsCount).toBe(1);
      expect(auditResult.h1Feasible).toBe(true);
      expect(auditResult.h2Feasible).toBe(true);
      expect(auditResult.h3Feasible).toBe(true);
      expect(auditResult.h4Feasible).toBe(true);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("D1C3-01 & D1C3-02: Point-in-Time H3 Readiness & Fail-Closed Quote/Fill Bounds", () => {
    it("RF-D1C3.1: D1C3-01: future-only developer-holding observation produces h3Feasible: false and eligibleH3DecisionsCount: 0 on candidate decision at time t", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-h3-future-"));
      const tempTelemetryDir = path.join(tempDir, "telemetry", "sessions");
      const sessionDir = path.join(tempTelemetryDir, "future-obs-session");
      fs.mkdirSync(sessionDir, { recursive: true });

      fs.writeFileSync(
        path.join(sessionDir, "session-meta.json"),
        JSON.stringify(createMockMeta({ sessionId: "future-obs-session" })),
      );
      fs.writeFileSync(
        path.join(sessionDir, "session-summary.json"),
        JSON.stringify(createMockSummary({ sessionId: "future-obs-session" })),
      );

      // Candidate decision at t = 1,000,000 with lpBurnPct = 95
      const decision = createMockDecision({
        sessionId: "future-obs-session",
        generationId: "gen-1",
        mintAddress: "TokenMintH3Future111111111111111111111111111",
        poolId: "pool-amm-future",
        sourceTimestampMs: 999_000,
        ingestionTimestampMs: 999_500,
        decisionTimestampMs: 1_000_000,
        metricsSnapshot: {
          tokenAgeSec: 100,
          liquidityUsd: 50000,
          marketCapUsd: 100000,
          lmcRatio: 0.5,
          lpBurnPct: 95.0,
          spotPriceUsd: 0.001,
          spotPriceSol: 0.00001,
          volume5mUsd: 25000,
          txCount5m: 50,
          buys5m: 35,
          sells5m: 15,
          metricProvenance: {
            lpBurnPct: "OBSERVED",
            volume5mUsd: "OBSERVED",
            buys5m: "OBSERVED",
            sells5m: "OBSERVED",
          },
        },
      });
      fs.writeFileSync(
        path.join(sessionDir, "candidate-decisions.jsonl"),
        JSON.stringify(decision) + "\n",
      );

      // Matching developer-holding observation 60 seconds AFTER the decision (source = 1,060,000, ingestion = 1,060,100)
      const futureObs = createMockObservation({
        sessionId: "future-obs-session",
        generationId: "gen-1",
        mintAddress: "TokenMintH3Future111111111111111111111111111",
        poolId: "pool-amm-future",
        actualResponsePoolId: "pool-amm-future",
        sourceTimestampMs: 1_060_000,
        ingestionTimestampMs: 1_060_100,
        responseReceivedMs: 1_060_100,
        holderMetrics: {
          devHoldingPct: 21.0,
          top10ConcentrationPct: 30.0,
          totalHolders: 100,
        },
      });
      fs.writeFileSync(
        path.join(sessionDir, "market-observations.jsonl"),
        JSON.stringify(futureObs) + "\n",
      );

      const auditResult = runReadinessAudit({
        rootDir: tempDir,
        telemetrySessionsDir: tempTelemetryDir,
        legacySessionsDir: path.join(tempDir, "sessions"),
        reportOutputPath: path.join(tempDir, "REPORT.md"),
      });

      // Must NOT declare H3 feasible from future-only observation!
      expect(auditResult.eligibleH3DecisionsCount).toBe(0);
      expect(auditResult.h3Feasible).toBe(false);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("RF-D1C3.2: D1C3-01: pre-decision developer-holding observation within freshness window qualifies candidate decision for H3", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-h3-pre-"));
      const tempTelemetryDir = path.join(tempDir, "telemetry", "sessions");
      const sessionDir = path.join(tempTelemetryDir, "pre-obs-session");
      fs.mkdirSync(sessionDir, { recursive: true });

      fs.writeFileSync(
        path.join(sessionDir, "session-meta.json"),
        JSON.stringify(createMockMeta({ sessionId: "pre-obs-session" })),
      );
      fs.writeFileSync(
        path.join(sessionDir, "session-summary.json"),
        JSON.stringify(createMockSummary({ sessionId: "pre-obs-session" })),
      );

      // Candidate decision at t = 1,000,000 with lpBurnPct = 95
      const decision = createMockDecision({
        sessionId: "pre-obs-session",
        generationId: "gen-1",
        mintAddress: "TokenMintH3Pre11111111111111111111111111111",
        poolId: "pool-amm-pre",
        sourceTimestampMs: 999_000,
        ingestionTimestampMs: 999_500,
        decisionTimestampMs: 1_000_000,
        metricsSnapshot: {
          tokenAgeSec: 100,
          liquidityUsd: 50000,
          marketCapUsd: 100000,
          lmcRatio: 0.5,
          lpBurnPct: 95.0,
          spotPriceUsd: 0.001,
          spotPriceSol: 0.00001,
          volume5mUsd: 25000,
          txCount5m: 50,
          buys5m: 35,
          sells5m: 15,
          metricProvenance: {
            lpBurnPct: "OBSERVED",
            volume5mUsd: "OBSERVED",
            buys5m: "OBSERVED",
            sells5m: "OBSERVED",
          },
        },
      });
      fs.writeFileSync(
        path.join(sessionDir, "candidate-decisions.jsonl"),
        JSON.stringify(decision) + "\n",
      );

      // Valid pre-decision developer-holding observation at t = 990,000 (10s before decision, within freshness window)
      const preObs = createMockObservation({
        sessionId: "pre-obs-session",
        generationId: "gen-1",
        mintAddress: "TokenMintH3Pre11111111111111111111111111111",
        poolId: "pool-amm-pre",
        actualResponsePoolId: "pool-amm-pre",
        sourceTimestampMs: 990_000,
        ingestionTimestampMs: 990_100,
        responseReceivedMs: 990_100,
        holderMetrics: {
          devHoldingPct: 21.0,
          top10ConcentrationPct: 30.0,
          totalHolders: 100,
        },
      });
      fs.writeFileSync(
        path.join(sessionDir, "market-observations.jsonl"),
        JSON.stringify(preObs) + "\n",
      );

      const auditResult = runReadinessAudit({
        rootDir: tempDir,
        telemetrySessionsDir: tempTelemetryDir,
        legacySessionsDir: path.join(tempDir, "sessions"),
        reportOutputPath: path.join(tempDir, "REPORT.md"),
      });

      // Must qualify candidate decision for H3
      expect(auditResult.eligibleH3DecisionsCount).toBe(1);
      expect(auditResult.h3Feasible).toBe(true);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("RF-D1C3.3: D1C3-01: stale pre-decision developer-holding observation exceeding freshness limit fails closed", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-h3-stale-"));
      const tempTelemetryDir = path.join(tempDir, "telemetry", "sessions");
      const sessionDir = path.join(tempTelemetryDir, "stale-obs-session");
      fs.mkdirSync(sessionDir, { recursive: true });

      fs.writeFileSync(
        path.join(sessionDir, "session-meta.json"),
        JSON.stringify(createMockMeta({ sessionId: "stale-obs-session" })),
      );
      fs.writeFileSync(
        path.join(sessionDir, "session-summary.json"),
        JSON.stringify(createMockSummary({ sessionId: "stale-obs-session" })),
      );

      // Candidate decision at t = 1,000,000 with lpBurnPct = 95
      const decision = createMockDecision({
        sessionId: "stale-obs-session",
        generationId: "gen-1",
        mintAddress: "TokenMintH3Stale1111111111111111111111111111",
        poolId: "pool-amm-stale",
        sourceTimestampMs: 999_000,
        ingestionTimestampMs: 999_500,
        decisionTimestampMs: 1_000_000,
        metricsSnapshot: {
          tokenAgeSec: 100,
          liquidityUsd: 50000,
          marketCapUsd: 100000,
          lmcRatio: 0.5,
          lpBurnPct: 95.0,
          spotPriceUsd: 0.001,
          spotPriceSol: 0.00001,
          volume5mUsd: 25000,
          txCount5m: 50,
          buys5m: 35,
          sells5m: 15,
          metricProvenance: {
            lpBurnPct: "OBSERVED",
            volume5mUsd: "OBSERVED",
            buys5m: "OBSERVED",
            sells5m: "OBSERVED",
          },
        },
      });
      fs.writeFileSync(
        path.join(sessionDir, "candidate-decisions.jsonl"),
        JSON.stringify(decision) + "\n",
      );

      // Stale observation at t = 700,000 (300 seconds before decision, exceeds 180s MAX_DATA_FRESHNESS_MS)
      const staleObs = createMockObservation({
        sessionId: "stale-obs-session",
        generationId: "gen-1",
        mintAddress: "TokenMintH3Stale1111111111111111111111111111",
        poolId: "pool-amm-stale",
        actualResponsePoolId: "pool-amm-stale",
        sourceTimestampMs: 700_000,
        ingestionTimestampMs: 700_100,
        responseReceivedMs: 700_100,
        holderMetrics: {
          devHoldingPct: 21.0,
          top10ConcentrationPct: 30.0,
          totalHolders: 100,
        },
      });
      fs.writeFileSync(
        path.join(sessionDir, "market-observations.jsonl"),
        JSON.stringify(staleObs) + "\n",
      );

      const auditResult = runReadinessAudit({
        rootDir: tempDir,
        telemetrySessionsDir: tempTelemetryDir,
        legacySessionsDir: path.join(tempDir, "sessions"),
        reportOutputPath: path.join(tempDir, "REPORT.md"),
      });

      // Stale observation must fail closed
      expect(auditResult.eligibleH3DecisionsCount).toBe(0);
      expect(auditResult.h3Feasible).toBe(false);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("RF-D1C3.4: D1C3-02: rejects quote with validUntilMs = NaN with attached fill in both evaluation modes", () => {
      const decision = createMockDecision({
        sourceTimestampMs: 1000,
        ingestionTimestampMs: 1100,
        decisionTimestampMs: 1200,
      });

      const nanQuote: ExecutableQuoteRecord = {
        quoteId: "quote-nan-expiry",
        sessionId: decision.sessionId,
        generationId: decision.generationId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_2_POOL_RESERVE",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        inputMint: WSOL_MINT,
        outputMint: decision.mintAddress,
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
        routeType: "DIRECT_TRACKED_POOL",
        routePlan: [],
        quoteInitiatedMs: 1300,
        quoteReceivedMs: 1500,
        contextSlot: 100,
        validUntilMs: NaN, // ADVERSARIAL NaN EXPIRY!
      };

      const fill: SimulatedFillRecord = {
        fillId: "fill-attached-1",
        quoteId: nanQuote.quoteId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        executionOutcome: "FILLED",
        attemptedSizeSol: 0.1,
        filledSizeSol: 0.1,
        attemptedTokens: 1000,
        filledTokens: 1000,
        remainingTokens: 0,
        effectivePriceSol: 0.0001,
        priceImpactBps: 10,
        maxSlippageBps: 100,
        realizedSlippageBps: 2,
        networkFeeLamports: 15_000,
        priorityFeeLamports: 10_000,
        ataRentDepositLamports: 2_039_280,
        ataRentRefundLamports: 0,
        sellabilityStatus: "FULLY_SELLABLE",
        fillTimestampMs: 1600,
        fillSlot: 101,
        executionDelayMs: 100,
      };

      // 1. In OBSERVATIONAL_ONLY mode:
      const obsGateResult = evaluateResearchEligibility(
        {
          joinId: "join-nan-1",
          decisionEventId: decision.eventId,
          sessionId: decision.sessionId,
          generationId: decision.generationId,
          mintAddress: decision.mintAddress,
          poolId: decision.poolId,
          symbol: "TEST",
          decisionTimestampMs: decision.decisionTimestampMs,
          sourceTimestampMs: decision.sourceTimestampMs,
          ingestionTimestampMs: decision.ingestionTimestampMs,
          strategyRevision: "strategy-v1",
          decisionCohort: "EXECUTED_BUY",
          evaluationMode: "OBSERVATIONAL_ONLY",
          sessionStatus: "FINALIZED",
          trajectoryLinkStatus: "EXPLICIT_LINK",
          features: createMockFeatures(),
          forwardObservations: [],
          quote: nanQuote,
          fill,
        },
        { mode: "OBSERVATIONAL_ONLY" },
      );

      expect(obsGateResult.isEligible).toBe(false);
      expect(
        obsGateResult.rejectionReasons.some((r) =>
          r.includes("INVALID_OR_NONFINITE_QUOTE_TIMESTAMPS"),
        ),
      ).toBe(true);

      // 2. In SYNTHETIC_REPLAY mode:
      const replayGateResult = evaluateResearchEligibility(
        {
          joinId: "join-nan-2",
          decisionEventId: decision.eventId,
          sessionId: decision.sessionId,
          generationId: decision.generationId,
          mintAddress: decision.mintAddress,
          poolId: decision.poolId,
          symbol: "TEST",
          decisionTimestampMs: decision.decisionTimestampMs,
          sourceTimestampMs: decision.sourceTimestampMs,
          ingestionTimestampMs: decision.ingestionTimestampMs,
          strategyRevision: "strategy-v1",
          decisionCohort: "EXECUTED_BUY",
          evaluationMode: "SYNTHETIC_REPLAY",
          sessionStatus: "FINALIZED",
          trajectoryLinkStatus: "EXPLICIT_LINK",
          features: createMockFeatures({
            baseReserve: { isAvailable: true, value: 1000, provenance: "OBSERVED" },
            quoteReserve: { isAvailable: true, value: 50, provenance: "OBSERVED" },
          }),
          forwardObservations: [],
          quote: nanQuote,
          fill,
        },
        { mode: "SYNTHETIC_REPLAY" },
      );

      expect(replayGateResult.isEligible).toBe(false);
      expect(
        replayGateResult.rejectionReasons.some((r) =>
          r.includes("INVALID_OR_NONFINITE_QUOTE_TIMESTAMPS"),
        ),
      ).toBe(true);
    });

    it("RF-D1C3.5: D1C3-02: rejects orphan fill without matching quote in OBSERVATIONAL_ONLY mode", () => {
      const decision = createMockDecision({
        sourceTimestampMs: 1000,
        ingestionTimestampMs: 1100,
        decisionTimestampMs: 1200,
      });

      const orphanFill: SimulatedFillRecord = {
        fillId: "fill-orphan-1",
        quoteId: "quote-missing-never-seen",
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        executionOutcome: "FILLED",
        attemptedSizeSol: 0.1,
        filledSizeSol: 0.1,
        attemptedTokens: 1000,
        filledTokens: 1000,
        remainingTokens: 0,
        effectivePriceSol: 0.0001,
        priceImpactBps: 10,
        maxSlippageBps: 100,
        realizedSlippageBps: 2,
        networkFeeLamports: 15_000,
        priorityFeeLamports: 10_000,
        ataRentDepositLamports: 2_039_280,
        ataRentRefundLamports: 0,
        sellabilityStatus: "FULLY_SELLABLE",
        fillTimestampMs: 1600,
        fillSlot: 101,
        executionDelayMs: 100,
      };

      const result = evaluateResearchEligibility(
        {
          joinId: "join-orphan-1",
          decisionEventId: decision.eventId,
          sessionId: decision.sessionId,
          generationId: decision.generationId,
          mintAddress: decision.mintAddress,
          poolId: decision.poolId,
          symbol: "TEST",
          decisionTimestampMs: decision.decisionTimestampMs,
          sourceTimestampMs: decision.sourceTimestampMs,
          ingestionTimestampMs: decision.ingestionTimestampMs,
          strategyRevision: "strategy-v1",
          decisionCohort: "EXECUTED_BUY",
          evaluationMode: "OBSERVATIONAL_ONLY",
          sessionStatus: "FINALIZED",
          trajectoryLinkStatus: "EXPLICIT_LINK",
          features: createMockFeatures(),
          forwardObservations: [],
          quote: undefined, // NO QUOTE!
          fill: orphanFill,
        },
        { mode: "OBSERVATIONAL_ONLY" },
      );

      expect(result.isEligible).toBe(false);
      expect(result.rejectionReasons.some((r) => r.includes("ORPHAN_FILL_WITHOUT_QUOTE"))).toBe(
        true,
      );
    });

    it("RF-D1C3.6: D1C3-02: rejects quote where validUntilMs precedes quoteReceivedMs", () => {
      const decision = createMockDecision({
        sourceTimestampMs: 1000,
        ingestionTimestampMs: 1100,
        decisionTimestampMs: 1200,
      });

      const invertedExpiryQuote: ExecutableQuoteRecord = {
        quoteId: "quote-inverted-expiry",
        sessionId: decision.sessionId,
        generationId: decision.generationId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        priceTier: "TIER_2_POOL_RESERVE",
        providerIdentity: "synthetic_amm_reserve",
        side: "BUY",
        inputMint: WSOL_MINT,
        outputMint: decision.mintAddress,
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
        routeType: "DIRECT_TRACKED_POOL",
        routePlan: [],
        quoteInitiatedMs: 1200,
        quoteReceivedMs: 1500, // Received at 1500
        contextSlot: 100,
        validUntilMs: 1400, // Expired at 1400 (< 1500!)
      };

      const result = evaluateResearchEligibility(
        {
          joinId: "join-inverted-1",
          decisionEventId: decision.eventId,
          sessionId: decision.sessionId,
          generationId: decision.generationId,
          mintAddress: decision.mintAddress,
          poolId: decision.poolId,
          symbol: "TEST",
          decisionTimestampMs: decision.decisionTimestampMs,
          sourceTimestampMs: decision.sourceTimestampMs,
          ingestionTimestampMs: decision.ingestionTimestampMs,
          strategyRevision: "strategy-v1",
          decisionCohort: "EXECUTED_BUY",
          evaluationMode: "SYNTHETIC_REPLAY",
          sessionStatus: "FINALIZED",
          trajectoryLinkStatus: "EXPLICIT_LINK",
          features: createMockFeatures({
            baseReserve: { isAvailable: true, value: 1000, provenance: "OBSERVED" },
            quoteReserve: { isAvailable: true, value: 50, provenance: "OBSERVED" },
          }),
          forwardObservations: [],
          quote: invertedExpiryQuote,
        },
        { mode: "SYNTHETIC_REPLAY" },
      );

      expect(result.isEligible).toBe(false);
      expect(
        result.rejectionReasons.some((r) => r.includes("QUOTE_EXPIRATION_PRECEDES_RECEIPT")),
      ).toBe(true);
    });

    it("RF-D1C3.7: D1C3-02: observational-only decision without any quote or fill remains eligible", () => {
      const decision = createMockDecision({
        sourceTimestampMs: 1000,
        ingestionTimestampMs: 1100,
        decisionTimestampMs: 1200,
      });

      const result = evaluateResearchEligibility(
        {
          joinId: "join-obs-only-1",
          decisionEventId: decision.eventId,
          sessionId: decision.sessionId,
          generationId: decision.generationId,
          mintAddress: decision.mintAddress,
          poolId: decision.poolId,
          symbol: "TEST",
          decisionTimestampMs: decision.decisionTimestampMs,
          sourceTimestampMs: decision.sourceTimestampMs,
          ingestionTimestampMs: decision.ingestionTimestampMs,
          strategyRevision: "strategy-v1",
          decisionCohort: "EXECUTED_BUY",
          evaluationMode: "OBSERVATIONAL_ONLY",
          sessionStatus: "FINALIZED",
          trajectoryLinkStatus: "UNIQUELY_INFERRED",
          features: createMockFeatures(),
          forwardObservations: [],
          quote: undefined, // NO QUOTE
          fill: undefined, // NO FILL
        },
        { mode: "OBSERVATIONAL_ONLY" },
      );

      expect(result.isEligible).toBe(true);
      expect(result.rejectionReasons).toHaveLength(0);
    });
  });

  describe("Phase 12.94-D Milestone D.2.1 Offline Foundations & Verification Fixtures", () => {
    describe("D2.1-DELIV-1: Windows Legacy-Data Inventory & Provenance Manifest", () => {
      it("RF-D21.1: inspects Windows legacy sessions and confirms honest INSUFFICIENT_EVIDENCE status", () => {
        const inventory = inspectWindowsLegacySessions();
        expect(inventory.telemetrySessionsFoundCount).toBe(0);
        expect(inventory.canonicalTelemetryStatus).toContain("INSUFFICIENT_EVIDENCE");
        expect(inventory.legacySessionsCount).toBe(2);
        expect(inventory.walletStatus?.currentBalanceSol).toBe(7.9259);
        expect(inventory.walletStatus?.sha256).toBe(
          "7f2c2353ac2f62cac1bb98703742ab19c74ac5521635af6f49bbe777ad020ed9",
        );
        expect(inventory.fedoraRunStatus).toContain("REPORTED_NOT_INSPECTED");

        // Verify that each legacy session has known missing quantitative features
        for (const session of inventory.legacySessionInventories) {
          expect(session.missingQuantitativeFeatures.length).toBeGreaterThan(0);
          expect(session.hypothesisFeasibility.h1LiquidityDepth).toContain("INELIGIBLE");
          expect(session.hypothesisFeasibility.h2OrderFlowMomentum).toContain("INELIGIBLE");
          expect(session.hypothesisFeasibility.h3StructuralSafety).toContain("INELIGIBLE");
          expect(session.hypothesisFeasibility.h4DynamicCapacitySizing).toContain("INELIGIBLE");
        }
      });
    });

    describe("D2.1-DELIV-2: Shadow Evaluation Research Sidecar Contracts", () => {
      it("RF-D21.2: creates and validates a schema 1.0.0 ShadowEvaluationRecord preserving original decision cohort", () => {
        const decision = createMockDecision({
          decisionCohort: "WATCHLIST_RADAR",
        });

        const record = createShadowEvaluationRecord({
          decision,
          qualificationResult: {
            shadowTriggerQualified: true,
            qualificationReason: "MET_MOMENTUM_AND_SAFETY_CRITERIA",
            simulatedTargetSizeSol: 0.1,
            executionFeasible: true,
          },
          hostMonotonicElapsedMs: 142.5,
          observedReserveSnapshot: {
            baseReserve: 1000000,
            quoteReserve: 50,
            sourceTimestampMs: decision.sourceTimestampMs,
          },
        });

        expect(record.schemaVersion).toBe("1.0.0");
        expect(record.decisionEventId).toBe(decision.eventId);
        expect(record.evaluationTimestampMs).toBe(decision.decisionTimestampMs);
        expect(record.hostMonotonicElapsedMs).toBe(142.5);
        expect(record.qualificationResult.shadowTriggerQualified).toBe(true);
        expect(record.qualificationResult.executionFeasible).toBe(true);

        const validated = validateShadowEvaluationRecord(record);
        expect(validated.evaluationId).toBe(record.evaluationId);

        // Crucial invariant: original decision cohort remains WATCHLIST_RADAR (never EXECUTED_BUY)
        expect(decision.decisionCohort).toBe("WATCHLIST_RADAR");
      });

      it("RF-D21.3: rejects invalid or corrupt shadow evaluation records fail-closed", () => {
        expect(() => validateShadowEvaluationRecord(null)).toThrow("non-null object");
        expect(() => validateShadowEvaluationRecord({ schemaVersion: "2.0.0" })).toThrow(
          "schemaVersion",
        );
        expect(() =>
          validateShadowEvaluationRecord({
            schemaVersion: "1.0.0",
            evaluationId: "",
          }),
        ).toThrow("evaluationId");
        expect(() =>
          validateShadowEvaluationRecord({
            schemaVersion: "1.0.0",
            evaluationId: "shd-1",
            decisionEventId: "dec-1",
            sessionId: "ses-1",
            generationId: "gen-1",
            mintAddress: "mint-1",
            poolId: "pool-1",
            evaluationTimestampMs: NaN,
          }),
        ).toThrow("evaluationTimestampMs");
      });

      it("RF-D21.3b: D21-AUD-05: rejects executionFeasible: true with zero, non-finite, or future reserve snapshots", () => {
        // Auditor reproduction: evaluation at 1000 with executionFeasible: true and zero reserves with future sourceTimestampMs (999999999)
        const corruptRecord = {
          schemaVersion: "1.0.0",
          evaluationId: "shd-test-1",
          decisionEventId: "dec-test-1",
          sessionId: "ses-test-1",
          generationId: "gen-1",
          mintAddress: "TokenMint111111111111111111111111111111111111",
          poolId: "pool-1",
          evaluationTimestampMs: 1000,
          qualificationResult: {
            shadowTriggerQualified: true,
            qualificationReason: "MET_MOMENTUM_CRITERIA",
            simulatedTargetSizeSol: 0.1,
            executionFeasible: true,
          },
          observedReserveSnapshot: {
            baseReserve: 0,
            quoteReserve: 0,
            sourceTimestampMs: 999999999,
          },
        };

        // 1. Syntactic validator throws fail-closed on zero reserves
        expect(() => validateShadowEvaluationRecord(corruptRecord)).toThrow(
          "executionFeasible requires strictly positive baseReserve and quoteReserve",
        );

        // 2. Syntactic validator throws fail-closed on future reserve snapshot even if reserves were positive
        const futureReserveRecord = {
          ...corruptRecord,
          observedReserveSnapshot: {
            baseReserve: 100000,
            quoteReserve: 50,
            sourceTimestampMs: 999999999, // Future: 999999999 > 1000!
          },
        };
        expect(() => validateShadowEvaluationRecord(futureReserveRecord)).toThrow(
          "cannot be after evaluationTimestampMs",
        );

        // 3. Syntactic validator throws fail-closed if executionFeasible: true without observedReserveSnapshot
        const missingSnapshotRecord = {
          ...corruptRecord,
          observedReserveSnapshot: undefined,
        };
        expect(() => validateShadowEvaluationRecord(missingSnapshotRecord)).toThrow(
          "executionFeasible cannot be true without an observedReserveSnapshot",
        );
      });

      it("RF-D21.3c: D21-AUD-05: validateShadowEvaluationEligibility validates composite foreign-key identity and chronology fail-closed", () => {
        const canonicalDecision = createMockDecision({
          eventId: "dec-canonical-1",
          sessionId: "session-paper-d21",
          generationId: "gen-1",
          mintAddress: "TokenMint111111111111111111111111111111111111",
          poolId: "pool-amm-1",
          decisionTimestampMs: 1000000,
          decisionCohort: "WATCHLIST_RADAR",
        });

        // Valid shadow record matching canonical decision
        const validRecord = createShadowEvaluationRecord({
          decision: canonicalDecision,
          qualificationResult: {
            shadowTriggerQualified: true,
            qualificationReason: "MET_MOMENTUM_CRITERIA",
            simulatedTargetSizeSol: 0.1,
            executionFeasible: true,
          },
          evaluationTimestampMs: 1000000,
          observedReserveSnapshot: {
            baseReserve: 500000,
            quoteReserve: 25,
            sourceTimestampMs: 999500, // Pre-decision
          },
        });

        const validEligibility = validateShadowEvaluationEligibility(
          validRecord,
          canonicalDecision,
        );
        expect(validEligibility.isEligible).toBe(true);
        expect(validEligibility.executionFeasible).toBe(true);
        expect(validEligibility.rejectionReasons).toHaveLength(0);

        // Conflict 1: Mismatched poolId fails closed
        const mismatchedPoolRecord = {
          ...validRecord,
          poolId: "mismatched-pool-id",
        };
        const poolEligibility = validateShadowEvaluationEligibility(
          mismatchedPoolRecord,
          canonicalDecision,
        );
        expect(poolEligibility.isEligible).toBe(false);
        expect(poolEligibility.unavailabilityReason).toBe("POOL_IDENTITY_MISMATCH_DISCARDED");
        expect(
          poolEligibility.rejectionReasons.some((r) =>
            r.includes("COMPOSITE_FOREIGN_KEY_MISMATCH"),
          ),
        ).toBe(true);

        // Conflict 2: Evaluation timestamp precedes decision timestamp
        const timeInvertedRecord = {
          ...validRecord,
          evaluationTimestampMs: 900000, // Before decision (1000000)
        };
        const timeEligibility = validateShadowEvaluationEligibility(
          timeInvertedRecord,
          canonicalDecision,
        );
        expect(timeEligibility.isEligible).toBe(false);
        expect(
          timeEligibility.rejectionReasons.some((r) => r.includes("EVALUATION_PRECEDES_DECISION")),
        ).toBe(true);

        // Cohort Preservation Invariant: canonicalDecision.decisionCohort remains WATCHLIST_RADAR
        expect(canonicalDecision.decisionCohort).toBe("WATCHLIST_RADAR");
      });

      it("RF-D21.3d: D21C-01: createShadowEvaluationRecord factory strictly validates non-finite reserves and timestamps fail-closed", () => {
        const canonicalDecision = createMockDecision({
          eventId: "dec-canonical-fac-1",
          sessionId: "session-paper-d21",
          generationId: "gen-1",
          mintAddress: "TokenMint111111111111111111111111111111111111",
          poolId: "pool-amm-1",
          decisionTimestampMs: 2000,
        });

        const baseQualResult = {
          shadowTriggerQualified: true,
          qualificationReason: "MET_MOMENTUM_CRITERIA",
          simulatedTargetSizeSol: 0.1,
          executionFeasible: true,
        };

        // Auditor reproduction case 1: baseReserve: NaN
        expect(() =>
          createShadowEvaluationRecord({
            decision: canonicalDecision,
            qualificationResult: baseQualResult,
            evaluationTimestampMs: 2100,
            observedReserveSnapshot: {
              baseReserve: NaN,
              quoteReserve: 100,
              sourceTimestampMs: 1900,
            },
          }),
        ).toThrow("observedReserveSnapshot.baseReserve must be a non-negative finite number");

        // Auditor reproduction case 2: baseReserve: Infinity
        expect(() =>
          createShadowEvaluationRecord({
            decision: canonicalDecision,
            qualificationResult: baseQualResult,
            evaluationTimestampMs: 2100,
            observedReserveSnapshot: {
              baseReserve: Infinity,
              quoteReserve: 100,
              sourceTimestampMs: 1900,
            },
          }),
        ).toThrow("observedReserveSnapshot.baseReserve must be a non-negative finite number");

        // quoteReserve: NaN
        expect(() =>
          createShadowEvaluationRecord({
            decision: canonicalDecision,
            qualificationResult: baseQualResult,
            evaluationTimestampMs: 2100,
            observedReserveSnapshot: {
              baseReserve: 500000,
              quoteReserve: NaN,
              sourceTimestampMs: 1900,
            },
          }),
        ).toThrow("observedReserveSnapshot.quoteReserve must be a non-negative finite number");

        // quoteReserve: Infinity
        expect(() =>
          createShadowEvaluationRecord({
            decision: canonicalDecision,
            qualificationResult: baseQualResult,
            evaluationTimestampMs: 2100,
            observedReserveSnapshot: {
              baseReserve: 500000,
              quoteReserve: Infinity,
              sourceTimestampMs: 1900,
            },
          }),
        ).toThrow("observedReserveSnapshot.quoteReserve must be a non-negative finite number");

        // Auditor reproduction case 3: sourceTimestampMs: NaN
        expect(() =>
          createShadowEvaluationRecord({
            decision: canonicalDecision,
            qualificationResult: baseQualResult,
            evaluationTimestampMs: 2100,
            observedReserveSnapshot: {
              baseReserve: 500000,
              quoteReserve: 100,
              sourceTimestampMs: NaN,
            },
          }),
        ).toThrow("observedReserveSnapshot.sourceTimestampMs must be a positive finite number");

        // Auditor reproduction case 4: executionFeasible: false, evaluationTimestampMs: NaN
        expect(() =>
          createShadowEvaluationRecord({
            decision: canonicalDecision,
            qualificationResult: {
              ...baseQualResult,
              executionFeasible: false,
            },
            evaluationTimestampMs: NaN,
          }),
        ).toThrow("evaluationTimestampMs must be a positive finite number");

        // executionFeasible: true, evaluationTimestampMs: NaN
        expect(() =>
          createShadowEvaluationRecord({
            decision: canonicalDecision,
            qualificationResult: baseQualResult,
            evaluationTimestampMs: NaN,
            observedReserveSnapshot: {
              baseReserve: 500000,
              quoteReserve: 100,
              sourceTimestampMs: 1900,
            },
          }),
        ).toThrow("evaluationTimestampMs must be a positive finite number");

        // hostMonotonicElapsedMs: NaN
        expect(() =>
          createShadowEvaluationRecord({
            decision: canonicalDecision,
            qualificationResult: baseQualResult,
            evaluationTimestampMs: 2100,
            hostMonotonicElapsedMs: NaN,
            observedReserveSnapshot: {
              baseReserve: 500000,
              quoteReserve: 100,
              sourceTimestampMs: 1900,
            },
          }),
        ).toThrow("hostMonotonicElapsedMs, if present, must be a non-negative finite number");

        // Valid observational-only record (executionFeasible: false, no snapshot) returns valid record
        const obsRecord = createShadowEvaluationRecord({
          decision: canonicalDecision,
          qualificationResult: {
            shadowTriggerQualified: false,
            qualificationReason: "FAILED_VOLUME_CRITERIA",
            simulatedTargetSizeSol: 0,
            executionFeasible: false,
          },
          evaluationTimestampMs: 2100,
        });

        expect(obsRecord.schemaVersion).toBe("1.0.0");
        expect(obsRecord.evaluationTimestampMs).toBe(2100);
        expect(obsRecord.qualificationResult.executionFeasible).toBe(false);
        expect(obsRecord.observedReserveSnapshot).toBeUndefined();
      });
    });

    describe("D2.1-DELIV-3: Clock Monotonicity & Quarantine Validator (D2-PREREQ-01)", () => {
      it("RF-D21.4: accepts causally monotonic timestamps within allowed skew", () => {
        const result = validateClockMonotonicity({
          sourceTimestampMs: 10000,
          ingestionTimestampMs: 10050,
          responseReceivedMs: 10080,
          decisionTimestampMs: 10100,
        });

        expect(result.isCausallyMonotonic).toBe(true);
        expect(result.isQuarantined).toBe(false);
        expect(result.quarantineReasons).toHaveLength(0);
        expect(result.measuredSkewMs).toBe(-50); // provider slightly before ingestion
      });

      it("RF-D21.5: D2-PREREQ-01: responseReceivedMs < sourceTimestampMs is quarantined under IMPOSSIBLE_TIMESTAMP_ORDERING", () => {
        const result = validateClockMonotonicity({
          sourceTimestampMs: 990000,
          ingestionTimestampMs: 990100,
          responseReceivedMs: 980000, // Inverted: received before source!
          decisionTimestampMs: 1000000,
        });

        expect(result.isCausallyMonotonic).toBe(false);
        expect(result.isQuarantined).toBe(true);
        expect(result.unavailabilityReason).toBe("IMPOSSIBLE_TIMESTAMP_ORDERING");
        expect(
          result.quarantineReasons.some((r) => r.includes("IMPOSSIBLE_TIMESTAMP_ORDERING")),
        ).toBe(true);
      });

      it("RF-D21.5b: D21-AUD-01: rejects inverted source/ingestion time as causally monotonic", () => {
        // Exact Auditor reproduction case:
        // sourceTimestampMs: 2000, ingestionTimestampMs: 1000, responseReceivedMs: 2100, decisionTimestampMs: 2200
        const result = validateClockMonotonicity({
          sourceTimestampMs: 2000,
          ingestionTimestampMs: 1000,
          responseReceivedMs: 2100,
          decisionTimestampMs: 2200,
        });

        expect(result.isCausallyMonotonic).toBe(false);
        expect(result.isQuarantined).toBe(true);
        expect(result.attestationStatus).toBe("TOLERATED_CLOCK_SKEW_QUARANTINE");
        expect(result.unavailabilityReason).toBe("IMPOSSIBLE_TIMESTAMP_ORDERING");
        expect(result.measuredSkewMs).toBe(1000);
        expect(result.measuredIngestionLagMs).toBe(-1000);
        expect(result.quarantineReasons.some((r) => r.includes("CLOCK_SKEW_QUARANTINE"))).toBe(
          true,
        );
      });

      it("RF-D21.5c: D21-AUD-01: boundary regressions for provider source timestamp ahead of ingestion", () => {
        // Case 1: 1ms skew (source ahead by 1ms)
        const res1 = validateClockMonotonicity({
          sourceTimestampMs: 1001,
          ingestionTimestampMs: 1000,
          responseReceivedMs: 1050,
          decisionTimestampMs: 1100,
        });
        expect(res1.isCausallyMonotonic).toBe(false);
        expect(res1.isQuarantined).toBe(true);
        expect(res1.attestationStatus).toBe("TOLERATED_CLOCK_SKEW_QUARANTINE");
        expect(res1.measuredSkewMs).toBe(1);

        // Case 2: 4999ms skew (source ahead by 4999ms)
        const res4999 = validateClockMonotonicity({
          sourceTimestampMs: 5999,
          ingestionTimestampMs: 1000,
          responseReceivedMs: 6000,
          decisionTimestampMs: 6100,
        });
        expect(res4999.isCausallyMonotonic).toBe(false);
        expect(res4999.isQuarantined).toBe(true);
        expect(res4999.attestationStatus).toBe("TOLERATED_CLOCK_SKEW_QUARANTINE");
        expect(res4999.measuredSkewMs).toBe(4999);

        // Case 3: 5000ms boundary skew
        const res5000 = validateClockMonotonicity({
          sourceTimestampMs: 6000,
          ingestionTimestampMs: 1000,
          responseReceivedMs: 6000,
          decisionTimestampMs: 6100,
        });
        expect(res5000.isCausallyMonotonic).toBe(false);
        expect(res5000.isQuarantined).toBe(true);
        expect(res5000.attestationStatus).toBe("TOLERATED_CLOCK_SKEW_QUARANTINE");
        expect(res5000.measuredSkewMs).toBe(5000);

        // Case 4: 5001ms over-limit skew (exceeds MAX_ALLOWED_FORWARD_CLOCK_SKEW_MS)
        const res5001 = validateClockMonotonicity({
          sourceTimestampMs: 6001,
          ingestionTimestampMs: 1000,
          responseReceivedMs: 6050,
          decisionTimestampMs: 6100,
        });
        expect(res5001.isCausallyMonotonic).toBe(false);
        expect(res5001.isQuarantined).toBe(true);
        expect(res5001.attestationStatus).toBe("EXCESSIVE_CLOCK_SKEW_REJECTED");
        expect(res5001.measuredSkewMs).toBe(5001);
      });

      it("RF-D21.5d: D21-AUD-01: missing receipt evidence (responseReceivedMs: undefined) fails closed", () => {
        const result = validateClockMonotonicity({
          sourceTimestampMs: 1000,
          ingestionTimestampMs: 1050,
          responseReceivedMs: undefined, // Missing receipt evidence!
          decisionTimestampMs: 1100,
        });

        expect(result.isCausallyMonotonic).toBe(false);
        expect(result.isQuarantined).toBe(true);
        expect(result.attestationStatus).toBe("MISSING_RECEIPT_EVIDENCE");
        expect(result.unavailabilityReason).toBe("PROVIDER_RESPONSE_OMITTED_FIELD");
        expect(result.quarantineReasons.some((r) => r.includes("MISSING_RECEIPT_EVIDENCE"))).toBe(
          true,
        );
      });

      it("RF-D21.6: forward clock skew exceeding 5000ms is quarantined", () => {
        const result = validateClockMonotonicity({
          sourceTimestampMs: 20000, // 8000ms ahead of ingestion!
          ingestionTimestampMs: 12000,
          responseReceivedMs: 20500,
          decisionTimestampMs: 21000,
        });

        expect(result.isCausallyMonotonic).toBe(false);
        expect(result.isQuarantined).toBe(true);
        expect(result.unavailabilityReason).toBe("IMPOSSIBLE_TIMESTAMP_ORDERING");
        expect(
          result.quarantineReasons.some((r) => r.includes("EXCESSIVE_FORWARD_CLOCK_SKEW")),
        ).toBe(true);
      });

      it("RF-D21.7: lookahead leakage where sourceTimestampMs > decisionTimestampMs is quarantined", () => {
        const result = validateClockMonotonicity({
          sourceTimestampMs: 15000, // after decision!
          ingestionTimestampMs: 15050,
          responseReceivedMs: 15100,
          decisionTimestampMs: 12000,
        });

        expect(result.isCausallyMonotonic).toBe(false);
        expect(result.isQuarantined).toBe(true);
        expect(result.unavailabilityReason).toBe("LATE_RECEIPT_LOOKAHEAD_PREVENTION");
      });

      it("RF-D21.8: source timestamp derived solely from HTTP Date header fails closed", () => {
        const result = validateClockMonotonicity({
          sourceTimestampMs: 10000,
          ingestionTimestampMs: 10050,
          responseReceivedMs: 10100,
          decisionTimestampMs: 10200,
          isDerivedFromHttpDateHeaderOnly: true,
        });

        expect(result.isCausallyMonotonic).toBe(false);
        expect(result.isQuarantined).toBe(true);
        expect(
          result.quarantineReasons.some((r) => r.includes("HTTP_HEADER_TIMESTAMP_INSUFFICIENT")),
        ).toBe(true);
      });

      it("RF-D21.9: readiness scanner H3 matcher rejects adversarial fixture with recv < source", () => {
        const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "audit-d21-h3-"));
        const sessionDir = path.join(tempBase, "session-h3-d21");
        fs.mkdirSync(sessionDir, { recursive: true });

        const meta = createMockMeta({ sessionId: "session-h3-d21" });
        const summary = createMockSummary({ sessionId: "session-h3-d21" });

        // Decision with valid lpBurnPct at t = 1000000
        const decision = createMockDecision({
          sessionId: "session-h3-d21",
          decisionTimestampMs: 1000000,
          metricsSnapshot: {
            tokenAgeSec: 3600,
            liquidityUsd: 50000,
            marketCapUsd: 200000,
            lmcRatio: 0.25,
            lpBurnPct: 100, // Valid LP burn
            spotPriceUsd: 0.05,
            spotPriceSol: 0.00025,
            volume5mUsd: 1000,
            txCount5m: 10,
            buys5m: 6,
            sells5m: 4,
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
          },
        });

        // Adversarial observation: source=990000, ingestion=990100, recv=980000 (recv < source!)
        const adversarialObs = createMockObservation({
          sessionId: "session-h3-d21",
          sourceTimestampMs: 990000,
          ingestionTimestampMs: 990100,
          responseReceivedMs: 980000,
          holderMetrics: {
            top10ConcentrationPct: 20,
            devHoldingPct: 5,
            totalHolders: 150,
          },
        });

        fs.writeFileSync(path.join(sessionDir, "session-meta.json"), JSON.stringify(meta));
        fs.writeFileSync(path.join(sessionDir, "session-summary.json"), JSON.stringify(summary));
        fs.writeFileSync(
          path.join(sessionDir, "candidate-decisions.jsonl"),
          JSON.stringify(decision) + "\n",
        );
        fs.writeFileSync(
          path.join(sessionDir, "market-observations.jsonl"),
          JSON.stringify(adversarialObs) + "\n",
        );

        const audit = runReadinessAudit({
          rootDir: tempBase,
          telemetrySessionsDir: tempBase,
          legacySessionsDir: path.join(tempBase, "sessions"),
          reportOutputPath: path.join(tempBase, "REPORT.md"),
        });
        expect(audit.h3Feasible).toBe(false);
        expect(audit.eligibleH3DecisionsCount).toBe(0);

        fs.rmSync(tempBase, { recursive: true, force: true });
      });
    });

    describe("D2.1-DELIV-4: Statistical & Mathematical Reference Oracles", () => {
      it("RF-D21.10: computes exact Hájek mean and Kish effective sample size with hand-calculated reference", () => {
        // Values: [10, 20, 30], Probs: [0.5, 0.25, 0.1]
        // Weights: 1/0.5 = 2, 1/0.25 = 4, 1/0.1 = 10
        // Weighted sum: 10*2 + 20*4 + 30*10 = 20 + 80 + 300 = 400
        // Sum weights: 2 + 4 + 10 = 16
        // Hajek mean: 400 / 16 = 25.0
        // Kish ESS: 16^2 / (2^2 + 4^2 + 10^2) = 256 / (4 + 16 + 100) = 256 / 120 = 2.1333333333333333
        const result = computeHajekMean([10, 20, 30], [0.5, 0.25, 0.1]);

        expect(result.estimate).toBeCloseTo(25.0, 10);
        expect(result.sumWeights).toBeCloseTo(16.0, 10);
        expect(result.effectiveSampleSize).toBeCloseTo(256 / 120, 10);

        const total = computeHorvitzThompsonTotal([10, 20, 30], [0.5, 0.25, 0.1]);
        expect(total).toBeCloseTo(400.0, 10);
      });

      it("RF-D21.10b: D21-AUD-03: computeHajekMean throws fail-closed error on extreme/overflowing inclusion probability", () => {
        // Exact Auditor reproduction case:
        // computeHajekMean([10, 20], [Number.MIN_VALUE, 0.5])
        expect(() => computeHajekMean([10, 20], [Number.MIN_VALUE, 0.5])).toThrow(
          "below minimum supported threshold",
        );

        // Also rejects non-finite sample values
        expect(() => computeHajekMean([10, NaN], [0.5, 0.5])).toThrow("invalid non-finite value");
      });

      it("RF-D21.10c: D21-AUD-03: computeHorvitzThompsonTotal throws fail-closed error on extreme or non-finite inputs", () => {
        expect(() => computeHorvitzThompsonTotal([10, 20], [Number.MIN_VALUE, 0.5])).toThrow(
          "below minimum supported threshold",
        );
        expect(() => computeHorvitzThompsonTotal([10, Infinity], [0.5, 0.5])).toThrow(
          "invalid non-finite value",
        );
      });

      it("RF-D21.11: computes Cameron-Gelbach-Miller two-way cluster-robust covariance with small cluster safeguard", () => {
        const residuals = [0.1, -0.2, 0.15, -0.05];
        const X = [
          [1, 0.5],
          [1, 0.8],
          [1, 0.2],
          [1, 0.9],
        ];
        const sessions = ["ses-1", "ses-1", "ses-2", "ses-2"];
        const mints = ["mint-A", "mint-B", "mint-A", "mint-B"];

        const result = computeTwoWayClusterCovariance(residuals, X, sessions, mints);

        expect(result.vcovMatrix).toHaveLength(2);
        expect(result.standardErrors).toHaveLength(2);
        expect(result.standardErrors[0]).toBeGreaterThan(0);
        expect(result.standardErrors[1]).toBeGreaterThan(0);
        expect(result.numClustersSession).toBe(2);
        expect(result.numClustersMint).toBe(2);
        expect(result.isSmallClusterWarning).toBe(true);
        expect(result.smallClusterNote).toContain("Small cluster count");
      });

      it("RF-D21.11b: D21-AUD-03: computeTwoWayClusterCovariance rejects non-finite residuals/design matrix fail-closed", () => {
        // Exact Auditor reproduction case:
        // computeTwoWayClusterCovariance([1, NaN, 1], [[1, 0], [1, 1], [1, 2]], ["s1", "s2", "s3"], ["m1", "m2", "m3"])
        expect(() =>
          computeTwoWayClusterCovariance(
            [1, NaN, 1],
            [
              [1, 0],
              [1, 1],
              [1, 2],
            ],
            ["s1", "s2", "s3"],
            ["m1", "m2", "m3"],
          ),
        ).toThrow("non-finite residual at index 1: NaN");

        // Design matrix non-finite
        expect(() =>
          computeTwoWayClusterCovariance(
            [1, 2, 1],
            [
              [1, 0],
              [NaN, 1],
              [1, 2],
            ],
            ["s1", "s2", "s3"],
            ["m1", "m2", "m3"],
          ),
        ).toThrow("non-finite entry at X[1][0]: NaN");
      });

      it("RF-D21.12: stateful constant-product AMM execution waterfall deducts LP fee inside swap and loses on flat zero-alpha market", () => {
        // Pool: 1,000,000 tokens, 100 SOL. Buy size: 1.0 SOL. LP fee: 25 bps. Network fee: 0.0001 SOL per leg.
        const result = computeAmmRoundTripWaterfall({
          initialBaseReserve: 1000000,
          initialQuoteReserveSol: 100,
          buySizeSol: 1.0,
          lpFeeBps: 25,
          networkFeeSol: 0.0001,
          ataRentSol: 0.002,
          priceMultiplier: 1.0, // Flat market (zero alpha)
        });

        // 1. In a flat zero-alpha market, net cash return must be strictly negative due to LP fees + gas
        expect(result.netCashDeltaSol).toBeLessThan(0);
        expect(result.netCashReturnPct).toBeLessThan(0);

        // 2. Total network fees are 2 * 0.0001 = 0.0002 SOL
        expect(result.totalNetworkFeesSol).toBe(0.0002);

        // 3. ATA rent is neutral across closed round trip (deposit refunded)
        expect(result.ataRentNetSol).toBe(0);

        // 4. Exact swap proceeds check: proceeds < outlay
        expect(result.solProceedsSell).toBeLessThan(1.0);

        // 5. Net return is approx -0.52% (25 bps on buy + 25 bps on sell + network fees)
        expect(result.netCashReturnPct).toBeCloseTo(-0.52, 1);
      });

      it("RF-D21.12b: D21-AUD-04: computeAmmRoundTripWaterfall rejects negative network fees and invalid parameters fail-closed", () => {
        const baseParams = {
          initialBaseReserve: 1000000,
          initialQuoteReserveSol: 50,
          buySizeSol: 0.5,
          lpFeeBps: 25,
          networkFeeSol: 0.000015,
          ataRentSol: 0.002,
          priceMultiplier: 1.0,
        };

        // Auditor reproduction: networkFeeSol: -1 (fictitious profit)
        expect(() =>
          computeAmmRoundTripWaterfall({
            ...baseParams,
            networkFeeSol: -1,
          }),
        ).toThrow("networkFeeSol must be a non-negative finite number");

        // Auditor reproduction: lpFeeBps: NaN
        expect(() =>
          computeAmmRoundTripWaterfall({
            ...baseParams,
            lpFeeBps: NaN,
          }),
        ).toThrow("lpFeeBps must be a finite number between 0 and 10000");

        // Auditor reproduction: priceMultiplier: -1
        expect(() =>
          computeAmmRoundTripWaterfall({
            ...baseParams,
            priceMultiplier: -1,
          }),
        ).toThrow("priceMultiplier must be a positive finite number");

        // Zero or non-positive reserves / buy sizes
        expect(() =>
          computeAmmRoundTripWaterfall({
            ...baseParams,
            buySizeSol: 0,
          }),
        ).toThrow("buySizeSol must be a positive finite number");

        expect(() =>
          computeAmmRoundTripWaterfall({
            ...baseParams,
            initialBaseReserve: 0,
          }),
        ).toThrow("initialBaseReserve must be a positive finite number");
      });
    });

    describe("D2.1-DELIV-5: Read-Only Fedora Archive Parser", () => {
      it("RF-D21.13: returns REPORTED_NOT_INSPECTED when staging directory does not exist", () => {
        const missingDir = path.join(os.tmpdir(), "nonexistent-fedora-staging-dir-12345");
        const result = parseFedoraArchiveDirectory(missingDir);

        expect(result.status).toBe("REPORTED_NOT_INSPECTED");
        expect(result.filesAuditedCount).toBe(0);
        expect(result.sessionsAuditedCount).toBe(0);
        expect(result.operationalNotice).toContain("STRICTLY OFFLINE");
      });

      it("RF-D21.14: parses staged isolated legacy session and classifies H1-H4 features as UNAVAILABLE", () => {
        const tempStaging = fs.mkdtempSync(path.join(os.tmpdir(), "fedora-staging-"));
        const mockFedoraSession = {
          sessionId: "session-fedora-168h-test",
          startedAt: "2026-10-07T00:00:00.000Z",
          endedAt: "2026-10-14T00:00:00.000Z",
          startingCapitalSol: 10.0,
          endingCapitalSol: 9.2,
          netPnlSol: -0.8,
          trades: [
            {
              tradeId: "trade-fedora-1",
              mintAddress: "FedoraMint1111111111111111111111111111111111",
              symbol: "FED",
              entryPriceSol: 0.001,
              exitPriceSol: 0.0009,
              sizeSol: 0.5,
              enteredAt: "2026-10-08T12:00:00.000Z",
              exitedAt: "2026-10-08T12:15:00.000Z",
              finalPnlSol: -0.05,
              exitReason: "TRAILING_STOP",
            },
          ],
        };

        fs.writeFileSync(
          path.join(tempStaging, "session-fedora-168h-test.json"),
          JSON.stringify(mockFedoraSession),
        );

        const result = parseFedoraArchiveDirectory(tempStaging);
        expect(result.status).toBe("ARCHIVE_CONFIRMED_PARSED");
        expect(result.filesAuditedCount).toBe(1);
        expect(result.sessionsAuditedCount).toBe(1);

        const session = result.sessions[0]!;
        expect(session.sessionId).toBe("session-fedora-168h-test");
        expect(session.netPnlSol).toBe(-0.8);
        expect(session.totalTrades).toBe(1);
        expect(session.sha256).toHaveLength(64);

        // Feature provenance check:
        expect(session.fieldProvenance.netPnlSol).toBe("OBSERVED");
        expect(session.fieldProvenance.baseReserve).toBe("UNAVAILABLE");
        expect(session.fieldProvenance.quoteReserve).toBe("UNAVAILABLE");
        expect(session.fieldProvenance.buys5m).toBe("UNAVAILABLE");
        expect(session.fieldProvenance.devHoldingPct).toBe("UNAVAILABLE");

        fs.rmSync(tempStaging, { recursive: true, force: true });
      });

      it("RF-D21.14b: D21-AUD-02: parseFedoraArchiveDirectory quarantines unrelated and malformed JSON fail-closed", () => {
        const tempStaging = fs.mkdtempSync(path.join(os.tmpdir(), "fedora-quarantine-"));

        // Exact Auditor reproduction case:
        // File 1: unrelated JSON {"foo":"bar"}
        fs.writeFileSync(path.join(tempStaging, "unrelated.json"), JSON.stringify({ foo: "bar" }));

        // File 2: malformed session {"sessionId":"fake","trades":[{"sizeSol":"NaN"}],"netPnlSol":"INVALID"}
        fs.writeFileSync(
          path.join(tempStaging, "malformed.json"),
          JSON.stringify({
            sessionId: "fake",
            trades: [{ sizeSol: "NaN" }],
            netPnlSol: "INVALID",
          }),
        );

        const result = parseFedoraArchiveDirectory(tempStaging);

        // Crucial invariant: never mark ARCHIVE_CONFIRMED_PARSED for arbitrary or malformed JSON
        expect(result.status).toBe("REPORTED_NOT_INSPECTED");
        expect(result.filesAuditedCount).toBe(2);
        expect(result.sessionsAuditedCount).toBe(0);
        expect(result.malformedOrUnrelatedFilesCount).toBe(2);
        expect(result.quarantinedFiles).toHaveLength(2);
        expect(result.sessions).toHaveLength(0);

        // Rejection reasons are recorded
        expect(result.quarantinedFiles[0]!.rejectionReason).toContain("sessionId");
        expect(result.quarantinedFiles[1]!.rejectionReason).toContain("sessionId");

        fs.rmSync(tempStaging, { recursive: true, force: true });
      });

      it("RF-D21.14c: D21-AUD-02: rejects incomplete session or non-finite financial capital fail-closed", () => {
        const tempStaging = fs.mkdtempSync(path.join(os.tmpdir(), "fedora-incomplete-"));

        // Incomplete session: valid sessionId prefix but missing mandatory endedAt and negative capital
        fs.writeFileSync(
          path.join(tempStaging, "incomplete.json"),
          JSON.stringify({
            sessionId: "session-fedora-broken",
            startedAt: "2026-10-07T00:00:00.000Z",
            startingCapitalSol: -10.0,
            endingCapitalSol: 9.2,
            netPnlSol: -0.8,
            trades: [],
          }),
        );

        const result = parseFedoraArchiveDirectory(tempStaging);
        expect(result.status).toBe("REPORTED_NOT_INSPECTED");
        expect(result.sessionsAuditedCount).toBe(0);
        expect(result.malformedOrUnrelatedFilesCount).toBe(1);
        expect(result.quarantinedFiles[0]!.rejectionReason).toContain("endedAt");

        fs.rmSync(tempStaging, { recursive: true, force: true });
      });

      it("RF-D21.14d: D21C-02: parseFedoraArchiveDirectory rejects trades whose entry/exit chronology falls outside session interval", () => {
        const tempStaging = fs.mkdtempSync(path.join(os.tmpdir(), "fedora-out-of-window-"));

        // Exact Auditor reproduction case:
        // Session interval: 2026-10-01T00:00:00.000Z to 2026-10-01T01:00:00.000Z
        // Trade interval:   2026-10-02T00:10:00.000Z to 2026-10-02T00:20:00.000Z (next day!)
        const outOfWindowSession = {
          sessionId: "session-fedora-out-of-window",
          startedAt: "2026-10-01T00:00:00.000Z",
          endedAt: "2026-10-01T01:00:00.000Z",
          startingCapitalSol: 10.0,
          endingCapitalSol: 9.5,
          netPnlSol: -0.5,
          trades: [
            {
              tradeId: "trade-next-day",
              mintAddress: "NextDayMint11111111111111111111111111111111",
              symbol: "NEXT",
              entryPriceSol: 0.001,
              exitPriceSol: 0.0005,
              sizeSol: 0.5,
              enteredAt: "2026-10-02T00:10:00.000Z", // Next day!
              exitedAt: "2026-10-02T00:20:00.000Z",
              finalPnlSol: -0.25,
              exitReason: "STOP_LOSS",
            },
          ],
        };

        fs.writeFileSync(
          path.join(tempStaging, "out-of-window.json"),
          JSON.stringify(outOfWindowSession),
        );

        const result = parseFedoraArchiveDirectory(tempStaging);
        expect(result.status).toBe("REPORTED_NOT_INSPECTED");
        expect(result.sessionsAuditedCount).toBe(0);
        expect(result.malformedOrUnrelatedFilesCount).toBe(1);
        expect(result.quarantinedFiles[0]!.rejectionReason).toContain(
          "chronology lies outside session interval",
        );

        fs.rmSync(tempStaging, { recursive: true, force: true });
      });

      it("RF-D21.14e: D21C-02: parseFedoraArchiveDirectory flags financially contradictory session/trade P&L as UNRECONCILED with auditable reconciliation items", () => {
        const tempStaging = fs.mkdtempSync(path.join(os.tmpdir(), "fedora-unreconciled-"));

        // Exact Auditor reproduction case:
        // Session: start 10 SOL, end 10 SOL, declared netPnlSol = 0
        // Trade: 1 trade with netPnlSol = +0.5 SOL
        const contradictorySession = {
          sessionId: "session-fedora-unreconciled-pnl",
          startedAt: "2026-10-01T00:00:00.000Z",
          endedAt: "2026-10-01T01:00:00.000Z",
          startingCapitalSol: 10.0,
          endingCapitalSol: 10.0,
          netPnlSol: 0.0,
          trades: [
            {
              tradeId: "trade-contradictory-1",
              mintAddress: "ContradictoryMint11111111111111111111111111",
              symbol: "CONTRA",
              entryPriceSol: 0.001,
              exitPriceSol: 0.002,
              sizeSol: 0.5,
              enteredAt: "2026-10-01T00:10:00.000Z",
              exitedAt: "2026-10-01T00:20:00.000Z",
              finalPnlSol: 0.5,
              exitReason: "TAKE_PROFIT",
            },
          ],
        };

        fs.writeFileSync(
          path.join(tempStaging, "contradictory.json"),
          JSON.stringify(contradictorySession),
        );

        const result = parseFedoraArchiveDirectory(tempStaging);
        // Valid archive is parsed (not rejected solely due to settlement/accounting discrepancy)
        expect(result.status).toBe("ARCHIVE_CONFIRMED_PARSED");
        expect(result.sessionsAuditedCount).toBe(1);

        const session = result.sessions[0]!;
        // Distinct UNRECONCILED status emitted
        expect(session.reconciliationStatus).toBe("UNRECONCILED");
        expect(session.financialReconciliation.status).toBe("UNRECONCILED");
        expect(session.financialReconciliation.tradePnlDiscrepancySol).toBe(0.5);
        expect(session.reconciliationWarnings.length).toBeGreaterThan(0);
        expect(session.reconciliationWarnings.some((w) => w.includes("TRADE_PNL_MISMATCH"))).toBe(
          true,
        );

        fs.rmSync(tempStaging, { recursive: true, force: true });
      });

      it("RF-D21.14f: D21C-02: parseFedoraArchiveDirectory correctly classifies valid zero-trade sessions with unavailable trade-level fields", () => {
        const tempStaging = fs.mkdtempSync(path.join(os.tmpdir(), "fedora-zero-trades-"));

        // Valid zero-trade session:
        const zeroTradeSession = {
          sessionId: "session-fedora-zero-trades",
          startedAt: "2026-10-01T00:00:00.000Z",
          endedAt: "2026-10-01T01:00:00.000Z",
          startingCapitalSol: 10.0,
          endingCapitalSol: 10.0,
          netPnlSol: 0.0,
          trades: [],
        };

        fs.writeFileSync(
          path.join(tempStaging, "zero-trades.json"),
          JSON.stringify(zeroTradeSession),
        );

        const result = parseFedoraArchiveDirectory(tempStaging);
        expect(result.status).toBe("ARCHIVE_CONFIRMED_PARSED");
        expect(result.sessionsAuditedCount).toBe(1);

        const session = result.sessions[0]!;
        expect(session.totalTrades).toBe(0);
        expect(session.trades).toHaveLength(0);
        expect(session.reconciliationStatus).toBe("RECONCILED");
        expect(session.reconciliationWarnings).toHaveLength(0);

        // Session-level netPnl is OBSERVED
        expect(session.fieldProvenance.netPnlSol).toBe("OBSERVED");

        // CRITICAL INVARIANT: Trade-level fields must NOT be fabricated as OBSERVED for zero-trade sessions
        expect(session.fieldProvenance.tradeTimestamps).toBe("UNAVAILABLE");
        expect(session.fieldProvenance.solSize).toBe("UNAVAILABLE");
        expect(session.unavailabilityReasons.tradeTimestamps).toBe(
          "FIELD_NOT_COLLECTED_IN_GENERATION",
        );
        expect(session.unavailabilityReasons.solSize).toBe("FIELD_NOT_COLLECTED_IN_GENERATION");

        fs.rmSync(tempStaging, { recursive: true, force: true });
      });
    });
  });
});
