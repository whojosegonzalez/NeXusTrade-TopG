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
 *    - Validates finite integer conversion timestamps and freshness parameters.
 *    - Rejects conversion timestamps earlier than the result's original evaluation/acquisition availability or cutoff.
 *    - Rejects stale cutoff evidence exceeding maxAllowedEvidenceAgeMs (authorized limit: at most 15,000 ms).
 *    - Rejects invalid (NaN, Infinity, negative, non-integer) or expanded (> 15,000 ms) freshness limits.
 * 4. Qualification Verification & Provenance Preservation:
 *    - Restricts conversion strictly to verified qualified quiet windows (paperQuietStreamQualified === true).
 *    - Rejects missing, false, or unreasoned qualification markers.
 *    - Rejects contradictory counts or coverage (strictly requires 0 buys, 0 sells, flowRatio = 1.0, SUFFICIENT).
 *    - Preserves structured qualification context in both CandidateFlowResult and RetestSpotInfo outputs:
 *      executionContext, validatedEpoch, originalEvaluationTimestampMs, researchWindowSpan, cutoffAgeMs,
 *      qualificationReason, providerAssumptions, and unresolvedUncertainties.
 * 5. Production Protection Invariants:
 *    - Zero modification to production flow getters (evaluateFlow, createRetestSpotInfo).
 *    - Does NOT use, modify, or depend on allowSyntheticCompletenessProofs.
 *    - Gate 11 bundler screening and dynamic exit safeguards remain independent and fail-closed.
 * 6. Transparent Time-Basis Disclosure:
 *    - Validates window structure and cutoff consistency before formatting ISO dates.
 *    - Explicitly reports the cutoff-anchored research window endpoints [windowStartMs .. windowEndMs]
 *      and its latency delta relative to strategy decision time.
 */

import type {
  PaperQualificationKind,
  WindowReconciliationResult,
} from "./ExactPoolWindowReconciliationEvaluator.js";
import type { CandidateFlowTarget, CandidateFlowResult } from "./CandidateFlowProvider.js";
import type { FlowCoverageStatus, RetestSpotInfo } from "./RetestGateEvaluator.js";

export type PaperExecutionContext = "PAPER_SIMULATION" | "BACKTEST";

export interface PaperFlowConversionOptions {
  readonly executionContext: PaperExecutionContext;
  readonly maxAllowedEvidenceAgeMs?: number | undefined; // default: 15,000 ms, authorized max: 15,000 ms
  /**
   * OPT-IN: also accept evaluator results qualified under the explicit PAPER active-window policy.
   * Omitted/false: quiet-window-only conversion (unchanged default).
   */
  readonly allowActiveWindowQualification?: boolean | undefined;
}

/** Evaluator flowRatio convention for reconciled counts (must match exactly). */
function expectedFlowRatio(buys: number, sells: number): number {
  return sells === 0 ? (buys > 0 ? buys : 1.0) : Number((buys / sells).toFixed(2));
}

export interface PaperQualificationContext {
  readonly executionContext: PaperExecutionContext;
  /** QUIET_WINDOW (0/0) or ACTIVE_WINDOW (fully reconciled non-zero in-window signatures). Absent = legacy quiet. */
  readonly qualificationKind?: PaperQualificationKind | undefined;
  readonly validatedEpoch: number;
  readonly originalEvaluationTimestampMs: number;
  readonly researchWindowSpan: {
    readonly windowStartMs: number;
    readonly windowEndMs: number;
    readonly cutoffAgeMs: number;
  };
  readonly cutoffAgeMs: number;
  readonly qualificationReason: string;
  readonly providerAssumptions: readonly string[];
  readonly unresolvedUncertainties: readonly string[];
}

export interface PaperCandidateFlowResult extends CandidateFlowResult {
  readonly isPaperQualified: boolean;
  readonly paperQualificationContext?: PaperQualificationContext | undefined;
}

export interface PaperRetestSpotInfoResult extends RetestSpotInfo {
  readonly isPaperQualified: boolean;
  readonly researchWindowSpan: {
    readonly windowStartMs: number;
    readonly windowEndMs: number;
    readonly cutoffAgeMs: number;
  };
  readonly timeBasisNotice: string;
  readonly paperQualificationContext?: PaperQualificationContext | undefined;
}

/**
 * Isolated adapter converting verified WindowReconciliationResult evidence
 * into candidate flow outputs for offline PAPER evaluation.
 */
export class PaperReconciledCandidateFlowAdapter {
  private readonly defaultMaxAllowedEvidenceAgeMs: number = 15_000;
  private readonly maxAuthorizedEvidenceAgeMs: number = 15_000;

