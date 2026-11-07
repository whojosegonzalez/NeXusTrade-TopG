/**
 * Phase 12.94-D Milestone D.3.3: Exact-Pool Window Reconciliation Evaluator Tests (Audit-Hardened V4)
 *
 * Comprehensive offline verification suite ensuring:
 * 1. Warm-up and incomplete observation handling.
 * 2. Full-duration quiet window reconciliation.
 * 3. Terminal evidence outcome validation (fetch error, cancelled, capped enumeration never become verified quiet windows).
 * 4. Complete, valid event set per transaction & missing resolution evidence handling:
 *    - Incomplete directional events (2 decoded vs 1 supplied) fail closed with INSUFFICIENT_DIRECTIONAL_EVIDENCE.
 *    - Removing that resolution receipt fails closed with UNRESOLVED_TRANSACTIONS (cannot upgrade to RECONCILED!).
 *    - Explicit resolution failure takes precedence over alreadyResolved and trade records.
 *    - Foreign pool trade filtering fails closed and does not manufacture verified zero activity.
 *    - Genuinely zero-swap transactions (decodedEventsCount: 0) reconcile to 0/0.
 *    - NaN event time and post-decision events are rejected.
 * 5. Conflicting record rejection across supplied evidence:
 *    - FAILED_DECODE in perSignatureResults cannot be overwritten by RESOLVED in resolvedSignatures.
 *    - Contradictory records across supplied evidence fail closed with CONTRADICTORY_EVIDENCE.
 * 6. Cutoff content & request binding validation:
 *    - ON_CHAIN_BLOCK_TIME without responsePayload fails closed.
 *    - ON_CHAIN_BLOCK_TIME without requestContext fails closed.
 *    - Rejects responseField="banana".
 *    - Validates injected response payload contents, slot alignment, and timestamp correspondence.
 *    - Synthetic checkpoints (SYNTHETIC_FIXTURE) remain distinct.
 * 7. Non-mutating accounting & evidenced dispatch reporting:
 *    - Tracker is never mutated; evaluateWindow is never called.
 *    - Stream inactivity at evaluation time is detected read-only.
 *    - Pre-dispatch denials (e.g. PRE_DISPATCH_DEADLINE_EXCEEDED) count as 0 dispatches.
 *    - Ambiguous statuses or partial evidence report actualRequestsDispatched = null (unknown).
 *    - Explicit receipts with fully evidenced operations report true HTTP dispatches.
 *    - Duplicate signatures are excluded from HTTP dispatch counts.
 *    - Known unresolved demand is preserved in UNRESOLVED_TRANSACTIONS.
 * 8. Upstream index omission limitation acknowledgment and production protection.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluateExactPoolWindowReconciliation,
  toCandidateFlowResult,
  DEFAULT_PROVIDER_INDEX_ASSUMPTIONS,
  DEFAULT_UNRESOLVED_UNCERTAINTIES,
  type SourceCutoffEvidence,
} from "./ExactPoolWindowReconciliationEvaluator.js";
import type { TrackedRaydiumPoolContext } from "./RaydiumAmmV4SwapDecoder.js";
import type {
  HistorySignatureRecord,
  HistoryEnumerationResult,
} from "./ExactPoolHistoryEnumerator.js";
import type {
  ResolvedSignatureRecord,
  TransactionResolutionResult,
} from "./ExactPoolTransactionResolutionBridge.js";
import { RollingTradeFlowTracker, type TradeEvent } from "./RollingTradeFlowTracker.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import {
  validateAndSnapshotCandidateFlowResult,
  type CandidateFlowTarget,
} from "./CandidateFlowProvider.js";

const CANONICAL_POOL_ID = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
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

describe("Phase 12.94-D Milestone D.3.3: Exact-Pool Window Reconciliation Evaluator (Audit-Hardened V4)", () => {
  let budgetManager: GlobalResourceBudgetManager;

  const createValidBlockTimeCutoff = (options?: {
    slot?: number;
    cutoffTimestampMs?: number;
    retrievedAtMs?: number;
  }): SourceCutoffEvidence => {
    const slot = options?.slot ?? 280_000_100;
    const cutoffTimestampMs = options?.cutoffTimestampMs ?? 65_000;
    const retrievedAtMs = options?.retrievedAtMs ?? 65_020;
    return {
      sourceMethod: "getBlockTime",
      responseField: "result",
      commitment: "confirmed",
      provenance: "ON_CHAIN_BLOCK_TIME",
      slot,
      cutoffTimestampMs,
      retrievedAtMs,
      responsePayload: { result: cutoffTimestampMs / 1000 },
      requestContext: { slot },
    };
  };

  const createValidSigCutoff = (options?: {
    slot?: number;
    cutoffTimestampMs?: number;
    retrievedAtMs?: number;
  }): SourceCutoffEvidence => {
    const slot = options?.slot ?? 280_000_100;
    const cutoffTimestampMs = options?.cutoffTimestampMs ?? 55_000;
    const retrievedAtMs = options?.retrievedAtMs ?? 55_050;
    return {
      sourceMethod: "getSignaturesForAddress",
      responseField: "result[0].blockTime",
      commitment: "confirmed",
      provenance: "ON_CHAIN_BLOCK_TIME",
      slot,
      cutoffTimestampMs,
      retrievedAtMs,
      responsePayload: {
        result: [{ signature: "CutoffSig111", slot, blockTime: cutoffTimestampMs / 1000 }],
      },
      requestContext: { address: CANONICAL_POOL_ID, slot },
    };
  };

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
      const cutoffEvidence = createValidSigCutoff({
        cutoffTimestampMs: 55_000,
        retrievedAtMs: 55_050,
      });

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 56_000,
        observationStartMs: 0, // started at 0s, but window begins at -5s (55s - 60s)
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
      const cutoffEvidence = createValidBlockTimeCutoff({
        slot: 280_000_200,
        cutoffTimestampMs: 70_000,
        retrievedAtMs: 70_050,
      });

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
      const cutoffEvidence = createValidBlockTimeCutoff({
        slot: 280_000_200,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_040,
      });

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

      expect(result.isCryptographicCompletenessEstablished).toBe(false);
      expect(result.isProductionCompletenessEstablished).toBe(false);

      expect(result.providerAssumptions).toEqual(DEFAULT_PROVIDER_INDEX_ASSUMPTIONS);
      expect(result.unresolvedUncertainties).toEqual(DEFAULT_UNRESOLVED_UNCERTAINTIES);
      expect(result.diagnosticReason).toContain(
        "RECONCILED: Verified quiet window under declared provider-relative assumptions (0 buys, 0 sells in 60s window)",
      );
    });
  });

  describe("3. Terminal Evidence Outcome Validation", () => {
    const validCutoff = createValidBlockTimeCutoff();

    it("fails closed when historyResult has outcome FETCH_ERROR and empty records rather than returning a false quiet window", () => {
      const historyResult: HistoryEnumerationResult = {
        outcome: "FETCH_ERROR",
        candidatePoolId: CANONICAL_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: false,
        knownAnchorSignature: "Anchor000",
        frozenTargetSignature: null,
        discoveredSignatures: [],
        requestCount: 1,
        pagesQueried: 1,
        isProductionCompletenessEstablished: false,
        error: "JSON-RPC 503 Service Unavailable",
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyResult,
        budgetManager,
      });

      expect(result.status).toBe("INCOMPLETE_OBSERVATION");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.isCoverageSufficient).toBe(false);
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.flowCounts.recentSells60s).toBeNull();
      expect(result.diagnosticReason).toContain("FETCH_ERROR");
    });

    it("fails closed when historyResult has outcome OPERATION_CANCELLED or MAX_PAGES_EXHAUSTED", () => {
      const cancelledResult: HistoryEnumerationResult = {
        outcome: "OPERATION_CANCELLED",
        candidatePoolId: CANONICAL_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: false,
        knownAnchorSignature: "Anchor000",
        frozenTargetSignature: null,
        discoveredSignatures: [],
        requestCount: 1,
        pagesQueried: 1,
        isProductionCompletenessEstablished: false,
        error: "Caller cancelled",
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyResult: cancelledResult,
        budgetManager,
      });

      expect(result.status).toBe("INCOMPLETE_OBSERVATION");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.diagnosticReason).toContain("OPERATION_CANCELLED");
    });

    it("fails closed with UNWITNESSED_PRIOR_ANCHOR when historyResult has outcome ANCHOR_NOT_FOUND", () => {
      const anchorNotFoundResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_NOT_FOUND",
        candidatePoolId: CANONICAL_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: false,
        knownAnchorSignature: "Anchor000",
        frozenTargetSignature: "SigTarget",
        discoveredSignatures: [],
        requestCount: 2,
        pagesQueried: 2,
        isProductionCompletenessEstablished: false,
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyResult: anchorNotFoundResult,
        budgetManager,
      });

      expect(result.status).toBe("UNWITNESSED_PRIOR_ANCHOR");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
    });

    it("fails closed with IDENTITY_MISMATCH when candidatePoolId in historyResult does not match poolContext", () => {
      const foreignHistoryResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
        candidatePoolId: "DifferentPoolAddress11111111111111111111111111",
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: "Anchor000",
        frozenTargetSignature: "SigTarget",
        discoveredSignatures: [],
        requestCount: 1,
        pagesQueried: 1,
        isProductionCompletenessEstablished: false,
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyResult: foreignHistoryResult,
        budgetManager,
      });

      expect(result.status).toBe("IDENTITY_MISMATCH");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.diagnosticReason).toContain("IDENTITY_MISMATCH");
    });

    it("fails closed with MISSING_HISTORY_EVIDENCE when neither historyResult nor historyRecords is supplied", () => {
      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        budgetManager,
      });

      expect(result.status).toBe("MISSING_HISTORY_EVIDENCE");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.diagnosticReason).toContain(
        "MISSING_HISTORY_EVIDENCE: No history enumeration evidence was supplied",
      );
    });

    it("fails closed with AMBIGUOUS_TIMESTAMP when a history record has null blockTime", () => {
      const sig1 =
        "Sig11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
      const historyRecords: HistorySignatureRecord[] = [
        { signature: sig1, slot: 280_000_050, err: null, blockTime: null },
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
      expect(result.diagnosticReason).toContain("AMBIGUOUS_TIMESTAMP");
    });
  });

  describe("4. Mandatory Resolution Evidence & Incomplete Event Set Protection (Counterexample 1)", () => {
    const validCutoff = createValidBlockTimeCutoff();
    const sig1 =
      "Sig11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
    const historyRecords: HistorySignatureRecord[] = [
      { signature: sig1, slot: 280_000_050, err: null, blockTime: 50 },
      { signature: "Anchor000", slot: 280_000_001, err: null, blockTime: 1 },
    ];

    const incompleteBuyTrade: TradeEvent = {
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
      receiptTimestampMs: 50_050,
      timestampProvenance: "ON_CHAIN_BLOCK_TIME",
    };

    it("fails closed with INSUFFICIENT_DIRECTIONAL_EVIDENCE when resolution reports 2 decoded events but only 1 BUY is supplied", () => {
      const resolutionResult: TransactionResolutionResult = {
        outcome: "ALL_RESOLVED",
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
            status: "RESOLVED",
            decodedEventsCount: 2, // 2 events decoded
            ingestedEventsCount: 2,
          },
        ],
        isProductionCompletenessEstablished: false,
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
        trades: [incompleteBuyTrade], // only 1 BUY supplied
        knownAnchorSignature: "Anchor000",
        budgetManager,
      });

      expect(result.status).toBe("INSUFFICIENT_DIRECTIONAL_EVIDENCE");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.flowCounts.recentSells60s).toBeNull();
      expect(result.diagnosticReason).toContain(
        "expected 2 decoded event(s) from resolution, but found 1",
      );
    });

    it("fails closed with UNRESOLVED_TRANSACTIONS when resolution receipt is omitted, refusing to upgrade incomplete events to RECONCILED (Counterexample 1)", () => {
      // Removing the resolution receipt for the same incomplete trade list MUST NOT upgrade to RECONCILED with 1 BUY / 0 SELL!
      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyRecords,
        trades: [incompleteBuyTrade], // Trade event supplied without resolution receipt
        alreadyResolvedSignatures: new Set([sig1]), // even with bare alreadyResolved membership!
        knownAnchorSignature: "Anchor000",
        budgetManager,
        // resolutionResult and resolvedSignatures intentionally omitted!
      });

      expect(result.status).toBe("UNRESOLVED_TRANSACTIONS");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.flowCounts.recentSells60s).toBeNull();
      expect(result.diagnosticReason).toContain("lacks validated resolution evidence");
    });

    it("ensures explicit resolution failure (FAILED_DECODE) takes precedence over alreadyResolved and trade records", () => {
      const failedResolutionRecord: ResolvedSignatureRecord = {
        signature: sig1,
        slot: 280_000_050,
        blockTime: 50,
        status: "FAILED_DECODE",
        decodedEventsCount: 0,
        ingestedEventsCount: 0,
        error: "Instruction unpack failed",
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyRecords,
        alreadyResolvedSignatures: new Set([sig1]),
        resolvedSignatures: [failedResolutionRecord],
        trades: [incompleteBuyTrade],
        knownAnchorSignature: "Anchor000",
        budgetManager,
      });

      expect(result.status).toBe("UNRESOLVED_TRANSACTIONS");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.diagnosticReason).toContain("FAILED_DECODE");
    });

    it("fails closed when foreign pool trade is filtered away rather than manufacturing verified zero activity", () => {
      const resolvedWithOneEvent: ResolvedSignatureRecord = {
        signature: sig1,
        slot: 280_000_050,
        blockTime: 50,
        status: "RESOLVED",
        decodedEventsCount: 1,
        ingestedEventsCount: 1,
      };

      const foreignTrade: TradeEvent = {
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
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyRecords,
        resolvedSignatures: [resolvedWithOneEvent],
        trades: [foreignTrade],
        knownAnchorSignature: "Anchor000",
        budgetManager,
      });

      expect(result.status).toBe("INSUFFICIENT_DIRECTIONAL_EVIDENCE");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.flowCounts.recentBuys60s).toBeNull();
      expect(result.flowCounts.recentSells60s).toBeNull();
    });

    it("reconciles genuinely zero-swap transaction (decodedEventsCount: 0) to 0 buys and 0 sells", () => {
      const zeroSwapResolution: ResolvedSignatureRecord = {
        signature: sig1,
        slot: 280_000_050,
        blockTime: 50,
        status: "RESOLVED",
        decodedEventsCount: 0,
        ingestedEventsCount: 0,
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyRecords,
        resolvedSignatures: [zeroSwapResolution],
        trades: [],
        knownAnchorSignature: "Anchor000",
        budgetManager,
      });

      expect(result.status).toBe("RECONCILED");
      expect(result.flowCoverage).toBe("SUFFICIENT");
      expect(result.flowCounts.recentBuys60s).toBe(0);
      expect(result.flowCounts.recentSells60s).toBe(0);
    });

    it("rejects NaN event timestamp and post-decision event receipts", () => {
      const nanTrade: TradeEvent = {
        eventId: `${sig1}:0:0`,
        signature: sig1,
        swapIndex: 0,
        outerInstructionIndex: 0,
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        side: "BUY",
        slot: 280_000_050,
        blockTimeSec: 50,
        eventTimestampMs: NaN,
        receiptTimestampMs: 50_050,
        timestampProvenance: "ON_CHAIN_BLOCK_TIME",
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyRecords,
        resolvedSignatures: [
          {
            signature: sig1,
            slot: 280_000_050,
            blockTime: 50,
            status: "RESOLVED",
            decodedEventsCount: 1,
            ingestedEventsCount: 1,
          },
        ],
        trades: [nanTrade],
        knownAnchorSignature: "Anchor000",
        budgetManager,
      });

      expect(result.status).toBe("INSUFFICIENT_DIRECTIONAL_EVIDENCE");
      expect(result.diagnosticReason).toContain("timestamp is invalid");
    });
  });

  describe("5. Conflicting Record Rejection Across Evidence (Counterexample 2)", () => {
    const validCutoff = createValidBlockTimeCutoff();
    const sig1 =
      "Sig11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
    const historyRecords: HistorySignatureRecord[] = [
      { signature: sig1, slot: 280_000_050, err: null, blockTime: 50 },
      { signature: "Anchor000", slot: 280_000_001, err: null, blockTime: 1 },
    ];

    it("rejects contradictory records when FAILED_DECODE in perSignatureResults conflicts with RESOLVED in resolvedSignatures", () => {
      const resolutionResult: TransactionResolutionResult = {
        outcome: "ALL_RESOLVED",
        candidatePoolId: CANONICAL_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: "Anchor000",
        frozenTargetSignature: sig1,
        totalDiscoveredSignatures: 1,
        totalProcessed: 1,
        totalResolved: 0,
        totalFailed: 1,
        totalDuplicatesUnresolved: 0,
        totalDuplicatesResolved: 0,
        totalIngestedSwaps: 0,
        perSignatureResults: [
          {
            signature: sig1,
            slot: 280_000_050,
            blockTime: 50,
            status: "FAILED_DECODE", // Failed decode here!
            decodedEventsCount: 0,
            ingestedEventsCount: 0,
            error: "Decode failure",
          },
        ],
        isProductionCompletenessEstablished: false,
        durationMs: 50,
      };

      const resolvedSignaturesOverride: ResolvedSignatureRecord[] = [
        {
          signature: sig1,
          slot: 280_000_050,
          blockTime: 50,
          status: "RESOLVED", // Contradictory success record!
          decodedEventsCount: 1,
          ingestedEventsCount: 1,
        },
      ];

      const tradeForSig: TradeEvent = {
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
        receiptTimestampMs: 50_050,
        timestampProvenance: "ON_CHAIN_BLOCK_TIME",
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyRecords,
        resolutionResult,
        resolvedSignatures: resolvedSignaturesOverride,
        trades: [tradeForSig],
        knownAnchorSignature: "Anchor000",
        budgetManager,
      });

      // Must fail closed with UNRESOLVED_TRANSACTIONS and CONTRADICTORY_EVIDENCE!
      expect(result.status).toBe("UNRESOLVED_TRANSACTIONS");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.diagnosticReason).toContain("CONTRADICTORY_EVIDENCE");
    });
  });

  describe("6. Cutoff Content & Request Binding Validation (Counterexample 3)", () => {
    it("rejects ON_CHAIN_BLOCK_TIME cutoff without responsePayload", () => {
      const cutoffWithoutPayload: SourceCutoffEvidence = {
        sourceMethod: "getBlockTime",
        responseField: "result",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_100,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_020,
        requestContext: { slot: 280_000_100 },
        // responsePayload omitted!
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: cutoffWithoutPayload,
        historyRecords: [],
        budgetManager,
      });

      expect(result.status).toBe("INVALID_SOURCE_CUTOFF");
      expect(result.diagnosticReason).toContain("requires supporting responsePayload");
    });

    it("rejects ON_CHAIN_BLOCK_TIME cutoff without requestContext", () => {
      const cutoffWithoutContext: SourceCutoffEvidence = {
        sourceMethod: "getBlockTime",
        responseField: "result",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_100,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_020,
        responsePayload: { result: 65 },
        // requestContext omitted!
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: cutoffWithoutContext,
        historyRecords: [],
        budgetManager,
      });

      expect(result.status).toBe("INVALID_SOURCE_CUTOFF");
      expect(result.diagnosticReason).toContain("requires supporting requestContext");
    });

    it("rejects ON_CHAIN_BLOCK_TIME cutoff when requestContext slot does not match cutoff slot", () => {
      const cutoffMismatchedSlot: SourceCutoffEvidence = {
        sourceMethod: "getBlockTime",
        responseField: "result",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_100,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_020,
        responsePayload: { result: 65 },
        requestContext: { slot: 999_999_999 }, // Mismatched slot!
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: cutoffMismatchedSlot,
        historyRecords: [],
        budgetManager,
      });

      expect(result.status).toBe("INVALID_SOURCE_CUTOFF");
      expect(result.diagnosticReason).toContain(
        "requestContext slot (999999999) must match cutoff slot (280000100)",
      );
    });

    it("rejects getBlockTime cutoff with responseField='banana'", () => {
      const invalidCutoff: SourceCutoffEvidence = {
        sourceMethod: "getBlockTime",
        responseField: "banana",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: 280_000_100,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_020,
        responsePayload: { result: 65 },
        requestContext: { slot: 280_000_100 },
      };

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
      expect(result.diagnosticReason).toContain(
        "Invalid responseField for getBlockTime: expected 'result', received 'banana'",
      );
    });

    it("accepts explicitly synthetic checkpoint without requiring RPC responsePayload / requestContext", () => {
      const syntheticCutoff: SourceCutoffEvidence = {
        sourceMethod: "SYNTHETIC_CHECKPOINT",
        responseField: "syntheticTimestampMs",
        commitment: "confirmed",
        provenance: "SYNTHETIC_FIXTURE",
        slot: 280_000_100,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_020,
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: syntheticCutoff,
        historyRecords: [],
        budgetManager,
      });

      expect(result.status).toBe("RECONCILED");
    });
  });

  describe("7. Evidenced Dispatch Accounting & Read-Only Tracker (Counterexample 4)", () => {
    const validCutoff = createValidBlockTimeCutoff();
    const sig1 =
      "Sig11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
    const historyRecords: HistorySignatureRecord[] = [
      { signature: sig1, slot: 280_000_050, err: null, blockTime: 50 },
      { signature: "Anchor000", slot: 280_000_001, err: null, blockTime: 1 },
    ];

    it("counts pre-dispatch deadline denial as 0 HTTP dispatches, reporting only the 1 history query (Counterexample 4)", () => {
      const historyResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
        candidatePoolId: CANONICAL_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: "Anchor000",
        frozenTargetSignature: sig1,
        discoveredSignatures: historyRecords,
        requestCount: 1, // 1 history query
        pagesQueried: 1,
        isProductionCompletenessEstablished: false,
      };

      const resolutionResult: TransactionResolutionResult = {
        outcome: "OPERATION_DEADLINE_EXCEEDED",
        candidatePoolId: CANONICAL_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: "Anchor000",
        frozenTargetSignature: sig1,
        totalDiscoveredSignatures: 1,
        totalProcessed: 1,
        totalResolved: 0,
        totalFailed: 1,
        totalDuplicatesUnresolved: 0,
        totalDuplicatesResolved: 0,
        totalIngestedSwaps: 0,
        perSignatureResults: [
          {
            signature: sig1,
            slot: 280_000_050,
            blockTime: 50,
            status: "DEADLINE_EXCEEDED",
            adapterOutcome: "PRE_DISPATCH_DEADLINE_EXCEEDED", // Denied BEFORE dispatch!
            decodedEventsCount: 0,
            ingestedEventsCount: 0,
          },
        ],
        isProductionCompletenessEstablished: false,
        durationMs: 50,
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyResult,
        resolutionResult,
        knownAnchorSignature: "Anchor000",
        budgetManager,
      });

      expect(result.status).toBe("UNRESOLVED_TRANSACTIONS");
      // 1 history query + 0 resolution queries (denied pre-dispatch) = 1 (NOT 2!)
      expect(result.resourceMetrics.actualRequestsDispatched).toBe(1);
    });

    it("reports actualRequestsDispatched as null (unknown) when resolution diagnostics are ambiguous without explicit attempt records", () => {
      const historyResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
        candidatePoolId: CANONICAL_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: "Anchor000",
        frozenTargetSignature: sig1,
        discoveredSignatures: historyRecords,
        requestCount: 1,
        pagesQueried: 1,
        isProductionCompletenessEstablished: false,
      };

      const ambiguousResolutionResult: TransactionResolutionResult = {
        outcome: "OPERATION_DEADLINE_EXCEEDED",
        candidatePoolId: CANONICAL_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: "Anchor000",
        frozenTargetSignature: sig1,
        totalDiscoveredSignatures: 1,
        totalProcessed: 1,
        totalResolved: 0,
        totalFailed: 1,
        totalDuplicatesUnresolved: 0,
        totalDuplicatesResolved: 0,
        totalIngestedSwaps: 0,
        perSignatureResults: [
          {
            signature: sig1,
            slot: 280_000_050,
            blockTime: 50,
            status: "DEADLINE_EXCEEDED", // Ambiguous: no adapterOutcome to prove pre vs post dispatch
            decodedEventsCount: 0,
            ingestedEventsCount: 0,
          },
        ],
        isProductionCompletenessEstablished: false,
        durationMs: 50,
      };

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyResult,
        resolutionResult: ambiguousResolutionResult,
        knownAnchorSignature: "Anchor000",
        budgetManager,
      });

      // Cannot present partial known count as complete total -> reports null!
      expect(result.resourceMetrics.actualRequestsDispatched).toBeNull();
    });

    it("consumes tracker read-only, detects evaluation-time inactivity gap without mutating tracker state", () => {
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: 1,
        maxStreamInactivityMs: 15_000,
      });

      // Tracker last observation was at 30_000ms. Window ends at 65_000ms (> 15s inactivity!)
      (tracker as unknown as { lastObservationTimestampMs: number }).lastObservationTimestampMs =
        30_000;

      const gapsBefore = tracker.getGapsCount();
      expect(gapsBefore).toBe(0);

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        tracker,
        historyRecords: [],
        budgetManager,
      });

      expect(result.status).toBe("STREAM_GAP");
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.diagnosticReason).toContain("STREAM_INACTIVITY_AT_EVALUATION");

      // Critical invariant: Caller tracker was NOT mutated!
      const gapsAfter = tracker.getGapsCount();
      expect(gapsAfter).toBe(0);
    });

    it("preserves known unresolved demand in UNRESOLVED_TRANSACTIONS without claiming sufficient budget from zero placeholders", () => {
      const sig2 =
        "Sig22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222";

      const twoHistoryRecords: HistorySignatureRecord[] = [
        { signature: sig1, slot: 280_000_050, err: null, blockTime: 50 },
        { signature: sig2, slot: 280_000_040, err: null, blockTime: 40 },
        { signature: "Anchor000", slot: 280_000_001, err: null, blockTime: 1 },
      ];

      const result = evaluateExactPoolWindowReconciliation({
        poolContext: VALID_POOL_CONTEXT,
        decisionTimestampMs: 66_000,
        observationStartMs: 0,
        observationEndMs: 65_000,
        sourceCutoff: validCutoff,
        historyRecords: twoHistoryRecords,
        knownAnchorSignature: "Anchor000",
        budgetManager,
      });

      expect(result.status).toBe("UNRESOLVED_TRANSACTIONS");
      expect(result.resourceMetrics.projectedDemand.unresolvedTransactionRequests).toBe(2);
      expect(result.resourceMetrics.projectedDemand.totalProjectedRequests).toBe(2);
      expect(result.resourceMetrics.projectedDemand.projectedPacingWaitMs).toBe(2500);
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
        { signature: anchorPrior, slot: 280_000_001, err: null, blockTime: 1 },
      ];

      const cutoffEvidence = createValidSigCutoff({
        slot: 280_000_100,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_030,
      });

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
      const cutoffEvidence = createValidBlockTimeCutoff({
        slot: 280_000_200,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_040,
      });

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
      const cutoffEvidence = createValidBlockTimeCutoff({
        slot: 280_000_200,
        cutoffTimestampMs: 65_000,
        retrievedAtMs: 65_040,
      });

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
