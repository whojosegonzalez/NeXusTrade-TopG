import { describe, it, expect } from "vitest";
import {
  PaperReconciledCandidateFlowAdapter,
  type PaperFlowConversionOptions,
} from "./PaperReconciledCandidateFlowAdapter.js";
import type { WindowReconciliationResult } from "./ExactPoolWindowReconciliationEvaluator.js";
import type { TrackedRaydiumPoolContext } from "./RaydiumAmmV4SwapDecoder.js";

describe("PaperReconciledCandidateFlowAdapter", () => {
  const POOL_ID = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";
  const TOKEN_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
  const BASE_TIME = 1_700_000_065_000;

  const POOL_CONTEXT: TrackedRaydiumPoolContext = {
    poolId: POOL_ID,
    candidateTokenMint: TOKEN_MINT,
    quoteTokenMint: "So11111111111111111111111111111111111111112",
    baseVault: "EkVZ1kV8V2B5U7T3k2Z2x8r8m4K7J3W3e5R2T6U8V9Y",
    quoteVault: "FkVZ1kV8V2B5U7T3k2Z2x8r8m4K7J3W3e5R2T6U8V9Z",
    baseMint: TOKEN_MINT,
    quoteMint: "So11111111111111111111111111111111111111112",
    orientation: "TOKEN_BASE_SOL_QUOTE",
  };

  const createQualifiedQuietResult = (
    overrides?: Partial<WindowReconciliationResult>,
  ): WindowReconciliationResult => ({
    status: "RECONCILED",
    candidate: POOL_CONTEXT,
    temporalContext: {
      decisionTimestampMs: BASE_TIME + 1_000,
      windowStartMs: BASE_TIME - 60_000,
      windowEndMs: BASE_TIME,
      observationStartMs: BASE_TIME - 70_000,
      observationEndMs: BASE_TIME,
      evidenceAgeMs: 1_000,
      maxAllowedEvidenceAgeMs: 15_000,
    },
    sourceCutoff: {
      slot: 280_000_100,
      cutoffTimestampMs: BASE_TIME,
      provenance: "ON_CHAIN_BLOCK_TIME",
      sourceMethod: "getBlockTime",
      responseField: "result",
      commitment: "confirmed",
      retrievedAtMs: BASE_TIME + 500,
    },
    flowCounts: {
      recentBuys60s: 0,
      recentSells60s: 0,
      flowRatio: 1.0,
    },
    flowCoverage: "SUFFICIENT",
    isCoverageSufficient: true,
    underlyingOutcomes: {
      enumerationOutcome: "ANCHOR_WITNESSED",
      resolutionOutcome: "ALL_RESOLVED",
      anchorWitnessed: true,
      knownAnchorSignature:
        "SIG_ANCHOR_1111111111111111111111111111111111111111111111111111111111111111",
      frozenTargetSignature: null,
      totalDiscoveredSignatures: 0,
      totalResolvedTransactions: 0,
      incrementallyReusedCount: 0,
      windowSignaturesCount: 0,
    },
    resourceMetrics: {
      actualRequestsDispatched: 2,
      projectedDemand: {
        watermarkRequests: 0,
        paginationRequests: 0,
        unresolvedTransactionRequests: 0,
        totalProjectedRequests: 0,
        projectedPacingWaitMs: 0,
        projectedRetrievalDurationMs: 0,
        isProjectedBudgetSufficient: true,
      },
      budgetRemaining: 5,
    },
    providerAssumptions: ["Standard RPC indexing assumptions"],
    unresolvedUncertainties: [],
    diagnosticReason: "RECONCILED: Verified quiet window (0 buys, 0 sells in 60s window)",
    isCryptographicCompletenessEstablished: false,
    isProductionCompletenessEstablished: false,
    paperQuietStreamQualified: true,
    paperQualificationReason:
      "PAPER_QUIET_STREAM_QUALIFIED: zero stream notifications confirmed by complete RPC enumeration",
    ...overrides,
  });

  const adapter = new PaperReconciledCandidateFlowAdapter();
  const validTarget = { poolAddress: POOL_ID, tokenMint: TOKEN_MINT };
  const paperOptions: PaperFlowConversionOptions = {
    executionContext: "PAPER_SIMULATION",
    maxAllowedEvidenceAgeMs: 15_000,
  };

  it("successfully converts qualified quiet window to CandidateFlowResult with genuine zeros and SUFFICIENT coverage", () => {
    const reconResult = createQualifiedQuietResult();
    const evalTime = BASE_TIME + 3_000; // 3 seconds after cutoff, <= 15s

    const flowResult = adapter.convertCandidateFlow(
      reconResult,
      validTarget,
      evalTime,
      paperOptions,
    );

    expect(flowResult.isCoverageSufficient).toBe(true);
    expect(flowResult.flowCoverage).toBe("SUFFICIENT");
    expect(flowResult.recentBuys60s).toBe(0);
    expect(flowResult.recentSells60s).toBe(0);
    expect(flowResult.poolAddress).toBe(POOL_ID);
    expect(flowResult.tokenMint).toBe(TOKEN_MINT);
    expect(flowResult.evaluationTimestampMs).toBe(evalTime);
  });

  it("successfully converts qualified quiet window to RetestSpotInfo with explicit time basis disclosure", () => {
    const reconResult = createQualifiedQuietResult();
    const evalTime = BASE_TIME + 4_000;
    const baseSpot = { spotPriceSol: 0.005, spotPriceUsd: 1.25, liquidityUsd: 45_000 };

    const spotInfo = adapter.convertRetestSpotInfo(
      reconResult,
      baseSpot,
      validTarget,
      evalTime,
      paperOptions,
    );

    expect(spotInfo.isPaperQualified).toBe(true);
    expect(spotInfo.flowCoverage).toBe("SUFFICIENT");
    expect(spotInfo.recentBuys60s).toBe(0);
    expect(spotInfo.recentSells60s).toBe(0);
    expect(spotInfo.spotPriceSol).toBe(0.005);
    expect(spotInfo.spotPriceUsd).toBe(1.25);
    expect(spotInfo.liquidityUsd).toBe(45_000);
    expect(spotInfo.researchWindowSpan.cutoffAgeMs).toBe(4_000);
    expect(spotInfo.timeBasisNotice).toContain("Research window is cutoff-anchored");
    expect(spotInfo.timeBasisNotice).toContain("not identical to real-time sliding window");
  });

  it("admits BACKTEST execution context identically to PAPER_SIMULATION", () => {
    const reconResult = createQualifiedQuietResult();
    const backtestOptions: PaperFlowConversionOptions = {
      executionContext: "BACKTEST",
    };

    const flowResult = adapter.convertCandidateFlow(
      reconResult,
      validTarget,
      BASE_TIME + 1_000,
      backtestOptions,
    );
    expect(flowResult.isCoverageSufficient).toBe(true);
    expect(flowResult.flowCoverage).toBe("SUFFICIENT");
  });

  it("fails closed with COLLECTION_GAP and null counts when execution context is not PAPER", () => {
    const reconResult = createQualifiedQuietResult();
    const invalidOptions = {
      executionContext: "PRODUCTION" as unknown as "PAPER_SIMULATION",
    };

    const flowResult = adapter.convertCandidateFlow(
      reconResult,
      validTarget,
      BASE_TIME + 1_000,
      invalidOptions,
    );

    expect(flowResult.isCoverageSufficient).toBe(false);
    expect(flowResult.flowCoverage).toBe("COLLECTION_GAP");
    expect(flowResult.recentBuys60s).toBeNull();
    expect(flowResult.recentSells60s).toBeNull();
    expect(flowResult.diagnosticReason).toContain("NON_PAPER_EXECUTION_CONTEXT");
  });

  it("fails closed with IDENTITY_MISMATCH when target pool or mint does not match candidate", () => {
    const reconResult = createQualifiedQuietResult();
    const wrongTarget = {
      poolAddress: "WrongPoolAddress111111111111111111111111111",
      tokenMint: TOKEN_MINT,
    };

    const flowResult = adapter.convertCandidateFlow(
      reconResult,
      wrongTarget,
      BASE_TIME + 1_000,
      paperOptions,
    );

    expect(flowResult.isCoverageSufficient).toBe(false);
    expect(flowResult.flowCoverage).toBe("COLLECTION_GAP");
    expect(flowResult.recentBuys60s).toBeNull();
    expect(flowResult.recentSells60s).toBeNull();
    expect(flowResult.diagnosticReason).toContain("IDENTITY_MISMATCH");
  });

  it("fails closed with STALE_DATA when evaluation timestamp is > 15,000 ms past cutoff", () => {
    const reconResult = createQualifiedQuietResult();
    const staleEvalTime = BASE_TIME + 16_000; // 16s > 15s limit

    const flowResult = adapter.convertCandidateFlow(
      reconResult,
      validTarget,
      staleEvalTime,
      paperOptions,
    );

    expect(flowResult.isCoverageSufficient).toBe(false);
    expect(flowResult.flowCoverage).toBe("STALE_DATA");
    expect(flowResult.recentBuys60s).toBeNull();
    expect(flowResult.recentSells60s).toBeNull();
    expect(flowResult.diagnosticReason).toContain("STALE_RECONCILIATION_EVIDENCE");
  });

  it("fails closed with COLLECTION_GAP when evaluation timestamp is in the future relative to decision (causality breach)", () => {
    const reconResult = createQualifiedQuietResult();
    const futureDatedCutoffTime = BASE_TIME - 1_000; // evaluation time before cutoff

    const flowResult = adapter.convertCandidateFlow(
      reconResult,
      validTarget,
      futureDatedCutoffTime,
      paperOptions,
    );

    expect(flowResult.isCoverageSufficient).toBe(false);
    expect(flowResult.flowCoverage).toBe("COLLECTION_GAP");
    expect(flowResult.recentBuys60s).toBeNull();
    expect(flowResult.diagnosticReason).toContain("FUTURE_DATED_RECONCILIATION");
  });

  it("fails closed when reconciliation result has non-RECONCILED status or insufficient coverage", () => {
    const nonReconciledResult = createQualifiedQuietResult({
      status: "STREAM_GAP",
      flowCoverage: "COLLECTION_GAP",
      isCoverageSufficient: false,
      flowCounts: { recentBuys60s: null, recentSells60s: null, flowRatio: null },
      diagnosticReason: "COLLECTION_GAP: Stream gap witnessed in observation window",
    });

    const flowResult = adapter.convertCandidateFlow(
      nonReconciledResult,
      validTarget,
      BASE_TIME + 1_000,
      paperOptions,
    );

    expect(flowResult.isCoverageSufficient).toBe(false);
    expect(flowResult.flowCoverage).toBe("COLLECTION_GAP");
    expect(flowResult.recentBuys60s).toBeNull();
    expect(flowResult.recentSells60s).toBeNull();
    expect(flowResult.diagnosticReason).toContain("INSUFFICIENT_FLOW_COVERAGE");
  });

  // Counterexample 3: Freshness & Causality Boundaries
  it("fails closed with CAUSALITY_VIOLATION when conversion timestamp is earlier than original decision (e.g. 65.5s vs 66.0s)", () => {
    // Window cutoff at BASE_TIME (65.0s), decision at BASE_TIME + 1_000 (66.0s)
    const reconResult = createQualifiedQuietResult();
    const midTime = BASE_TIME + 500; // 65.5s: between cutoff and decision

    const flowResult = adapter.convertCandidateFlow(
      reconResult,
      validTarget,
      midTime,
      paperOptions,
    );

    expect(flowResult.isCoverageSufficient).toBe(false);
    expect(flowResult.flowCoverage).toBe("COLLECTION_GAP");
    expect(flowResult.recentBuys60s).toBeNull();
    expect(flowResult.diagnosticReason).toContain("CAUSALITY_VIOLATION");
    expect(flowResult.diagnosticReason).toContain("earlier than original evaluation availability");
  });

  it("fails closed with INVALID_EVALUATION_TIMESTAMP when conversion timestamp is non-integer or non-positive", () => {
    const reconResult = createQualifiedQuietResult();

    const nonIntegerResult = adapter.convertCandidateFlow(
      reconResult,
      validTarget,
      BASE_TIME + 1000.5,
      paperOptions,
    );
    expect(nonIntegerResult.isCoverageSufficient).toBe(false);
    expect(nonIntegerResult.diagnosticReason).toContain("INVALID_EVALUATION_TIMESTAMP");

    const zeroResult = adapter.convertCandidateFlow(reconResult, validTarget, 0, paperOptions);
    expect(zeroResult.isCoverageSufficient).toBe(false);
    expect(zeroResult.diagnosticReason).toContain("INVALID_EVALUATION_TIMESTAMP");

    const nanResult = adapter.convertCandidateFlow(reconResult, validTarget, NaN, paperOptions);
    expect(nanResult.isCoverageSufficient).toBe(false);
    expect(nanResult.diagnosticReason).toContain("INVALID_EVALUATION_TIMESTAMP");
  });

  it("fails closed with INVALID_MAX_ALLOWED_AGE when maxAllowedEvidenceAgeMs is NaN, Infinity, negative, or > 15,000 ms", () => {
    const reconResult = createQualifiedQuietResult();
    const evalTime = BASE_TIME + 2_000;

    // NaN
    const nanRes = adapter.convertCandidateFlow(reconResult, validTarget, evalTime, {
      executionContext: "PAPER_SIMULATION",
      maxAllowedEvidenceAgeMs: NaN,
    });
    expect(nanRes.isCoverageSufficient).toBe(false);
    expect(nanRes.diagnosticReason).toContain("INVALID_MAX_ALLOWED_AGE");

    // Infinity
    const infRes = adapter.convertCandidateFlow(reconResult, validTarget, evalTime, {
      executionContext: "PAPER_SIMULATION",
      maxAllowedEvidenceAgeMs: Infinity,
    });
    expect(infRes.isCoverageSufficient).toBe(false);
    expect(infRes.diagnosticReason).toContain("INVALID_MAX_ALLOWED_AGE");

    // Negative
    const negRes = adapter.convertCandidateFlow(reconResult, validTarget, evalTime, {
      executionContext: "PAPER_SIMULATION",
      maxAllowedEvidenceAgeMs: -100,
    });
    expect(negRes.isCoverageSufficient).toBe(false);
    expect(negRes.diagnosticReason).toContain("INVALID_MAX_ALLOWED_AGE");

    // Expanded limit > 15,000 ms (e.g. 20,000 ms)
    const expandedRes = adapter.convertCandidateFlow(reconResult, validTarget, evalTime, {
      executionContext: "PAPER_SIMULATION",
      maxAllowedEvidenceAgeMs: 20_000,
    });
    expect(expandedRes.isCoverageSufficient).toBe(false);
    expect(expandedRes.diagnosticReason).toContain("INVALID_MAX_ALLOWED_AGE");
    expect(expandedRes.diagnosticReason).toContain("<= 15000 ms");
  });

  it("fails closed with INVALID_WINDOW_STRUCTURE when window span is not exactly 60,000 ms", () => {
    const reconResult = createQualifiedQuietResult({
      temporalContext: {
        decisionTimestampMs: BASE_TIME + 1_000,
        windowStartMs: BASE_TIME - 30_000, // 30s instead of 60s
        windowEndMs: BASE_TIME,
        observationStartMs: BASE_TIME - 70_000,
        observationEndMs: BASE_TIME,
        evidenceAgeMs: 1_000,
        maxAllowedEvidenceAgeMs: 15_000,
      },
    });

    const flowResult = adapter.convertCandidateFlow(
      reconResult,
      validTarget,
      BASE_TIME + 2_000,
      paperOptions,
    );
    expect(flowResult.isCoverageSufficient).toBe(false);
    expect(flowResult.diagnosticReason).toContain("INVALID_WINDOW_STRUCTURE");
  });

  it("fails closed with INVALID_SOURCE_CUTOFF_CONSISTENCY when cutoff does not match windowEndMs or was retrieved after decision", () => {
    // Cutoff mismatch with windowEndMs
    const mismatchedCutoff = createQualifiedQuietResult({
      sourceCutoff: {
        slot: 280_000_100,
        cutoffTimestampMs: BASE_TIME - 5_000, // does not match windowEndMs (BASE_TIME)
        provenance: "ON_CHAIN_BLOCK_TIME",
        sourceMethod: "getBlockTime",
        responseField: "result",
        commitment: "confirmed",
        retrievedAtMs: BASE_TIME + 500,
      },
    });

    const mismatchRes = adapter.convertCandidateFlow(
      mismatchedCutoff,
      validTarget,
      BASE_TIME + 2_000,
      paperOptions,
    );
    expect(mismatchRes.isCoverageSufficient).toBe(false);
    expect(mismatchRes.diagnosticReason).toContain("INVALID_SOURCE_CUTOFF_CONSISTENCY");

    // Cutoff retrieved after decision
    const retrievedAfterDecision = createQualifiedQuietResult({
      sourceCutoff: {
        slot: 280_000_100,
        cutoffTimestampMs: BASE_TIME,
        provenance: "ON_CHAIN_BLOCK_TIME",
        sourceMethod: "getBlockTime",
        responseField: "result",
        commitment: "confirmed",
        retrievedAtMs: BASE_TIME + 2_000, // > decisionTimestampMs (BASE_TIME + 1_000)
      },
    });

    const retrievedAfterRes = adapter.convertCandidateFlow(
      retrievedAfterDecision,
      validTarget,
      BASE_TIME + 2_500,
      paperOptions,
    );
    expect(retrievedAfterRes.isCoverageSufficient).toBe(false);
    expect(retrievedAfterRes.diagnosticReason).toContain("INVALID_SOURCE_CUTOFF_CONSISTENCY");
  });

  // Counterexample 4: Authorized Qualification & Provenance Retention
  it("fails closed with UNQUALIFIED_PAPER_EVIDENCE when paperQuietStreamQualified is false or missing", () => {
    const unqualResult = createQualifiedQuietResult({
      paperQuietStreamQualified: false,
    });

    const flowResult = adapter.convertCandidateFlow(
      unqualResult,
      validTarget,
      BASE_TIME + 2_000,
      paperOptions,
    );
    expect(flowResult.isCoverageSufficient).toBe(false);
    expect(flowResult.diagnosticReason).toContain("UNQUALIFIED_PAPER_EVIDENCE");
  });

  it("fails closed with MISSING_PAPER_QUALIFICATION_REASON when paperQualificationReason is empty string or missing", () => {
    const missingReasonResult = createQualifiedQuietResult({
      paperQualificationReason: "   ",
    });

    const flowResult = adapter.convertCandidateFlow(
      missingReasonResult,
      validTarget,
      BASE_TIME + 2_000,
      paperOptions,
    );
    expect(flowResult.isCoverageSufficient).toBe(false);
    expect(flowResult.diagnosticReason).toContain("MISSING_PAPER_QUALIFICATION_REASON");
  });

  it("fails closed with CONTRADICTORY_FLOW_COUNTS when recentBuys60s, recentSells60s, or flowRatio are contradictory", () => {
    // buys > 0
    const nonZeroBuys = createQualifiedQuietResult({
      flowCounts: { recentBuys60s: 1, recentSells60s: 0, flowRatio: 1.0 },
    });
    const buysRes = adapter.convertCandidateFlow(
      nonZeroBuys,
      validTarget,
      BASE_TIME + 2_000,
      paperOptions,
    );
    expect(buysRes.isCoverageSufficient).toBe(false);
    expect(buysRes.diagnosticReason).toContain("CONTRADICTORY_FLOW_COUNTS");

    // sells > 0
    const nonZeroSells = createQualifiedQuietResult({
      flowCounts: { recentBuys60s: 0, recentSells60s: 2, flowRatio: 0.0 },
    });
    const sellsRes = adapter.convertCandidateFlow(
      nonZeroSells,
      validTarget,
      BASE_TIME + 2_000,
      paperOptions,
    );
    expect(sellsRes.isCoverageSufficient).toBe(false);
    expect(sellsRes.diagnosticReason).toContain("CONTRADICTORY_FLOW_COUNTS");

    // flowRatio !== 1.0
    const ratioMismatch = createQualifiedQuietResult({
      flowCounts: { recentBuys60s: 0, recentSells60s: 0, flowRatio: 0.5 },
    });
    const ratioRes = adapter.convertCandidateFlow(
      ratioMismatch,
      validTarget,
      BASE_TIME + 2_000,
      paperOptions,
    );
    expect(ratioRes.isCoverageSufficient).toBe(false);
    expect(ratioRes.diagnosticReason).toContain("CONTRADICTORY_FLOW_COUNTS");
  });

  it("preserves complete structured qualification context in CandidateFlowResult and RetestSpotInfo", () => {
    const reconResult = createQualifiedQuietResult({
      paperValidatedEpoch: 3,
      providerAssumptions: ["Assumption 1: standard RPC indexing"],
      unresolvedUncertainties: ["Uncertainty 1: upstream latency"],
      paperQualificationReason: "PAPER_QUIET_STREAM_QUALIFIED: verified 0/0 activity",
    });
    const evalTime = BASE_TIME + 3_000;

    const flowResult = adapter.convertCandidateFlow(
      reconResult,
      validTarget,
      evalTime,
      paperOptions,
    );

    expect(flowResult.isCoverageSufficient).toBe(true);
    expect(flowResult.isPaperQualified).toBe(true);
    expect(flowResult.paperQualificationContext).toBeDefined();
    expect(flowResult.paperQualificationContext?.executionContext).toBe("PAPER_SIMULATION");
    expect(flowResult.paperQualificationContext?.validatedEpoch).toBe(3);
    expect(flowResult.paperQualificationContext?.originalEvaluationTimestampMs).toBe(
      BASE_TIME + 1_000,
    );
    expect(flowResult.paperQualificationContext?.researchWindowSpan).toEqual({
      windowStartMs: BASE_TIME - 60_000,
      windowEndMs: BASE_TIME,
      cutoffAgeMs: 3_000,
    });
    expect(flowResult.paperQualificationContext?.cutoffAgeMs).toBe(3_000);
    expect(flowResult.paperQualificationContext?.qualificationReason).toBe(
      "PAPER_QUIET_STREAM_QUALIFIED: verified 0/0 activity",
    );
    expect(flowResult.paperQualificationContext?.providerAssumptions).toEqual([
      "Assumption 1: standard RPC indexing",
    ]);
    expect(flowResult.paperQualificationContext?.unresolvedUncertainties).toEqual([
      "Uncertainty 1: upstream latency",
    ]);

    // RetestSpotInfo conversion
    const baseSpot = { spotPriceSol: 0.005, spotPriceUsd: 1.25, liquidityUsd: 45_000 };
    const spotInfo = adapter.convertRetestSpotInfo(
      reconResult,
      baseSpot,
      validTarget,
      evalTime,
      paperOptions,
    );

    expect(spotInfo.isPaperQualified).toBe(true);
    expect(spotInfo.paperQualificationContext).toBeDefined();
    expect(spotInfo.paperQualificationContext?.validatedEpoch).toBe(3);
    expect(spotInfo.paperQualificationContext?.cutoffAgeMs).toBe(3_000);
    expect(spotInfo.paperQualificationContext?.qualificationReason).toBe(
      "PAPER_QUIET_STREAM_QUALIFIED: verified 0/0 activity",
    );
  });
});
