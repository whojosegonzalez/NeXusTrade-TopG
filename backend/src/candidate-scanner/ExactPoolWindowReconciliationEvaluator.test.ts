import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluateExactPoolWindowReconciliation,
  toCandidateFlowResult,
  type SourceCutoffEvidence,
  DEFAULT_PROVIDER_INDEX_ASSUMPTIONS,
  DEFAULT_UNRESOLVED_UNCERTAINTIES,
} from "./ExactPoolWindowReconciliationEvaluator.js";
import {
  validateAndSnapshotCandidateFlowResult,
  type CandidateFlowTarget,
} from "./CandidateFlowProvider.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import type { TrackedRaydiumPoolContext } from "./RaydiumAmmV4SwapDecoder.js";
import type { HistorySignatureRecord } from "./ExactPoolHistoryEnumerator.js";
import type { ResolvedSignatureRecord } from "./ExactPoolTransactionResolutionBridge.js";
import type { StreamGap, TradeEvent } from "./RollingTradeFlowTracker.js";

const CANONICAL_POOL_ID = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";
const CANONICAL_TOKEN_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const CANONICAL_PC_MINT = "So11111111111111111111111111111111111111112";
const CANONICAL_COIN_VAULT = "EkVZ1kV8V2B5U7T3k2Z2x8r8m4K7J3W3e5R2T6U8V9Y";
const CANONICAL_PC_VAULT = "FkVZ1kV8V2B5U7T3k2Z2x8r8m4K7J3W3e5R2T6U8V9Z";

const VALID_POOL_CONTEXT: TrackedRaydiumPoolContext = Object.freeze({
  poolId: CANONICAL_POOL_ID,
  candidateTokenMint: CANONICAL_TOKEN_MINT,
  quoteTokenMint: CANONICAL_PC_MINT,
  baseVault: CANONICAL_COIN_VAULT,
  quoteVault: CANONICAL_PC_VAULT,
  baseMint: CANONICAL_TOKEN_MINT,
  quoteMint: CANONICAL_PC_MINT,
  orientation: "TOKEN_BASE_SOL_QUOTE" as const,
});