  /**
   * Converts a WindowReconciliationResult into a PaperCandidateFlowResult for paper evaluation.
   */
  public convertCandidateFlow(
    result: WindowReconciliationResult | null | undefined,
    target: CandidateFlowTarget,
    evaluationTimestampMs: number,
    options: PaperFlowConversionOptions,
  ): PaperCandidateFlowResult {
    const targetPool = target?.poolAddress ?? "";
    const targetMint = target?.tokenMint ?? "";

    const createFallback = (
      reason: string,
      coverage: FlowCoverageStatus | "UNAVAILABLE" = "COLLECTION_GAP",
    ): PaperCandidateFlowResult =>
      Object.freeze({
        poolAddress: targetPool,
        tokenMint: targetMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: coverage,
        isCoverageSufficient: false,
        diagnosticReason: reason,
        evaluationTimestampMs:
          typeof evaluationTimestampMs === "number" && Number.isFinite(evaluationTimestampMs)
            ? evaluationTimestampMs
            : 0,
        isPaperQualified: false,
      });

    // 1. Strict Execution Context Validation
    if (
      !options ||
      (options.executionContext !== "PAPER_SIMULATION" && options.executionContext !== "BACKTEST")
    ) {
      return createFallback(
        "NON_PAPER_EXECUTION_CONTEXT: PaperReconciledCandidateFlowAdapter is restricted to PAPER_SIMULATION or BACKTEST execution contexts",
      );
    }

    // 2. Validate Evaluation Timestamp (must be a positive finite integer)
    if (
      typeof evaluationTimestampMs !== "number" ||
      !Number.isFinite(evaluationTimestampMs) ||
      !Number.isInteger(evaluationTimestampMs) ||
      evaluationTimestampMs <= 0
    ) {
      return createFallback(
        `INVALID_EVALUATION_TIMESTAMP: expected positive finite integer millisecond timestamp, received ${String(evaluationTimestampMs)}`,
      );
    }

    // 3. Validate Freshness Limit Parameter (authorized limit: at most 15,000 ms)
    const maxAllowedAgeMs = options.maxAllowedEvidenceAgeMs ?? this.defaultMaxAllowedEvidenceAgeMs;
    if (
      typeof maxAllowedAgeMs !== "number" ||
      !Number.isFinite(maxAllowedAgeMs) ||
      Number.isNaN(maxAllowedAgeMs) ||
      !Number.isInteger(maxAllowedAgeMs) ||
      maxAllowedAgeMs <= 0 ||
      maxAllowedAgeMs > this.maxAuthorizedEvidenceAgeMs
    ) {
      return createFallback(
        `INVALID_MAX_ALLOWED_AGE: maxAllowedEvidenceAgeMs must be a finite positive integer <= ${this.maxAuthorizedEvidenceAgeMs} ms, received ${String(options.maxAllowedEvidenceAgeMs)}`,
      );
    }

    // 4. Validate Result Existence
    if (!result || typeof result !== "object") {
      return createFallback("MISSING_RECONCILIATION_RESULT");
    }

    // 5. Strict Coordinate Binding
    if (
      result.candidate.poolId !== targetPool ||
      result.candidate.candidateTokenMint !== targetMint
    ) {
      return createFallback(
        `IDENTITY_MISMATCH: Target pool=${targetPool}, mint=${targetMint} does not match reconciled candidate pool=${result.candidate.poolId}, mint=${result.candidate.candidateTokenMint}`,
      );
    }

    // 6. Validate Window Structure & Cutoff Consistency
    const windowStartMs = result.temporalContext?.windowStartMs;
    const windowEndMs = result.temporalContext?.windowEndMs;
    const origDecisionMs = result.temporalContext?.decisionTimestampMs;

    if (
      typeof windowStartMs !== "number" ||
      typeof windowEndMs !== "number" ||
      typeof origDecisionMs !== "number" ||
      !Number.isSafeInteger(windowStartMs) ||
      !Number.isSafeInteger(windowEndMs) ||
      !Number.isSafeInteger(origDecisionMs) ||
      windowStartMs <= 0 ||
      windowEndMs <= 0 ||
      origDecisionMs <= 0 ||
      windowEndMs - windowStartMs !== 60_000
    ) {
      return createFallback(
        "INVALID_WINDOW_STRUCTURE: Research window endpoints must be positive finite integers spanning exactly 60,000 ms",
      );
    }

    if (
      !result.sourceCutoff ||
      typeof result.sourceCutoff !== "object" ||
      typeof result.sourceCutoff.cutoffTimestampMs !== "number" ||
      !Number.isFinite(result.sourceCutoff.cutoffTimestampMs) ||
      result.sourceCutoff.cutoffTimestampMs !== windowEndMs ||
      typeof result.sourceCutoff.retrievedAtMs !== "number" ||
      !Number.isFinite(result.sourceCutoff.retrievedAtMs) ||
      result.sourceCutoff.retrievedAtMs > origDecisionMs
    ) {
      return createFallback(
        "INVALID_SOURCE_CUTOFF_CONSISTENCY: Source cutoff is missing, inconsistent with windowEndMs, or retrieved after decision time",
      );
    }

    // 7. Validate Temporal Ordering (Conversion-Time Causality)
    if (evaluationTimestampMs < windowEndMs) {
      return createFallback(
        `FUTURE_DATED_RECONCILIATION: Conversion timestamp (${evaluationTimestampMs} ms) is earlier than research cutoff (${windowEndMs} ms)`,
      );
    }

    if (evaluationTimestampMs < origDecisionMs) {
      return createFallback(
        `CAUSALITY_VIOLATION: Conversion timestamp (${evaluationTimestampMs} ms) is earlier than original evaluation availability (${origDecisionMs} ms)`,
      );
    }

    if (evaluationTimestampMs < result.sourceCutoff.retrievedAtMs) {
      return createFallback(
        `CAUSALITY_VIOLATION: Conversion timestamp (${evaluationTimestampMs} ms) is earlier than cutoff retrieval (${result.sourceCutoff.retrievedAtMs} ms)`,
      );
    }

    // 8. Validate Freshness
    const cutoffAgeMs = evaluationTimestampMs - windowEndMs;
    if (cutoffAgeMs > maxAllowedAgeMs) {
      return createFallback(
        `STALE_RECONCILIATION_EVIDENCE: Research cutoff age (${cutoffAgeMs} ms) exceeds max allowed evidence age (${maxAllowedAgeMs} ms)`,
        "STALE_DATA",
      );
    }

    // 9. Require Authorized PAPER Qualification & Reject Contradictory Counts/Coverage
    const isQuietQualified = result.paperQuietStreamQualified === true;
    const isActiveQualified = result.paperActiveWindowQualified === true;
    if (isQuietQualified && isActiveQualified) {
      return createFallback(
        "CONTRADICTORY_PAPER_QUALIFICATION: Result claims both quiet-window and active-window qualification",
      );
    }
    if (!isQuietQualified && !isActiveQualified) {
      return createFallback(
        "UNQUALIFIED_PAPER_EVIDENCE: Reconciliation result lacks paperQuietStreamQualified === true",
      );
    }
    if (isActiveQualified && options.allowActiveWindowQualification !== true) {
      return createFallback(
        "ACTIVE_WINDOW_NOT_OPTED_IN: Active-window PAPER qualification requires explicit allowActiveWindowQualification",
      );
    }
    const qualificationKind: PaperQualificationKind = isActiveQualified
      ? "ACTIVE_WINDOW"
      : "QUIET_WINDOW";
    if (
      result.paperQualificationKind !== undefined &&
      result.paperQualificationKind !== qualificationKind
    ) {
      return createFallback(
        `CONTRADICTORY_PAPER_QUALIFICATION: paperQualificationKind '${String(result.paperQualificationKind)}' does not match qualification flags`,
      );
    }
    if (isActiveQualified && result.paperQualificationKind !== "ACTIVE_WINDOW") {
      return createFallback(
        "CONTRADICTORY_PAPER_QUALIFICATION: Active-window qualification requires paperQualificationKind ACTIVE_WINDOW",
      );
    }

    if (
      typeof result.paperQualificationReason !== "string" ||
      result.paperQualificationReason.trim().length === 0
    ) {
      return createFallback(
        "MISSING_PAPER_QUALIFICATION_REASON: Reconciliation result lacks non-empty paperQualificationReason",
      );
    }

    if (
      result.status !== "RECONCILED" ||
      result.flowCoverage !== "SUFFICIENT" ||
      result.isCoverageSufficient !== true
    ) {
      return createFallback(
        `INSUFFICIENT_FLOW_COVERAGE: Reconciliation status=${result.status}, flowCoverage=${result.flowCoverage}, isCoverageSufficient=${result.isCoverageSufficient} (${result.diagnosticReason})`,
        result.flowCoverage,
      );
    }

    const buys = result.flowCounts.recentBuys60s;
    const sells = result.flowCounts.recentSells60s;
    if (qualificationKind === "QUIET_WINDOW") {
      // Validate genuine 0/0 counts and flowRatio = 1.0 convention for quiet window qualification
      if (buys !== 0 || sells !== 0 || result.flowCounts.flowRatio !== 1.0) {
        return createFallback(
          `CONTRADICTORY_FLOW_COUNTS: Qualified quiet window must have recentBuys60s=0, recentSells60s=0, flowRatio=1.0 (received buys=${buys}, sells=${sells}, ratio=${result.flowCounts.flowRatio})`,
        );
      }
    } else {
      // Active window: verified non-negative integer counts from decoded events and >= 1 in-window signature
      const windowSigs = result.underlyingOutcomes?.windowSignaturesCount;
      if (
        typeof buys !== "number" ||
        typeof sells !== "number" ||
        !Number.isSafeInteger(buys) ||
        !Number.isSafeInteger(sells) ||
        buys < 0 ||
        sells < 0 ||
        result.flowCounts.flowRatio !== expectedFlowRatio(buys, sells) ||
        typeof windowSigs !== "number" ||
        !Number.isSafeInteger(windowSigs) ||
        windowSigs < 1 ||
        result.underlyingOutcomes.anchorWitnessed !== true
      ) {
        return createFallback(
          `CONTRADICTORY_FLOW_COUNTS: Qualified active window requires non-negative integer counts, consistent flowRatio, >= 1 in-window signature and a witnessed anchor (received buys=${String(buys)}, sells=${String(sells)}, ratio=${String(result.flowCounts.flowRatio)}, windowSignatures=${String(windowSigs)})`,
        );
      }
    }

    // 10. Require Evaluator's Explicit Validated Epoch
    const validatedEpoch = result.paperValidatedEpoch;

    if (
      validatedEpoch === undefined ||
      typeof validatedEpoch !== "number" ||
      !Number.isSafeInteger(validatedEpoch) ||
      validatedEpoch < 0
    ) {
      return createFallback(
        `INVALID_VALIDATED_EPOCH: Reconciliation result must contain a valid non-negative integer paperValidatedEpoch (received ${String(validatedEpoch)})`,
      );
    }

    const paperQualificationContext: PaperQualificationContext = Object.freeze({
      executionContext: options.executionContext,
      qualificationKind,
      validatedEpoch,
      originalEvaluationTimestampMs: origDecisionMs,
      researchWindowSpan: Object.freeze({
        windowStartMs,
        windowEndMs,
        cutoffAgeMs,
      }),
      cutoffAgeMs,
      qualificationReason: result.paperQualificationReason,
      providerAssumptions: Object.freeze([...(result.providerAssumptions ?? [])]),
      unresolvedUncertainties: Object.freeze([...(result.unresolvedUncertainties ?? [])]),
    });

    // 11. Successful PAPER Conversion
    return Object.freeze({
      poolAddress: targetPool,
      tokenMint: targetMint,
      recentBuys60s: buys as number,
      recentSells60s: sells as number,
      flowCoverage: "SUFFICIENT" as const,
      isCoverageSufficient: true,
      diagnosticReason: result.diagnosticReason,
      evaluationTimestampMs,
      isPaperQualified: true,
      paperQualificationContext,
    });
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

    const windowStartMs = result?.temporalContext?.windowStartMs ?? 0;
    const windowEndMs = result?.temporalContext?.windowEndMs ?? 0;
    const cutoffAgeMs =
      result && Number.isFinite(evaluationTimestampMs) && typeof windowEndMs === "number"
        ? evaluationTimestampMs - windowEndMs
        : -1;

    let timeBasisNotice: string;
    if (
      flowResult.isCoverageSufficient &&
      flowResult.isPaperQualified &&
      Number.isSafeInteger(windowStartMs) &&
      Number.isSafeInteger(windowEndMs) &&
      windowStartMs > 0 &&
      windowEndMs > 0
    ) {
      timeBasisNotice = `Research window is cutoff-anchored [${new Date(windowStartMs).toISOString()} .. ${new Date(windowEndMs).toISOString()}], lagging evaluation time by ${cutoffAgeMs} ms; not identical to real-time sliding window.`;
    } else {
      timeBasisNotice = "Research window unavailable or flow coverage insufficient.";
    }

    return Object.freeze({
      spotPriceSol: baseSpot.spotPriceSol,
      spotPriceUsd: baseSpot.spotPriceUsd,
      liquidityUsd: baseSpot.liquidityUsd,
      recentBuys60s: flowResult.recentBuys60s,
      recentSells60s: flowResult.recentSells60s,
      flowCoverage: flowResult.flowCoverage as FlowCoverageStatus,
      isPaperQualified: flowResult.isPaperQualified,
      researchWindowSpan: Object.freeze({
        windowStartMs,
        windowEndMs,
        cutoffAgeMs,
      }),
      timeBasisNotice,
      ...(flowResult.paperQualificationContext
        ? { paperQualificationContext: flowResult.paperQualificationContext }
        : {}),
    });
  }
}
