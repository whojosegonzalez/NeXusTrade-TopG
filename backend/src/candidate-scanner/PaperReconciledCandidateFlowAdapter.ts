/**
 * NeXusTrade — Isolated PAPER Reconciled Candidate Flow Adapter
 *
 * Dedicated, side-effect-free adapter bridging verified WindowReconciliationResult
 * evidence to PAPER candidate evaluation (CandidateFlowResult & RetestSpotInfo)
 * exclusively during offline simulation and backtesting.
 *
 * OPERATIONAL & SAFETY INVARIANTS:
 * 1. Strict PAPER-Only Scope:
 *    - Explicitly requires executionContext: "PAPER_SIMULATION" | "BACKTEST".
 *    - Rejects production or undefined contexts fail-closed with COLLECTION_GAP and null counts.
 * 2. Identity & Coordinate Binding:
 *    - Validates exact case-sensitive pool address and candidate token mint.
 *    - Rejects coordinate mismatches fail-closed with IDENTITY_MISMATCH.
 * 3. Freshness & Causality Validation:
 *    - Rejects future-dated reconciliation evidence (evaluationTimestampMs < windowEndMs).
 *    - Rejects stale cutoff evidence exceeding maxAllowedEvidenceAgeMs (default: 15,000 ms).
 * 4. Production Protection Invariants:
 *    - Zero modification to production flow getters (evaluateFlow, createRetestSpotInfo).
 *    - Does NOT use, modify, or depend on allowSyntheticCompletenessProofs.
 *    - Gate 11 bundler screening and dynamic exit safeguards remain independent and fail-closed.
 * 5. Transparent Time-Basis Disclosure:
 *    - Explicitly reports the cutoff-anchored research window endpoints [windowStartMs .. windowEndMs]
 *      and its latency delta relative to strategy decision time.
 */

import type { WindowReconciliationResult } from "./ExactPoolWindowReconciliationEvaluator.js";
import type { CandidateFlowTarget, CandidateFlowResult } from "./CandidateFlowProvider.js";
import type { FlowCoverageStatus, RetestSpotInfo } from "./RetestGateEvaluator.js";

export type PaperExecutionContext = "PAPER_SIMULATION" | "BACKTEST";

export interface PaperFlowConversionOptions {
  readonly executionContext: PaperExecutionContext;
  readonly maxAllowedEvidenceAgeMs?: number | undefined; // default: 15,000 ms
}

export interface PaperRetestSpotInfoResult extends RetestSpotInfo {
  readonly isPaperQualified: boolean;
  readonly researchWindowSpan: {
    readonly windowStartMs: number;
    readonly windowEndMs: number;
    readonly cutoffAgeMs: number;
  };
  readonly timeBasisNotice: string;
}

/**
 * Isolated adapter converting verified WindowReconciliationResult evidence
 * into candidate flow outputs for offline PAPER evaluation.
 */
export class PaperReconciledCandidateFlowAdapter {
  private readonly defaultMaxAllowedEvidenceAgeMs: number = 15_000;