describe("Phase 12.94-D Milestone D.3.3: Exact-Pool Window Reconciliation Evaluator", () => {
  let budgetManager: GlobalResourceBudgetManager;

  beforeEach(() => {
    budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 120,
      maxEnrichmentAttempts: 10,
      minReservedForwardRequests: 4,
      minProviderSpacingMs: 2500,
    });
  });

  describe("1. Warm-Up & Incomplete Observation Handling", () => {
    it("rejects the proposal's Scenario A [-5s, 55s] window as WARM_UP due to observation starting at 0s", () => {
      // Scenario A flaw: observation started at 0ms, watermark at 55_000ms.
      // Requested 60s window ending at 55s is [-5000ms, 55_000ms].
      // Observation from 0ms did not cover [-5000ms, 0ms].
      const cutoffEvidence: SourceCutoffEvidence = {
        sourceMethod: "getSignaturesForAddress",
        responseField: "result[0].blockTime",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_100,
        cutoffTimestampMs: 55_000,
        retrievedAtMs: 55_050,
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 60_000,
        observationStartMs: 0,
        observationEndMs: 55_000,
        sourceCutoff: cutoffEvidence,
        budgetManager,
      });

      expect(result.status).toBe("WARM_UP");
      expect(result.flowCoverage).toBe("WARM_UP");
      expect(result.isCoverageSufficient).toBe(false);
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.flowCounts.recentSells60s).toBeNull();
      expect(result.flowCounts.flowRatio).toBeNull();
      expect(result.temporalContext.windowStartMs).toBe(-5000);
      expect(result.temporalContext.windowEndMs).toBe(55_000);
      expect(result.diagnosticReason).toContain(
        "WARM_UP: Observation started at 0 ms, after window start -5000 ms (unobserved duration: 5000 ms)",
      );
    });

    it("rejects observation that ended before the source cutoff as INCOMPLETE_OBSERVATION", () => {
      const cutoffEvidence: SourceCutoffEvidence = {
        sourceMethod: "getSlot",
        responseField: "result",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_150,
        cutoffTimestampMs: 70_000,
        retrievedAtMs: 70_050,
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 71_000,
        observationStartMs: 5000,
        observationEndMs: 68_000, // ended 2000ms before cutoff at 70_000
        sourceCutoff: cutoffEvidence,
        budgetManager,
      });

      expect(result.status).toBe("INCOMPLETE_OBSERVATION");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.isCoverageSufficient).toBe(false);
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.flowCounts.recentSells60s).toBeNull();
      expect(result.diagnosticReason).toContain(
        "INCOMPLETE_OBSERVATION: Observation ended at 68000 ms, before source cutoff 70000 ms",
      );
    });
  });

  describe("2. Genuinely Full-Duration Quiet-Window Fixture", () => {
    it("successfully reconciles 0 buys and 0 sells for a full-duration quiet window under explicit provider assumptions", () => {
      // Corrected Scenario A: observation started at 0ms, cutoff at 65_000ms.
      // Window is [5_000ms, 65_000ms] spanning 60 seconds.
      // Observation [0, 65_000] fully covers [5000, 65_000].
      const cutoffEvidence: SourceCutoffEvidence = {
        sourceMethod: "getSlot",
        responseField: "result",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_200,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_040,
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: cutoffEvidence,
        historyRecords: [], // zero transactions indexed for pool
        budgetManager,
      });

      expect(result.status).toBe("RECONCILED");
      expect(result.flowCoverage).toBe("SUFFICIENT");
      expect(result.isCoverageSufficient).toBe(true);
      expect(result.flowCounts.recentBuys60s).toBe(0);
      expect(result.flowCounts.recentSells60s).toBe(0);
      expect(result.flowCounts.flowRatio).toBe(1.0);
      expect(result.temporalContext.windowStartMs).toBe(5000);
      expect(result.temporalContext.windowEndMs).toBe(65_000);
      expect(result.temporalContext.evidenceAgeMs).toBe(1000);

      // Invariant checks: not cryptographic, not production completeness
      expect(result.isCryptographicCompletenessEstablished).toBe(false);
      expect(result.isProductionCompletenessEstablished).toBe(false);

      // Explicit provider assumptions and unresolved uncertainties
      expect(result.providerAssumptions).toEqual(DEFAULT_PROVIDER_INDEX_ASSUMPTIONS);
      expect(result.unresolvedUncertainties).toEqual(DEFAULT_UNRESOLVED_UNCERTAINTIES);
      expect(result.diagnosticReason).toContain(
        "RECONCILED: Verified quiet window under declared provider-relative assumptions (0 buys, 0 sells in 60s window)",
      );
    });
  });

  describe("3. Missing and Invalid Source Cutoff Evidence", () => {
    it("fails closed with MISSING_SOURCE_CUTOFF when sourceCutoff is null despite empty history", () => {
      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 60_000,
        observationStartMs: 0,
        observationEndMs: 60_000,
        sourceCutoff: null,
        historyRecords: [],
        budgetManager,
      });

      expect(result.status).toBe("MISSING_SOURCE_CUTOFF");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.isCoverageSufficient).toBe(false);
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.flowCounts.recentSells60s).toBeNull();
      expect(result.diagnosticReason).toContain(
        "MISSING_SOURCE_CUTOFF: Source cutoff evidence was not provided. An empty getSignaturesForAddress response alone does not establish an on-chain source cutoff",
      );
    });

    it("fails closed with INVALID_SOURCE_CUTOFF when provenance or commitment fields are invalid", () => {
      const invalidCutoff = {
        sourceMethod: "unknownMethod",
        responseField: "res",
        commitment: "unconfirmed",
        provenance: "LOCAL_HOST_CLOCK", // illegal provenance!
        slot: 100,
        cutoffTimestampMs: 60_000,
        retrievedAtMs: 60_010,
      } as unknown as SourceCutoffEvidence;

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 61_000,
        observationStartMs: 0,
        observationEndMs: 60_000,
        sourceCutoff: invalidCutoff,
        budgetManager,
      });

      expect(result.status).toBe("INVALID_SOURCE_CUTOFF");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.isCoverageSufficient).toBe(false);
      expect(result.flowCounts.recentBuys60s).toBeNull();
    });
  });

  describe("4. Edge Cases: Timestamps, Identity, Gaps, Stale Evidence & Backlog", () => {
    const validCutoff: SourceCutoffEvidence = {
      sourceMethod: "getSlot",
      responseField: "result",
      commitment: "confirmed",
      provenance: "ON_CHAIN_BLOCK_TIME",
      slot: 280_000_100,
      cutoffTimestampMs: 65_000,
      retrievedAtMs: 65_020,
    };

    it("fails closed on non-integer or inverted observation timestamps", () => {
      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 70_000, // starts AFTER end!
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        budgetManager,
      });

      expect(result.status).toBe("INVALID_INPUT");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.diagnosticReason).toContain(
        "observationStartMs (70000) cannot exceed observationEndMs (65000)",
      );
    });

    it("fails closed on candidate identity mismatch in history enumeration result", () => {
      const wrongPoolHistory = {
        outcome: "ANCHOR_WITNESSED" as const,
        candidatePoolId: "DifferentPool1111111111111111111111111111111",
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature:
          "AnchorSig11111111111111111111111111111111111111111111111111111111111111111111111111111111",
        frozenTargetSignature:
          "TargetSig11111111111111111111111111111111111111111111111111111111111111111111111111111111",
        discoveredSignatures: [],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false as const,
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyResult: wrongPoolHistory,
        budgetManager,
      });

      expect(result.status).toBe("IDENTITY_MISMATCH");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.diagnosticReason).toContain(
        "History enumeration result poolId 'DifferentPool1111111111111111111111111111111' does not match pool context",
      );
    });

    it("fails closed with STREAM_GAP when a stream gap intersects the 60-second window", () => {
      const recordedGap: StreamGap = {
        gapStartMs: 20_000,
        gapEndMs: 25_000,
        reason: "WEBSOCKET_HEARTBEAT_TIMEOUT",
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        recordedGaps: [recordedGap],
        budgetManager,
      });

      expect(result.status).toBe("STREAM_GAP");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.diagnosticReason).toContain(
        "COLLECTION_GAP: Stream gap witnessed in observation window [20000, 25000] (reason: WEBSOCKET_HEARTBEAT_TIMEOUT)",
      );
    });

    it("fails closed with STALE_DATA when source cutoff age exceeds maxAllowedEvidenceAgeMs", () => {
      const staleCutoff: SourceCutoffEvidence = {
        sourceMethod: "getSlot",
        responseField: "result",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_100,
        cutoffTimestampMs: 40_000, // 40s
        retrievedAtMs: 40_050,
      };

      // decision at 60s, age is 20s > 15s limit
      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 60_000,
        observationStartMs: 0,
        observationEndMs: 40_000,
        sourceCutoff: staleCutoff,
        maxAllowedEvidenceAgeMs: 15_000,
        budgetManager,
      });

      expect(result.status).toBe("STALE_DATA");
      expect(result.flowCoverage).toBe("STALE_DATA");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.diagnosticReason).toContain(
        "STALE_DATA: Source cutoff age (20000 ms) exceeds max allowed evidence age (15000 ms)",
      );
    });

    it("fails closed with PROCESSING_BACKLOG when hasActiveBacklog is true", () => {
      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        hasActiveBacklog: true,
        budgetManager,
      });

      expect(result.status).toBe("PROCESSING_BACKLOG");
      expect(result.flowCoverage).toBe("PROCESSING_BACKLOG");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.diagnosticReason).toContain(
        "PROCESSING_BACKLOG: Active transaction queue backlog present at evaluation time",
      );
    });

    it("fails closed with UNWITNESSED_PRIOR_ANCHOR when history stops before reaching window start", () => {
      // Window is [5_000, 65_000]. Signatures discovered at 50s and 40s, but oldest is 40s > 5s and no anchor witnessed.
      const partialSignatures: HistorySignatureRecord[] = [
        {
          signature:
            "SigA1111111111111111111111111111111111111111111111111111111111111111111111111111111111111111",
          slot: 280_000_050,
          err: null,
          blockTime: 50,
        },
        {
          signature:
            "SigB1111111111111111111111111111111111111111111111111111111111111111111111111111111111111111",
          slot: 280_000_040,
          err: null,
          blockTime: 40,
        },
      ];

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyRecords: partialSignatures,
        knownAnchorSignature:
          "SomeAnchorSigNotWitnessed11111111111111111111111111111111111111111111111111111111111111111",
        budgetManager,
      });

      expect(result.status).toBe("UNWITNESSED_PRIOR_ANCHOR");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.diagnosticReason).toContain(
        "COLLECTION_GAP: History enumeration did not witness prior boundary anchor at or before window start (5000 ms)",
      );
    });

    it("fails closed with UNRESOLVED_TRANSACTIONS when a signature in the window failed resolution", () => {
      const sig1 =
        "Sig11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
      const sig2 =
        "Sig22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222";

      const historyRecords: HistorySignatureRecord[] = [
        { signature: sig1, slot: 280_000_050, err: null, blockTime: 50 },
        { signature: sig2, slot: 280_000_030, err: null, blockTime: 30 },
        { signature: "Anchor000", slot: 280_000_001, err: null, blockTime: 1 }, // witnessed anchor before window start
      ];

      const resolvedSignatures: ResolvedSignatureRecord[] = [
        {
          signature: sig1,
          slot: 280_000_050,
          blockTime: 50,
          status: "RESOLVED",
          decodedEventsCount: 1,
          ingestedEventsCount: 1,
        },
        {
          signature: sig2,
          slot: 280_000_030,
          blockTime: 30,
          status: "FAILED_DECODE", // Failed decode!
          decodedEventsCount: 0,
          ingestedEventsCount: 0,
          error: "INVALID_INSTRUCTION_DATA",
        },
      ];

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyRecords,
        resolvedSignatures,
        knownAnchorSignature: "Anchor000",
        budgetManager,
      });

      expect(result.status).toBe("UNRESOLVED_TRANSACTIONS");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.diagnosticReason).toContain(
        "Signature 'Sig22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222' failed resolution with status 'FAILED_DECODE'",
      );
    });

    it("fails closed with BUDGET_EXHAUSTED when request quota is exceeded", () => {
      const tightBudget = new GlobalResourceBudgetManager({
        maxTotalRequests: 120,
        maxEnrichmentAttempts: 1, // Only 1 attempt allowed!
        minReservedForwardRequests: 4,
      });

      const sig1 =
        "Sig11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
      const sig2 =
        "Sig22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222";

      // 2 unresolved signatures + 1 watermark + 1 history = 4 requests demanded, but quota is 1
      const historyRecords: HistorySignatureRecord[] = [
        { signature: sig1, slot: 280_000_050, err: null, blockTime: 50 },
        { signature: sig2, slot: 280_000_030, err: null, blockTime: 30 },
        { signature: "Anchor000", slot: 280_000_001, err: null, blockTime: 1 },
      ];

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyRecords,
        knownAnchorSignature: "Anchor000",
        budgetManager: tightBudget,
      });

      expect(result.status).toBe("BUDGET_EXHAUSTED");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.diagnosticReason).toContain("BUDGET_EXHAUSTED");
    });
  });

  describe("5. Incremental Reuse & Accurate Start-to-Start Pacing Accounting", () => {
    it("accurately models start-to-start pacing and credits already-resolved transactions without redundant dispatches", () => {
      const sig1 =
        "Sig11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
      const sig2 =
        "Sig22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222";
      const sig3 =
        "Sig33333333333333333333333333333333333333333333333333333333333333333333333333333333333333333";
      const anchorSig =
        "AnchorSig0000000000000000000000000000000000000000000000000000000000000000000000000000000";

      const historyRecords: HistorySignatureRecord[] = [
        { signature: sig1, slot: 280_000_050, err: null, blockTime: 50 },
        { signature: sig2, slot: 280_000_040, err: null, blockTime: 40 },
        { signature: sig3, slot: 280_000_030, err: null, blockTime: 30 },
        { signature: anchorSig, slot: 280_000_001, err: null, blockTime: 1 },
      ];

      // sig1 and sig2 were already incrementally resolved in-stream!
      const alreadyResolved = new Set<string>([sig1, sig2]);

      const trades: TradeEvent[] = [
        {
          eventId: `${sig1}:0:0`,
          signature: sig1,
          swapIndex: 0,
          outerInstructionIndex: 0,
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          side: "BUY",
          slot: 280_000_050,
          blockTimeSec: 50,
          eventTimestampMs: 50_000,
          receiptTimestampMs: 50_100,
          timestampProvenance: "ON_CHAIN_BLOCK_TIME",
        },
        {
          eventId: `${sig2}:0:0`,
          signature: sig2,
          swapIndex: 0,
          outerInstructionIndex: 0,
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          side: "BUY",
          slot: 280_000_040,
          blockTimeSec: 40,
          eventTimestampMs: 40_000,
          receiptTimestampMs: 40_100,
          timestampProvenance: "ON_CHAIN_BLOCK_TIME",
        },
        {
          eventId: `${sig3}:0:0`,
          signature: sig3,
          swapIndex: 0,
          outerInstructionIndex: 0,
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          side: "SELL",
          slot: 280_000_030,
          blockTimeSec: 30,
          eventTimestampMs: 30_000,
          receiptTimestampMs: 30_100,
          timestampProvenance: "ON_CHAIN_BLOCK_TIME",
        },
      ];

      const cutoffEvidence: SourceCutoffEvidence = {
        sourceMethod: "getSignaturesForAddress",
        responseField: "result[0].blockTime",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_050,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_030,
      };

      // Dispatches needed:
      // 1 watermark query + 1 history page query + 1 unresolved transaction (sig3) = 3 queries.
      // (sig1 and sig2 require 0 queries!)
      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: cutoffEvidence,
        historyRecords,
        alreadyResolvedSignatures: alreadyResolved,
        trades,
        knownAnchorSignature: anchorSig,
        budgetManager,
        minHostPacingMs: 2500,
        simulatedLatenciesMs: [100, 100, 100], // each request takes 100ms
      });

      expect(result.status).toBe("RECONCILED");
      expect(result.flowCoverage).toBe("SUFFICIENT");
      expect(result.flowCounts.recentBuys60s).toBe(2);
      expect(result.flowCounts.recentSells60s).toBe(1);
      expect(result.flowCounts.flowRatio).toBe(2.0); // 2 buys / 1 sell = 2.0
      expect(result.underlyingOutcomes.incrementallyReusedCount).toBe(2);
      expect(result.underlyingOutcomes.windowSignaturesCount).toBe(3);

      // Total requests dispatched: 1 (watermark) + 1 (history) + 1 (unresolved sig3) = 3
      expect(result.resourceMetrics.totalRequestsDispatched).toBe(3);

      // Start-to-start pacing check:
      // Request 1: starts at t=0, duration=100ms (wait = 0)
      // Request 2: starts at t=2500, duration=100ms (wait = 2500 - 100 = 2400)
      // Request 3: starts at t=5000, duration=100ms (wait = 2500 - 100 = 2400)
      // Total pacing wait: 2400 + 2400 = 4800ms
      // Total retrieval duration: 4800ms (waits) + 300ms (latencies) = 5100ms
      expect(result.resourceMetrics.totalPacingWaitMs).toBe(4800);
      expect(result.resourceMetrics.totalRetrievalDurationMs).toBe(5100);
    });
  });

  describe("6. Known Index-Omission Limitation Acknowledgement", () => {
    it("acknowledges upstream index omission limitation without claiming it is independently detectable", () => {
      // Synthetic counterexample: history page contains boundary anchors A_prior and A_post,
      // but upstream indexer omitted an intermediate transaction.
      const anchorPrior =
        "AnchorPrior1111111111111111111111111111111111111111111111111111111111111111111111111111111";
      const anchorPost =
        "AnchorPost11111111111111111111111111111111111111111111111111111111111111111111111111111111";

      const historyRecords: HistorySignatureRecord[] = [
        { signature: anchorPost, slot: 280_000_100, err: null, blockTime: 65 },
        // (Intermediate transaction omitted by upstream indexer here)
        { signature: anchorPrior, slot: 280_000_001, err: null, blockTime: 1 },
      ];

      const cutoffEvidence: SourceCutoffEvidence = {
        sourceMethod: "getSignaturesForAddress",
        responseField: "result[0].blockTime",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_100,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_030,
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: cutoffEvidence,
        historyRecords,
        knownAnchorSignature: anchorPrior,
        budgetManager,
      });

      // Contractual reality: standard RPC pagination passes anchor witnessing
      expect(result.status).toBe("RECONCILED");
      expect(result.underlyingOutcomes.anchorWitnessed).toBe(true);

      // The evaluator MUST NOT claim cryptographic completeness; it must explicitly declare limitations
      expect(result.isCryptographicCompletenessEstablished).toBe(false);
      expect(result.isProductionCompletenessEstablished).toBe(false);

      expect(result.providerAssumptions).toContain(
        "Standard RPC pagination satisfies anchor witnessing without verifying omission of intermediate transactions",
      );
      expect(result.unresolvedUncertainties).toContain(
        "Upstream index omission: dropped intermediate transactions are undetectable via ordinary JSON-RPC pagination",
      );
    });
  });

  describe("7. Production Protection Seam (No Bypass Invariant)", () => {
    it("ensures production counts strictly remain null and coverage COLLECTION_GAP despite a positive offline reconciliation result", () => {
      const cutoffEvidence: SourceCutoffEvidence = {
        sourceMethod: "getSlot",
        responseField: "result",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_200,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_040,
      };

      // 1. Evaluate offline reconciliation (which succeeds with 0 buys, 0 sells)
      const reconResult = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: cutoffEvidence,
        historyRecords: [],
        budgetManager,
      });
      expect(reconResult.status).toBe("RECONCILED");
      expect(reconResult.flowCoverage).toBe("SUFFICIENT");

      // 2. Convert to CandidateFlowResult under default production settings (allowSyntheticCompletenessProofs: false)
      const prodFlowResult = toCandidateFlowResult(reconResult);

      // Safety Invariant: production counts strictly remain null and coverage COLLECTION_GAP
      expect(prodFlowResult.recentBuys60s).toBeNull();
      expect(prodFlowResult.recentSells60s).toBeNull();
      expect(prodFlowResult.flowCoverage).toBe("COLLECTION_GAP");
      expect(prodFlowResult.isCoverageSufficient).toBe(false);
      expect(prodFlowResult.evaluationTimestampMs).toBe(66_000);
      expect(prodFlowResult.diagnosticReason).toContain("PRODUCTION_COVERAGE_PROTECTED");

      // 3. Verify against the shared decision boundary validation seam
      const target: CandidateFlowTarget = {
        poolAddress: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
      };

      const snapshotted = validateAndSnapshotCandidateFlowResult(prodFlowResult, target, 66_000);
      expect(snapshotted.isCoverageSufficient).toBe(false);
      expect(snapshotted.flowCoverage).toBe("COLLECTION_GAP");
      expect(snapshotted.recentBuys60s).toBeNull();
      expect(snapshotted.recentSells60s).toBeNull();
      expect(snapshotted.evaluationTimestampMs).toBe(66_000);
    });

    it("allows synthetic test harness to consume reconciled counts when allowSyntheticCompletenessProofs is true", () => {
      const cutoffEvidence: SourceCutoffEvidence = {
        sourceMethod: "getSlot",
        responseField: "result",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_200,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_040,
      };

      const reconResult = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: cutoffEvidence,
        historyRecords: [],
        budgetManager,
      });

      // In isolated synthetic test mode:
      const testFlowResult = toCandidateFlowResult(reconResult, {
        allowSyntheticCompletenessProofs: true,
      });

      expect(testFlowResult.recentBuys60s).toBe(0);
      expect(testFlowResult.recentSells60s).toBe(0);
      expect(testFlowResult.flowCoverage).toBe("SUFFICIENT");
      expect(testFlowResult.isCoverageSufficient).toBe(true);
      expect(testFlowResult.evaluationTimestampMs).toBe(66_000);

      const target: CandidateFlowTarget = {
        poolAddress: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
      };
      const snapshotted = validateAndSnapshotCandidateFlowResult(testFlowResult, target, 66_000);
      expect(snapshotted.isCoverageSufficient).toBe(true);
      expect(snapshotted.flowCoverage).toBe("SUFFICIENT");
      expect(snapshotted.recentBuys60s).toBe(0);
      expect(snapshotted.recentSells60s).toBe(0);
    });
  });
});
