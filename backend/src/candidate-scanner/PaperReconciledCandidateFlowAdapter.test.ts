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
      decisionTimestampMs: BASE_TIME,
      windowStartMs: BASE_TIME - 60_000,
      windowEndMs: BASE_TIME,
      observationStartMs: BASE_TIME - 70_000,
      observationEndMs: BASE_TIME,
      evidenceAgeMs: 2_500,
      maxAllowedEvidenceAgeMs: 15_000,
    },
    sourceCutoff: {
      slot: 280_000_100,
      cutoffTimestampMs: BASE_TIME,
      provenance: "ON_CHAIN_BLOCK_TIME",
      sourceMethod: "getBlockTime",
      responseField: "result",
      commitment: "confirmed",
      retrievedAtMs: BASE_TIME + 2_500,
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
});