  /**
   * Converts a WindowReconciliationResult into a CandidateFlowResult for paper evaluation.
   */
  public convertCandidateFlow(
    result: WindowReconciliationResult | null | undefined,
    target: CandidateFlowTarget,
    evaluationTimestampMs: number,
    options: PaperFlowConversionOptions,
  ): CandidateFlowResult {
    const targetPool = target?.poolAddress ?? "";
    const targetMint = target?.tokenMint ?? "";

    // 1. Strict Execution Context Validation
    if (
      !options ||
      (options.executionContext !== "PAPER_SIMULATION" && options.executionContext !== "BACKTEST")
    ) {
      return {
        poolAddress: targetPool,
        tokenMint: targetMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason:
          "NON_PAPER_EXECUTION_CONTEXT: PaperReconciledCandidateFlowAdapter is restricted to PAPER_SIMULATION or BACKTEST execution contexts",
        evaluationTimestampMs,
      };
    }

    // 2. Validate Result Existence
    if (!result) {
      return {
        poolAddress: targetPool,
        tokenMint: targetMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: "MISSING_RECONCILIATION_RESULT",
        evaluationTimestampMs,
      };
    }

    // 3. Strict Coordinate Binding
    if (
      result.candidate.poolId !== targetPool ||
      result.candidate.candidateTokenMint !== targetMint
    ) {
      return {
        poolAddress: targetPool,
        tokenMint: targetMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: `IDENTITY_MISMATCH: Target pool=${targetPool}, mint=${targetMint} does not match reconciled candidate pool=${result.candidate.poolId}, mint=${result.candidate.candidateTokenMint}`,
        evaluationTimestampMs,
      };
    }

    // 4. Validate Decision Timestamp
    if (
      typeof evaluationTimestampMs !== "number" ||
      !Number.isFinite(evaluationTimestampMs) ||
      evaluationTimestampMs <= 0
    ) {
      return {
        poolAddress: targetPool,
        tokenMint: targetMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: "INVALID_EVALUATION_TIMESTAMP",
        evaluationTimestampMs,
      };
    }

    // 5. Validate Temporal Ordering (Causality) & Freshness
    const windowEndMs = result.temporalContext.windowEndMs;
    const cutoffAgeMs = evaluationTimestampMs - windowEndMs;
    const maxAllowedAgeMs = options.maxAllowedEvidenceAgeMs ?? this.defaultMaxAllowedEvidenceAgeMs;

    if (cutoffAgeMs < 0) {
      return {
        poolAddress: targetPool,
        tokenMint: targetMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: `FUTURE_DATED_RECONCILIATION: Evaluation timestamp ${evaluationTimestampMs} ms is earlier than research cutoff ${windowEndMs} ms`,
        evaluationTimestampMs,
      };
    }

    if (cutoffAgeMs > maxAllowedAgeMs) {
      return {
        poolAddress: targetPool,
        tokenMint: targetMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "STALE_DATA",
        isCoverageSufficient: false,
        diagnosticReason: `STALE_RECONCILIATION_EVIDENCE: Research cutoff age (${cutoffAgeMs} ms) exceeds max allowed evidence age (${maxAllowedAgeMs} ms)`,
        evaluationTimestampMs,
      };
    }

    // 6. Validate Reconciliation Terminal Status & Sufficiency
    if (
      result.status !== "RECONCILED" ||
      !result.isCoverageSufficient ||
      result.flowCoverage !== "SUFFICIENT"
    ) {
      return {
        poolAddress: targetPool,
        tokenMint: targetMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: result.flowCoverage,
        isCoverageSufficient: false,
        diagnosticReason: `INSUFFICIENT_FLOW_COVERAGE: Reconciliation status=${result.status}, flowCoverage=${result.flowCoverage} (${result.diagnosticReason})`,
        evaluationTimestampMs,
      };
    }

    // 7. Successful PAPER Conversion
    return {
      poolAddress: targetPool,
      tokenMint: targetMint,
      recentBuys60s: result.flowCounts.recentBuys60s,
      recentSells60s: result.flowCounts.recentSells60s,
      flowCoverage: "SUFFICIENT",
      isCoverageSufficient: true,
      diagnosticReason: result.diagnosticReason,
      evaluationTimestampMs,
    };
  }

  /**
   * Converts a WindowReconciliationResult into a RetestSpotInfo object for strategy evaluation.
   */
  public convertRetestSpotInfo(
    result: WindowReconciliationResult | null | undefined,
    baseSpot: {
      readonly spotPriceSol: number;
      readonly spotPriceUsd?: number | null | undefined;
      readonly liquidityUsd?: number | null | undefined;
    },
    target: CandidateFlowTarget,
    evaluationTimestampMs: number,
    options: PaperFlowConversionOptions,
  ): PaperRetestSpotInfoResult {
    const flowResult = this.convertCandidateFlow(result, target, evaluationTimestampMs, options);

    const windowStartMs = result?.temporalContext.windowStartMs ?? 0;
    const windowEndMs = result?.temporalContext.windowEndMs ?? 0;
    const cutoffAgeMs =
      result && Number.isFinite(evaluationTimestampMs) ? evaluationTimestampMs - windowEndMs : -1;

    const timeBasisNotice = flowResult.isCoverageSufficient
      ? `Research window is cutoff-anchored [${new Date(windowStartMs).toISOString()} .. ${new Date(windowEndMs).toISOString()}], lagging evaluation time by ${cutoffAgeMs} ms; not identical to real-time sliding window.`
      : "Research window unavailable or flow coverage insufficient.";

    return {
      spotPriceSol: baseSpot.spotPriceSol,
      spotPriceUsd: baseSpot.spotPriceUsd,
      liquidityUsd: baseSpot.liquidityUsd,
      recentBuys60s: flowResult.recentBuys60s,
      recentSells60s: flowResult.recentSells60s,
      flowCoverage: flowResult.flowCoverage as FlowCoverageStatus,
      isPaperQualified: flowResult.isCoverageSufficient,
      researchWindowSpan: {
        windowStartMs,
        windowEndMs,
        cutoffAgeMs,
      },
      timeBasisNotice,
    };
  }
}
