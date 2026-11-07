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

describe("Phase 12.94-D Milestone D.3.3: Exact-Pool Window Reconciliation Evaluator (Audit-Harden V2)", () => {
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
        historyRecords: [],
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
        sourceMethod: "getBlockTime",
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
        historyRecords: [],
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
        sourceMethod: "getBlockTime",
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
        historyRecords: [], // explicitly completed empty history query
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

      // Invariants: not cryptographic, not production completeness
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

  describe("3. Evidence Presence & Accounting Defect Regressions (Audit Area 1)", () => {
    const validCutoff: SourceCutoffEvidence = {
      sourceMethod: "getBlockTime",
      responseField: "result",
      commitment: "confirmed",
      provenance: "ON_CHAIN_BLOCK_TIME",
      slot: 280_000_100,
      cutoffTimestampMs: 65_000,
      retrievedAtMs: 65_020,
    };

    it("fails closed with MISSING_HISTORY_EVIDENCE when neither historyResult nor historyRecords is supplied", () => {
      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        budgetManager,
        // historyResult and historyRecords intentionally omitted!
      });

      expect(result.status).toBe("MISSING_HISTORY_EVIDENCE");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.diagnosticReason).toContain(
        "MISSING_HISTORY_EVIDENCE: No history enumeration evidence was supplied",
      );
    });

    it("fails closed with UNRESOLVED_TRANSACTIONS when a discovered transaction has no resolution evidence", () => {
      const sig1 =
        "Sig11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
      const historyRecords: HistorySignatureRecord[] = [
        { signature: sig1, slot: 280_000_050, err: null, blockTime: 50 },
        { signature: "Anchor000", slot: 280_000_001, err: null, blockTime: 1 },
      ];

      // No resolutionResult, resolvedSignatures, or trades provided for sig1!
      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyRecords,
        knownAnchorSignature: "Anchor000",
        budgetManager,
      });

      expect(result.status).toBe("UNRESOLVED_TRANSACTIONS");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.diagnosticReason).toContain(
        "UNRESOLVED_TRANSACTIONS: Discovered signature 'Sig11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111' lacks validated resolution evidence",
      );
    });

    it("fails closed with AMBIGUOUS_TIMESTAMP when a history record has null blockTime", () => {
      const historyRecords: HistorySignatureRecord[] = [
        {
          signature:
            "SigNullTime11111111111111111111111111111111111111111111111111111111111111111111111111111111",
          slot: 280_000_050,
          err: null,
          blockTime: null, // Ambiguous blockTime!
        },
      ];

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyRecords,
        budgetManager,
      });

      expect(result.status).toBe("AMBIGUOUS_TIMESTAMP");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.diagnosticReason).toContain(
        "AMBIGUOUS_TIMESTAMP: History record for signature 'SigNullTime11111111111111111111111111111111111111111111111111111111111111111111111111111111' has null or missing blockTime",
      );
    });

    it("rejects incremental reuse from bare Set membership without a supporting resolution record", () => {
      const sig1 =
        "Sig11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
      const historyRecords: HistorySignatureRecord[] = [
        { signature: sig1, slot: 280_000_050, err: null, blockTime: 50 },
        { signature: "Anchor000", slot: 280_000_001, err: null, blockTime: 1 },
      ];

      // sig1 is in alreadyResolvedSignatures, but no resolution record or trade event supports it!
      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyRecords,
        alreadyResolvedSignatures: new Set([sig1]),
        knownAnchorSignature: "Anchor000",
        budgetManager,
      });

      expect(result.status).toBe("UNRESOLVED_TRANSACTIONS");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.flowCounts.recentBuys60s).toBeNull();
    });
  });

  describe("4. Directional Event Counting & Binding Defect Regressions (Audit Area 2)", () => {
    const validCutoff: SourceCutoffEvidence = {
      sourceMethod: "getBlockTime",
      responseField: "result",
      commitment: "confirmed",
      provenance: "ON_CHAIN_BLOCK_TIME",
      slot: 280_000_100,
      cutoffTimestampMs: 65_000,
      retrievedAtMs: 65_020,
    };

    const sig1 =
      "Sig11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
    const historyRecords: HistorySignatureRecord[] = [
      { signature: sig1, slot: 280_000_050, err: null, blockTime: 50 },
      { signature: "Anchor000", slot: 280_000_001, err: null, blockTime: 1 },
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
    ];

    it("rejects and ignores trade events from another pool, token mint, or unrelated signature", () => {
      const unrelatedSig =
        "UnrelatedSig999999999999999999999999999999999999999999999999999999999999999999999999999999";
      const alienTrades: TradeEvent[] = [
        {
          eventId: `${sig1}:0:0`,
          signature: sig1,
          swapIndex: 0,
          outerInstructionIndex: 0,
          poolId: "DifferentPoolAddress11111111111111111111111111", // Wrong pool!
          tokenMint: CANONICAL_TOKEN_MINT,
          side: "BUY",
          slot: 280_000_050,
          blockTimeSec: 50,
          eventTimestampMs: 50_000,
          receiptTimestampMs: 50_050,
          timestampProvenance: "ON_CHAIN_BLOCK_TIME",
        },
        {
          eventId: `${unrelatedSig}:0:0`,
          signature: unrelatedSig, // Unrelated signature!
          swapIndex: 0,
          outerInstructionIndex: 0,
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          side: "BUY",
          slot: 280_000_050,
          blockTimeSec: 50,
          eventTimestampMs: 50_000,
          receiptTimestampMs: 50_050,
          timestampProvenance: "ON_CHAIN_BLOCK_TIME",
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
        trades: alienTrades,
        knownAnchorSignature: "Anchor000",
        budgetManager,
      });

      // No legitimate candidate-bound trade was supplied for sig1
      expect(result.status).toBe("RECONCILED");
      expect(result.flowCounts.recentBuys60s).toBe(0);
      expect(result.flowCounts.recentSells60s).toBe(0);
    });

    it("deduplicates multiple identical trade events using canonical swap key", () => {
      const duplicateSellTrades: TradeEvent[] = [
        {
          eventId: `${sig1}:0:0`,
          signature: sig1,
          swapIndex: 0,
          outerInstructionIndex: 0,
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          side: "SELL",
          slot: 280_000_050,
          blockTimeSec: 50,
          eventTimestampMs: 50_000,
          receiptTimestampMs: 50_050,
          timestampProvenance: "ON_CHAIN_BLOCK_TIME",
        },
        {
          eventId: `${sig1}:0:0`, // Identical canonical swap key!
          signature: sig1,
          swapIndex: 0,
          outerInstructionIndex: 0,
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          side: "SELL",
          slot: 280_000_050,
          blockTimeSec: 50,
          eventTimestampMs: 50_000,
          receiptTimestampMs: 50_050,
          timestampProvenance: "ON_CHAIN_BLOCK_TIME",
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
        trades: duplicateSellTrades,
        knownAnchorSignature: "Anchor000",
        budgetManager,
      });

      expect(result.status).toBe("RECONCILED");
      expect(result.flowCoverage).toBe("SUFFICIENT");
      expect(result.flowCounts.recentSells60s).toBe(1); // Deduplicated to 1 SELL, not 2!
      expect(result.flowCounts.recentBuys60s).toBe(0);
    });

    it("fails closed with INSUFFICIENT_DIRECTIONAL_EVIDENCE rather than approximating buys from ingestedEventsCount", () => {
      // Discovered transaction resolved with ingestedEventsCount=2, but NO directional trade events provided
      const resolutionResult = {
        outcome: "ALL_RESOLVED" as const,
        candidatePoolId: CANONICAL_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: "Anchor000",
        frozenTargetSignature: sig1,
        totalDiscoveredSignatures: 1,
        totalProcessed: 1,
        totalResolved: 1,
        totalFailed: 0,
        totalDuplicatesUnresolved: 0,
        totalDuplicatesResolved: 0,
        totalIngestedSwaps: 2,
        perSignatureResults: [
          {
            signature: sig1,
            slot: 280_000_050,
            blockTime: 50,
            status: "RESOLVED" as const,
            decodedEventsCount: 2,
            ingestedEventsCount: 2,
          },
        ],
        isProductionCompletenessEstablished: false as const,
        durationMs: 50,
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyRecords,
        resolutionResult,
        knownAnchorSignature: "Anchor000",
        budgetManager,
        // trades intentionally omitted!
      });

      expect(result.status).toBe("INSUFFICIENT_DIRECTIONAL_EVIDENCE");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.flowCounts.recentSells60s).toBeNull();
      expect(result.diagnosticReason).toContain(
        "INSUFFICIENT_DIRECTIONAL_EVIDENCE: Directional swap events (buys/sells) were not supplied for resolved transactions in window",
      );
    });
  });

  describe("5. Cutoff Provenance & Causal Time Ordering (Audit Area 3)", () => {
    it("rejects getSlot labeled as ON_CHAIN_BLOCK_TIME because getSlot returns a slot number, not a timestamp", () => {
      const invalidCutoff = {
        sourceMethod: "getSlot", // getSlot does not provide on-chain blockTime timestamp!
        responseField: "result",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_100,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_020,
      } as unknown as SourceCutoffEvidence;

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: invalidCutoff,
        historyRecords: [],
        budgetManager,
      });

      expect(result.status).toBe("INVALID_SOURCE_CUTOFF");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.diagnosticReason).toContain(
        "INVALID_SOURCE_CUTOFF: ON_CHAIN_BLOCK_TIME provenance requires a method providing blockTime",
      );
    });

    it("rejects evidence retrieved after the decision time as FUTURE_DATED_EVIDENCE (causality violation)", () => {
      const futureRetrievedCutoff: SourceCutoffEvidence = {
        sourceMethod: "getBlockTime",
        responseField: "result",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_100,
        cutoffTimestampMs: 60_000,
        retrievedAtMs: 68_000, // Retrieved at 68s, AFTER decision at 66s!
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 60_000,
        sourceCutoff: futureRetrievedCutoff,
        historyRecords: [],
        budgetManager,
      });

      expect(result.status).toBe("FUTURE_DATED_EVIDENCE");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.diagnosticReason).toContain(
        "CAUSALITY_VIOLATION: Cutoff evidence retrieval timestamp (68000 ms) is after decision time (66000 ms)",
      );
    });

    it("rejects window cutoff ending after the decision time without any 5-second look-ahead allowance", () => {
      const futureCutoff: SourceCutoffEvidence = {
        sourceMethod: "getBlockTime",
        responseField: "result",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_100,
        cutoffTimestampMs: 66_500, // 500ms in the future relative to decision at 66_000!
        retrievedAtMs: 66_000,
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 66_000,
        sourceCutoff: futureCutoff,
        historyRecords: [],
        budgetManager,
      });

      expect(result.status).toBe("FUTURE_DATED_EVIDENCE");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.diagnosticReason).toContain(
        "CAUSALITY_VIOLATION: Source cutoff timestamp (66500 ms) is in the future relative to decision time (66000 ms)",
      );
    });

    it("rejects observation end after decision time as FUTURE_DATED_EVIDENCE", () => {
      const validCutoff: SourceCutoffEvidence = {
        sourceMethod: "getBlockTime",
        responseField: "result",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_100,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_050,
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 67_000, // Observation end is in the future relative to decision time!
        sourceCutoff: validCutoff,
        historyRecords: [],
        budgetManager,
      });

      expect(result.status).toBe("FUTURE_DATED_EVIDENCE");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.diagnosticReason).toContain(
        "CAUSALITY_VIOLATION: Observation end (67000 ms) is in the future relative to decision time (66000 ms)",
      );
    });
  });

  describe("6. Non-Mutating Accounting & Input Snapshotting (Audit Area 4)", () => {
    it("leaves caller budget manager and caller input objects completely unmutated and unfrozen", () => {
      const callerCutoff: SourceCutoffEvidence = {
        sourceMethod: "getBlockTime",
        responseField: "result",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_200,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_040,
      };

      const initialBudgetStats = budgetManager.getStats();

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: callerCutoff,
        historyRecords: [],
        budgetManager,
      });

      expect(result.status).toBe("RECONCILED");

      // 1. Invariant: Caller budget manager was NOT mutated by evaluation
      const postBudgetStats = budgetManager.getStats();
      expect(postBudgetStats).toEqual(initialBudgetStats);

      // 2. Invariant: Caller input objects were NOT frozen by deepFreeze
      expect(Object.isFrozen(callerCutoff)).toBe(false);
      expect(Object.isFrozen(result.sourceCutoff)).toBe(true);

      // 3. Invariant: Actual requests reported from receipts, not simulation
      expect(result.resourceMetrics.actualRequestsDispatched).toBe(1); // 1 history query receipt
      expect(result.resourceMetrics.projectedDemand.totalProjectedRequests).toBe(0);
    });
  });

  describe("7. Boundary Anchoring & General Failure Modes", () => {
    const validCutoff: SourceCutoffEvidence = {
      sourceMethod: "getBlockTime",
      responseField: "result",
      commitment: "confirmed",
      provenance: "ON_CHAIN_BLOCK_TIME",
      slot: 280_000_100,
      cutoffTimestampMs: 65_000,
      retrievedAtMs: 65_020,
    };

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
        historyRecords: [],
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
        sourceMethod: "getBlockTime",
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
        historyRecords: [],
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
        historyRecords: [],
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
  });

  describe("8. Upstream Index Omission & Production Protection", () => {
    it("acknowledges upstream index omission limitation without claiming it is independently detectable", () => {
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
        resolvedSignatures: [
          {
            signature: anchorPost,
            slot: 280_000_100,
            blockTime: 65,
            status: "RESOLVED",
            decodedEventsCount: 1,
            ingestedEventsCount: 1,
          },
        ],
        trades: [
          {
            eventId: `${anchorPost}:0:0`,
            signature: anchorPost,
            swapIndex: 0,
            outerInstructionIndex: 0,
            poolId: CANONICAL_POOL_ID,
            tokenMint: CANONICAL_TOKEN_MINT,
            side: "BUY",
            slot: 280_000_100,
            blockTimeSec: 65,
            eventTimestampMs: 65_000,
            receiptTimestampMs: 65_020,
            timestampProvenance: "ON_CHAIN_BLOCK_TIME",
          },
        ],
        knownAnchorSignature: anchorPrior,
        budgetManager,
      });

      expect(result.status).toBe("RECONCILED");
      expect(result.underlyingOutcomes.anchorWitnessed).toBe(true);
      expect(result.isCryptographicCompletenessEstablished).toBe(false);
      expect(result.isProductionCompletenessEstablished).toBe(false);
      expect(result.providerAssumptions).toContain(
        "Standard RPC pagination satisfies anchor witnessing without verifying omission of intermediate transactions",
      );
      expect(result.unresolvedUncertainties).toContain(
        "Upstream index omission: dropped intermediate transactions are undetectable via ordinary JSON-RPC pagination",
      );
    });

    it("ensures production counts strictly remain null and coverage COLLECTION_GAP despite a positive offline reconciliation result", () => {
      const cutoffEvidence: SourceCutoffEvidence = {
        sourceMethod: "getBlockTime",
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
      expect(reconResult.status).toBe("RECONCILED");
      expect(reconResult.flowCoverage).toBe("SUFFICIENT");

      // Production conversion
      const prodFlowResult = toCandidateFlowResult(reconResult);
      expect(prodFlowResult.recentBuys60s).toBeNull();
      expect(prodFlowResult.recentSells60s).toBeNull();
      expect(prodFlowResult.flowCoverage).toBe("COLLECTION_GAP");
      expect(prodFlowResult.isCoverageSufficient).toBe(false);
      expect(prodFlowResult.evaluationTimestampMs).toBe(66_000);
      expect(prodFlowResult.diagnosticReason).toContain("PRODUCTION_COVERAGE_PROTECTED");

      const target: CandidateFlowTarget = {
        poolAddress: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
      };
      const snapshotted = validateAndSnapshotCandidateFlowResult(prodFlowResult, target, 66_000);
      expect(snapshotted.isCoverageSufficient).toBe(false);
      expect(snapshotted.flowCoverage).toBe("COLLECTION_GAP");
      expect(snapshotted.recentBuys60s).toBeNull();
      expect(snapshotted.recentSells60s).toBeNull();
    });

    it("allows synthetic test harness to consume reconciled counts when allowSyntheticCompletenessProofs is true", () => {
      const cutoffEvidence: SourceCutoffEvidence = {
        sourceMethod: "getBlockTime",
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

      const testFlowResult = toCandidateFlowResult(reconResult, {
        allowSyntheticCompletenessProofs: true,
      });

      expect(testFlowResult.recentBuys60s).toBe(0);
      expect(testFlowResult.recentSells60s).toBe(0);
      expect(testFlowResult.flowCoverage).toBe("SUFFICIENT");
      expect(testFlowResult.isCoverageSufficient).toBe(true);

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
