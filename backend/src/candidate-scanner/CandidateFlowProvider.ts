/**
 * Phase 12.94-D Milestone D.3.3: Candidate Flow Provider & Evaluation Seam
 *
 * Side-effect-free module defining the injectable flow provider interface and reusable
 * coordinator bridge connecting candidate trade flow observation to daemon evaluation.
 *
 * Operational and Safety Invariants:
 * 1. Strict Candidate Identity Binding:
 *    - Validates exact, case-sensitive candidate pool address and candidate token mint.
 *    - Rejects identity mismatches fail-closed with explicit diagnostic reasons.
 * 2. Fail-Closed on Missing/Invalid/Incomplete Flow:
 *    - Missing providers, lookup exceptions, coordinator exceptions, invalid numeric counts,
 *      or non-SUFFICIENT coverage strictly return unavailable (null) counts and non-SUFFICIENT status.
 *    - Never falls back to five-minute division estimates or substitutes zero for missing flow.
 * 3. Legitimate Zero Count Preservation:
 *    - When flow coverage is genuinely SUFFICIENT and zero swaps are observed in the lookback window,
 *      the legitimate numeric 0 is preserved as distinct from unavailable (null) counts.
 * 4. Unified Decision Point Binding:
 *    - Candidate Buy Gate and Retest Gate consume the identical candidate-bound flow result.
 * 5. Production Source Completeness Separation:
 *    - Production-default coordinators strictly retain unavailable (null) flow counts unless
 *      explicitly configured in isolated synthetic test fixtures (allowSyntheticCompletenessProofs: true).
 *    - No environment variable or CLI flag is permitted to bypass production completeness protections.
 */

import type { WatchlistCandidateItem } from "@nexustrade/shared";
import type {
  FlowCoverageStatus,
  RetestSpotInfo,
  RetestGateResult,
} from "./RetestGateEvaluator.js";
import { evaluateRetestGate } from "./RetestGateEvaluator.js";
import {
  BuyGateTriggerService,
  type ArmedPullbackState,
  type AdvancedMarketContext,
  type BuyGateEvaluationResult,
} from "./BuyGateTriggerService.js";
import type {
  PaperExecutionContext,
  PaperQualificationContext,
} from "./PaperReconciledCandidateFlowAdapter.js";
import type {
  RaydiumCandidateSubscriptionCoordinator,
  CoordinatorCoverageDiagnostic,
} from "./RaydiumCandidateSubscriptionCoordinator.js";
import type { TrackedRaydiumPoolContext } from "./RaydiumAmmV4SwapDecoder.js";

/**
 * Candidate pool and token mint coordinates.
 */
export interface CandidateFlowTarget {
  readonly poolAddress: string;
  readonly tokenMint: string;
}

/**
 * Candidate flow resolution result.
 */
export interface CandidateFlowResult {
  readonly poolAddress: string;
  readonly tokenMint: string;
  readonly recentBuys60s: number | null;
  readonly recentSells60s: number | null;
  readonly flowCoverage: FlowCoverageStatus | "UNAVAILABLE";
  readonly isCoverageSufficient: boolean;
  readonly diagnosticReason: string;
  readonly evaluationTimestampMs: number;
  readonly isPaperQualified?: boolean | undefined;
  readonly paperQualificationContext?: PaperQualificationContext | undefined;
  readonly windowStartMs?: number | undefined;
  readonly windowEndMs?: number | undefined;
  readonly connectionEpoch?: number | undefined;
}

/**
 * Injectable flow provider interface for candidate flow observation.
 */
export interface CandidateFlowProvider {
  getCandidateFlow(target: CandidateFlowTarget, evaluationTimestampMs: number): CandidateFlowResult;
}

/**
 * Default fail-closed flow provider when no active coordinator or provider is configured.
 */
export class UnavailableCandidateFlowProvider implements CandidateFlowProvider {
  public getCandidateFlow(
    target: CandidateFlowTarget,
    evaluationTimestampMs: number,
  ): CandidateFlowResult {
    return {
      poolAddress: target?.poolAddress ?? "",
      tokenMint: target?.tokenMint ?? "",
      recentBuys60s: null,
      recentSells60s: null,
      flowCoverage: "COLLECTION_GAP",
      isCoverageSufficient: false,
      diagnosticReason: "NO_FLOW_PROVIDER_CONFIGURED",
      evaluationTimestampMs,
    };
  }
}

/**
 * Lookup source for coordinator instances.
 */
export type CoordinatorLookup =
  | RaydiumCandidateSubscriptionCoordinator
  | ((poolAddress: string) => RaydiumCandidateSubscriptionCoordinator | undefined)
  | ReadonlyMap<string, RaydiumCandidateSubscriptionCoordinator>;

/**
 * Reusable implementation bridging RaydiumCandidateSubscriptionCoordinator.
 */
export class CoordinatorCandidateFlowProvider implements CandidateFlowProvider {
  private readonly lookup: (
    poolAddress: string,
  ) => RaydiumCandidateSubscriptionCoordinator | undefined;

  constructor(resolver?: CoordinatorLookup | undefined) {
    if (!resolver) {
      this.lookup = () => undefined;
    } else if (typeof resolver === "function") {
      this.lookup = resolver;
    } else if (typeof (resolver as { get?: unknown }).get === "function") {
      const map = resolver as ReadonlyMap<string, RaydiumCandidateSubscriptionCoordinator>;
      this.lookup = (addr: string) => map.get(addr);
    } else {
      const single = resolver as RaydiumCandidateSubscriptionCoordinator;
      this.lookup = (addr: string) => {
        try {
          return single.getPoolContext().poolId === addr ? single : undefined;
        } catch {
          return undefined;
        }
      };
    }
  }

  public getCandidateFlow(
    target: CandidateFlowTarget,
    evaluationTimestampMs: number,
  ): CandidateFlowResult {
    // 1. Target validation
    if (
      !target ||
      typeof target.poolAddress !== "string" ||
      typeof target.tokenMint !== "string" ||
      !target.poolAddress.trim() ||
      !target.tokenMint.trim()
    ) {
      return {
        poolAddress: target?.poolAddress ?? "",
        tokenMint: target?.tokenMint ?? "",
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: "INVALID_TARGET_COORDINATES",
        evaluationTimestampMs,
      };
    }

    // 2. Timestamp validation
    if (
      !Number.isFinite(evaluationTimestampMs) ||
      !Number.isInteger(evaluationTimestampMs) ||
      evaluationTimestampMs < 0
    ) {
      return {
        poolAddress: target.poolAddress,
        tokenMint: target.tokenMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: "INVALID_EVALUATION_TIMESTAMP",
        evaluationTimestampMs,
      };
    }

    // 3. Resolve coordinator
    let coordinator: RaydiumCandidateSubscriptionCoordinator | undefined;
    try {
      coordinator = this.lookup(target.poolAddress);
    } catch (lookupErr) {
      return {
        poolAddress: target.poolAddress,
        tokenMint: target.tokenMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: `PROVIDER_LOOKUP_EXCEPTION: ${lookupErr instanceof Error ? lookupErr.message : String(lookupErr)}`,
        evaluationTimestampMs,
      };
    }

    if (!coordinator) {
      return {
        poolAddress: target.poolAddress,
        tokenMint: target.tokenMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: `NO_COORDINATOR_FOR_POOL: ${target.poolAddress}`,
        evaluationTimestampMs,
      };
    }

    // 4. Validate exact, case-sensitive identity
    let poolContext: TrackedRaydiumPoolContext;
    try {
      poolContext = coordinator.getPoolContext();
    } catch (contextErr) {
      return {
        poolAddress: target.poolAddress,
        tokenMint: target.tokenMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: `FAILED_TO_GET_POOL_CONTEXT: ${contextErr instanceof Error ? contextErr.message : String(contextErr)}`,
        evaluationTimestampMs,
      };
    }

    if (
      poolContext.poolId !== target.poolAddress ||
      poolContext.candidateTokenMint !== target.tokenMint
    ) {
      return {
        poolAddress: target.poolAddress,
        tokenMint: target.tokenMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: `IDENTITY_MISMATCH: requested pool=${target.poolAddress}, mint=${target.tokenMint} but coordinator is bound to pool=${poolContext.poolId}, mint=${poolContext.candidateTokenMint}`,
        evaluationTimestampMs,
      };
    }

    // 5. Query coordinator safely
    try {
      let diag: CoordinatorCoverageDiagnostic | undefined;
      try {
        diag = coordinator.getCoverageDiagnostic(evaluationTimestampMs);
      } catch {
        // If coverage diagnostic throws, proceed with fallback diagnostic
      }

      const dummySpot = { spotPriceSol: 1 };
      const spotWithFlow = coordinator.createRetestSpotInfo(dummySpot, evaluationTimestampMs);

      const isSufficient = spotWithFlow.flowCoverage === "SUFFICIENT";
      const buys = spotWithFlow.recentBuys60s;
      const sells = spotWithFlow.recentSells60s;

      const rawResult = {
        poolAddress: target.poolAddress,
        tokenMint: target.tokenMint,
        recentBuys60s: buys,
        recentSells60s: sells,
        flowCoverage: spotWithFlow.flowCoverage,
        isCoverageSufficient: isSufficient,
        diagnosticReason:
          diag?.limitationReason ||
          (isSufficient ? "Coverage is sufficient" : "INSUFFICIENT_FLOW_COVERAGE"),
        evaluationTimestampMs,
      };

      return validateAndSnapshotCandidateFlowResult(rawResult, target, evaluationTimestampMs);
    } catch (evalErr) {
      return {
        poolAddress: target.poolAddress,
        tokenMint: target.tokenMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: `COORDINATOR_EVALUATION_EXCEPTION: ${evalErr instanceof Error ? evalErr.message : String(evalErr)}`,
        evaluationTimestampMs,
      };
    }
  }
}

export interface SnapshotCandidateFlowOptions {
  readonly executionContext?: PaperExecutionContext | "PRODUCTION" | undefined;
  readonly maxAllowedEvidenceAgeMs?: number | undefined;
}

/**
 * Validates and snapshots an arbitrary provider result against requested target coordinates and evaluation timestamp.
 * Guarantees that downstream decision points always receive a sound, immutable CandidateFlowResult.
 * Any mismatch, inconsistency, corruption, or exception is collapsed into explicit unavailable flow (null counts, non-SUFFICIENT coverage).
 */
export function validateAndSnapshotCandidateFlowResult(
  rawResult: unknown,
  target: CandidateFlowTarget,
  evaluationTimestampMs: number,
  options?: SnapshotCandidateFlowOptions,
): CandidateFlowResult {
  const isPaperMode =
    options?.executionContext === "PAPER_SIMULATION" || options?.executionContext === "BACKTEST";

  const fallback = (
    reason: string,
    coverage: FlowCoverageStatus | "UNAVAILABLE" = "COLLECTION_GAP",
  ): CandidateFlowResult =>
    Object.freeze({
      poolAddress: target?.poolAddress ?? "",
      tokenMint: target?.tokenMint ?? "",
      recentBuys60s: null,
      recentSells60s: null,
      flowCoverage: coverage,
      isCoverageSufficient: false,
      diagnosticReason: reason,
      evaluationTimestampMs,
      ...(isPaperMode ? { isPaperQualified: false } : {}),
    });

  // Validate options if provided
  const rawMaxAge = options?.maxAllowedEvidenceAgeMs;
  let maxAllowedAgeMs = 15_000;
  if (rawMaxAge !== undefined) {
    if (
      typeof rawMaxAge !== "number" ||
      !Number.isFinite(rawMaxAge) ||
      Number.isNaN(rawMaxAge) ||
      !Number.isInteger(rawMaxAge) ||
      rawMaxAge <= 0 ||
      rawMaxAge > 15_000
    ) {
      return fallback(
        `INVALID_MAX_ALLOWED_AGE: maxAllowedEvidenceAgeMs must be a finite positive integer <= 15000 ms, received ${String(rawMaxAge)}`,
      );
    }
    maxAllowedAgeMs = rawMaxAge;
  }

  // 1. Safe handling of null, undefined, or non-object results
  if (!rawResult || typeof rawResult !== "object") {
    return fallback(`MALFORMED_PROVIDER_RESULT: provider returned ${String(rawResult)}`);
  }

  const res = rawResult as Record<string, unknown>;

  // 2. Exact, case-sensitive pool and mint match
  if (typeof res.poolAddress !== "string" || res.poolAddress !== target.poolAddress) {
    return fallback(
      `IDENTITY_MISMATCH_POOL: expected exact pool '${target.poolAddress}', received '${String(res.poolAddress)}'`,
    );
  }
  if (typeof res.tokenMint !== "string" || res.tokenMint !== target.tokenMint) {
    return fallback(
      `IDENTITY_MISMATCH_MINT: expected exact mint '${target.tokenMint}', received '${String(res.tokenMint)}'`,
    );
  }

  // 3. Valid evaluation timestamp matching requested evaluation
  if (
    typeof res.evaluationTimestampMs !== "number" ||
    !Number.isFinite(res.evaluationTimestampMs) ||
    !Number.isInteger(res.evaluationTimestampMs)
  ) {
    return fallback(
      `INVALID_EVALUATION_TIMESTAMP: expected finite integer, received ${String(res.evaluationTimestampMs)}`,
    );
  }
  if (res.evaluationTimestampMs !== evaluationTimestampMs) {
    return fallback(
      `TIMESTAMP_MISMATCH: expected evaluation timestamp ${evaluationTimestampMs}, received ${res.evaluationTimestampMs}`,
    );
  }

  // 4. PAPER Qualification Provenance Validation
  if (res.isPaperQualified !== undefined && typeof res.isPaperQualified !== "boolean") {
    return fallback(
      `INCONSISTENT_PAPER_QUALIFICATION: isPaperQualified must be a boolean when present`,
    );
  }

  const hasPaperMarker = res.isPaperQualified === true;
  const hasPaperCtx = res.paperQualificationContext !== undefined;

  if (hasPaperMarker !== hasPaperCtx) {
    return fallback(
      "INCONSISTENT_PAPER_QUALIFICATION: isPaperQualified must be true and paperQualificationContext must be provided",
    );
  }

  if (hasPaperMarker) {
    if (!isPaperMode) {
      // Reject PAPER-qualified evidence in default/production mode
      return fallback("PAPER_QUALIFIED_EVIDENCE_REJECTED_IN_PRODUCTION");
    }

    const paperCtx = res.paperQualificationContext as PaperQualificationContext | undefined;
    if (
      !paperCtx ||
      typeof paperCtx !== "object" ||
      paperCtx.executionContext !== options?.executionContext ||
      typeof paperCtx.validatedEpoch !== "number" ||
      !Number.isSafeInteger(paperCtx.validatedEpoch) ||
      paperCtx.validatedEpoch < 0 ||
      !paperCtx.researchWindowSpan ||
      typeof paperCtx.researchWindowSpan !== "object" ||
      typeof paperCtx.researchWindowSpan.windowStartMs !== "number" ||
      typeof paperCtx.researchWindowSpan.windowEndMs !== "number" ||
      !Number.isSafeInteger(paperCtx.researchWindowSpan.windowStartMs) ||
      !Number.isSafeInteger(paperCtx.researchWindowSpan.windowEndMs) ||
      paperCtx.researchWindowSpan.windowStartMs <= 0 ||
      paperCtx.researchWindowSpan.windowEndMs <= 0 ||
      paperCtx.researchWindowSpan.windowEndMs - paperCtx.researchWindowSpan.windowStartMs !==
        60_000 ||
      typeof paperCtx.originalEvaluationTimestampMs !== "number" ||
      !Number.isSafeInteger(paperCtx.originalEvaluationTimestampMs) ||
      paperCtx.originalEvaluationTimestampMs <= 0 ||
      typeof paperCtx.qualificationReason !== "string" ||
      paperCtx.qualificationReason.trim().length === 0 ||
      !Array.isArray(paperCtx.providerAssumptions) ||
      !Array.isArray(paperCtx.unresolvedUncertainties)
    ) {
      return fallback("INVALID_PAPER_QUALIFICATION_PROVENANCE");
    }

    // Causality checks
    if (evaluationTimestampMs < paperCtx.researchWindowSpan.windowEndMs) {
      return fallback(
        `FUTURE_DATED_RECONCILIATION: Consumption timestamp (${evaluationTimestampMs} ms) is earlier than research cutoff (${paperCtx.researchWindowSpan.windowEndMs} ms)`,
      );
    }
    if (evaluationTimestampMs < paperCtx.originalEvaluationTimestampMs) {
      return fallback(
        `CAUSALITY_VIOLATION: Consumption timestamp (${evaluationTimestampMs} ms) is earlier than original evaluation (${paperCtx.originalEvaluationTimestampMs} ms)`,
      );
    }

    // Recalculate freshness from actual research cutoff at consumption time
    const currentCutoffAgeMs = evaluationTimestampMs - paperCtx.researchWindowSpan.windowEndMs;
    if (currentCutoffAgeMs > maxAllowedAgeMs) {
      return fallback(
        `STALE_RECONCILIATION_EVIDENCE: Research cutoff age (${currentCutoffAgeMs} ms) exceeds max allowed age (${maxAllowedAgeMs} ms)`,
        "STALE_DATA",
      );
    }

    // Accepted quiet-window adapter restricted to qualified-zero scope
    if (
      res.recentBuys60s !== 0 ||
      res.recentSells60s !== 0 ||
      res.isCoverageSufficient !== true ||
      res.flowCoverage !== "SUFFICIENT"
    ) {
      return fallback(
        "INVALID_PAPER_QUIET_STREAM_COUNTS: PAPER quiet stream must have verified zero counts and sufficient coverage",
      );
    }

    const diagReason =
      typeof res.diagnosticReason === "string" && res.diagnosticReason.trim().length > 0
        ? res.diagnosticReason
        : "PAPER quiet window qualified";

    const frozenSpan = Object.freeze({
      windowStartMs: paperCtx.researchWindowSpan.windowStartMs,
      windowEndMs: paperCtx.researchWindowSpan.windowEndMs,
      cutoffAgeMs: currentCutoffAgeMs,
    });
    const frozenAssumptions = Object.freeze(paperCtx.providerAssumptions.slice());
    const frozenUncertainties = Object.freeze(paperCtx.unresolvedUncertainties.slice());
    const frozenPaperCtx: PaperQualificationContext = Object.freeze({
      executionContext: paperCtx.executionContext,
      validatedEpoch: paperCtx.validatedEpoch,
      originalEvaluationTimestampMs: paperCtx.originalEvaluationTimestampMs,
      researchWindowSpan: frozenSpan,
      cutoffAgeMs: currentCutoffAgeMs,
      qualificationReason: paperCtx.qualificationReason,
      providerAssumptions: frozenAssumptions,
      unresolvedUncertainties: frozenUncertainties,
    });

    return Object.freeze({
      poolAddress: target.poolAddress,
      tokenMint: target.tokenMint,
      recentBuys60s: 0,
      recentSells60s: 0,
      flowCoverage: "SUFFICIENT",
      isCoverageSufficient: true,
      diagnosticReason: diagReason,
      evaluationTimestampMs,
      isPaperQualified: true,
      paperQualificationContext: frozenPaperCtx,
      windowStartMs: frozenSpan.windowStartMs,
      windowEndMs: frozenSpan.windowEndMs,
      connectionEpoch: frozenPaperCtx.validatedEpoch,
    });
  }

  // 5. Consistent sufficient-coverage fields
  const isSufficient = res.isCoverageSufficient === true;
  const flowCoverage = res.flowCoverage;

  if (isSufficient && flowCoverage !== "SUFFICIENT") {
    return fallback(
      `INCONSISTENT_COVERAGE_FIELDS: isCoverageSufficient is true but flowCoverage is '${String(flowCoverage)}'`,
    );
  }
  if (!isSufficient && flowCoverage === "SUFFICIENT") {
    return fallback(
      `INCONSISTENT_COVERAGE_FIELDS: flowCoverage is 'SUFFICIENT' but isCoverageSufficient is false`,
    );
  }

  // 6. Valid, nonnegative safe-integer counts when coverage is sufficient
  if (isSufficient) {
    const buys = res.recentBuys60s;
    const sells = res.recentSells60s;

    if (
      typeof buys !== "number" ||
      !Number.isSafeInteger(buys) ||
      buys < 0 ||
      typeof sells !== "number" ||
      !Number.isSafeInteger(sells) ||
      sells < 0
    ) {
      return fallback(
        `INVALID_FLOW_COUNTS: sufficient coverage requires nonnegative safe-integer counts, received buys=${String(buys)}, sells=${String(sells)}`,
      );
    }

    const diagReason =
      typeof res.diagnosticReason === "string" && res.diagnosticReason.trim().length > 0
        ? res.diagnosticReason
        : "Coverage is sufficient";

    // Validate ordinary flow interval metadata if any interval field is supplied
    const hasIntervalMetadata =
      res.windowStartMs !== undefined ||
      res.windowEndMs !== undefined ||
      res.connectionEpoch !== undefined;

    const extraFields: {
      windowStartMs?: number;
      windowEndMs?: number;
      connectionEpoch?: number;
    } = {};

    if (hasIntervalMetadata) {
      // 1. All three fields must be supplied together (complete tuple)
      if (
        res.windowStartMs === undefined ||
        res.windowEndMs === undefined ||
        res.connectionEpoch === undefined
      ) {
        return fallback(
          "PARTIAL_FLOW_INTERVAL_METADATA: windowStartMs, windowEndMs, and connectionEpoch must all be defined when interval metadata is supplied",
        );
      }

      // 2. Types and safe-integer boundaries
      const startMs = res.windowStartMs;
      const endMs = res.windowEndMs;
      const epoch = res.connectionEpoch;

      if (
        typeof startMs !== "number" ||
        typeof endMs !== "number" ||
        typeof epoch !== "number" ||
        !Number.isSafeInteger(startMs) ||
        !Number.isSafeInteger(endMs) ||
        !Number.isSafeInteger(epoch) ||
        startMs <= 0 ||
        endMs <= 0 ||
        epoch < 0
      ) {
        return fallback(
          `MALFORMED_FLOW_INTERVAL_METADATA: timestamps must be positive safe integers and epoch must be non-negative safe integer, received windowStartMs=${String(startMs)}, windowEndMs=${String(endMs)}, connectionEpoch=${String(epoch)}`,
        );
      }

      // 3. Exactly 60,000 ms duration for 60-second counts
      if (endMs - startMs !== 60_000) {
        return fallback(
          `INVALID_FLOW_INTERVAL_DURATION: 60-second flow interval must span exactly 60000 ms, received ${endMs - startMs} ms`,
        );
      }

      // 4. Causality check: windowEndMs <= evaluationTimestampMs
      if (endMs > evaluationTimestampMs) {
        return fallback(
          `FUTURE_DATED_FLOW_INTERVAL: windowEndMs (${endMs} ms) exceeds consumption timestamp (${evaluationTimestampMs} ms)`,
        );
      }

      // 5. Freshness check: cutoff age <= maxAllowedAgeMs (never exceeding 15,000 ms)
      const cutoffAgeMs = evaluationTimestampMs - endMs;
      if (cutoffAgeMs > maxAllowedAgeMs) {
        return fallback(
          `STALE_FLOW_INTERVAL_EVIDENCE: interval cutoff age (${cutoffAgeMs} ms) exceeds max allowed age (${maxAllowedAgeMs} ms)`,
          "STALE_DATA",
        );
      }

      extraFields.windowStartMs = startMs;
      extraFields.windowEndMs = endMs;
      extraFields.connectionEpoch = epoch;
    }

    return Object.freeze({
      poolAddress: target.poolAddress,
      tokenMint: target.tokenMint,
      recentBuys60s: buys,
      recentSells60s: sells,
      flowCoverage: "SUFFICIENT",
      isCoverageSufficient: true,
      diagnosticReason: diagReason,
      evaluationTimestampMs,
      ...extraFields,
    });
  }

  // 7. When coverage is not sufficient, counts must be null (never substitute estimates or leave stale counts)
  const coverageStatus: FlowCoverageStatus | "UNAVAILABLE" =
    typeof flowCoverage === "string" && flowCoverage !== "SUFFICIENT"
      ? (flowCoverage as FlowCoverageStatus | "UNAVAILABLE")
      : "COLLECTION_GAP";

  const diagReason =
    typeof res.diagnosticReason === "string" && res.diagnosticReason.trim().length > 0
      ? res.diagnosticReason
      : "INSUFFICIENT_FLOW_COVERAGE";

  return Object.freeze({
    poolAddress: target.poolAddress,
    tokenMint: target.tokenMint,
    recentBuys60s: null,
    recentSells60s: null,
    flowCoverage: coverageStatus,
    isCoverageSufficient: false,
    diagnosticReason: diagReason,
    evaluationTimestampMs,
  });
}

/**
 * Builds a RetestSpotInfo structure using base spot metrics overlaid with verified flow.
 */
export function buildRetestSpotInfo(
  baseSpot: {
    readonly spotPriceSol: number;
    readonly spotPriceUsd?: number | null | undefined;
    readonly liquidityUsd?: number | null | undefined;
  },
  flowResult: CandidateFlowResult,
): RetestSpotInfo {
  return {
    spotPriceSol: baseSpot.spotPriceSol,
    spotPriceUsd: baseSpot.spotPriceUsd,
    liquidityUsd: baseSpot.liquidityUsd,
    recentBuys60s: flowResult.recentBuys60s,
    recentSells60s: flowResult.recentSells60s,
    flowCoverage: flowResult.flowCoverage,
  };
}

/**
 * Parameters for evaluating both candidate decision points (Buy Gate and Retest Gate).
 */
export interface EvaluateCandidateDecisionParams {
  readonly candidate: WatchlistCandidateItem;
  readonly baseSpotInfo: {
    readonly spotPriceSol: number;
    readonly spotPriceUsd?: number | null | undefined;
    readonly liquidityUsd?: number | null | undefined;
    readonly momentum5mBps?: number | undefined;
    readonly priceChange1hPct?: number | undefined;
  };
  readonly rugMetrics?:
    | {
        readonly rugScore?: number | undefined;
        readonly hasDangerRisk?: boolean | undefined;
        readonly bundlerPct?: number | undefined;
        readonly top10HolderPct?: number | undefined;
        readonly holdersCount?: number | undefined;
      }
    | null
    | undefined;
  readonly flowProvider?: CandidateFlowProvider | undefined;
  readonly existingArmedState?: ArmedPullbackState | undefined;
  readonly currentNowMs: number;
  readonly buyGateService?: BuyGateTriggerService | undefined;
  readonly requireVerifiedHolders?: boolean | undefined;
  readonly executionContext?: "PRODUCTION" | "PAPER_SIMULATION" | "BACKTEST" | undefined;
}

/**
 * Structured outcome of the candidate evaluation helper.
 */
export type CandidateDecisionResult =
  | {
      readonly outcome: "INSUFFICIENT_LIVE_LIQUIDITY";
      readonly flowResult: CandidateFlowResult;
      readonly retestSpotInfo: RetestSpotInfo;
      readonly isLiveLiquiditySufficient: false;
      readonly isEstablished: boolean;
      readonly isViral: boolean;
      readonly requiredLiveLiq: number;
      readonly liveLiqUsd: number;
      readonly buyGateResult: BuyGateEvaluationResult;
      readonly retestResult?: undefined;
      readonly rejectionReason: "REJECTED_INSUFFICIENT_LIVE_LIQUIDITY";
    }
  | {
      readonly outcome: "BUY_GATE_REJECTED";
      readonly flowResult: CandidateFlowResult;
      readonly retestSpotInfo: RetestSpotInfo;
      readonly isLiveLiquiditySufficient: true;
      readonly isEstablished: boolean;
      readonly isViral: boolean;
      readonly requiredLiveLiq: number;
      readonly liveLiqUsd: number;
      readonly buyGateResult: BuyGateEvaluationResult;
      readonly retestResult?: undefined;
      readonly rejectionReason: string;
    }
  | {
      readonly outcome: "ARMED_FIRST_TICK";
      readonly flowResult: CandidateFlowResult;
      readonly retestSpotInfo: RetestSpotInfo;
      readonly isLiveLiquiditySufficient: true;
      readonly isEstablished: boolean;
      readonly isViral: boolean;
      readonly requiredLiveLiq: number;
      readonly liveLiqUsd: number;
      readonly buyGateResult: BuyGateEvaluationResult;
      readonly retestResult: Extract<RetestGateResult, { status: "ARMED_FIRST_TICK" }>;
      readonly rejectionReason?: undefined;
    }
  | {
      readonly outcome: "RETEST_WAITING";
      readonly flowResult: CandidateFlowResult;
      readonly retestSpotInfo: RetestSpotInfo;
      readonly isLiveLiquiditySufficient: true;
      readonly isEstablished: boolean;
      readonly isViral: boolean;
      readonly requiredLiveLiq: number;
      readonly liveLiqUsd: number;
      readonly buyGateResult: BuyGateEvaluationResult;
      readonly retestResult: Extract<RetestGateResult, { status: "WAITING" }>;
      readonly rejectionReason?: undefined;
    }
  | {
      readonly outcome: "RETEST_REJECTED";
      readonly flowResult: CandidateFlowResult;
      readonly retestSpotInfo: RetestSpotInfo;
      readonly isLiveLiquiditySufficient: true;
      readonly isEstablished: boolean;
      readonly isViral: boolean;
      readonly requiredLiveLiq: number;
      readonly liveLiqUsd: number;
      readonly buyGateResult: BuyGateEvaluationResult;
      readonly retestResult: Extract<RetestGateResult, { status: "REJECTED" }>;
      readonly rejectionReason: string;
    }
  | {
      readonly outcome: "RETEST_CONFIRMED";
      readonly flowResult: CandidateFlowResult;
      readonly retestSpotInfo: RetestSpotInfo;
      readonly isLiveLiquiditySufficient: true;
      readonly isEstablished: boolean;
      readonly isViral: boolean;
      readonly requiredLiveLiq: number;
      readonly liveLiqUsd: number;
      readonly buyGateResult: BuyGateEvaluationResult;
      readonly retestResult: Extract<RetestGateResult, { status: "CONFIRMED" }>;
      readonly rejectionReason?: undefined;
    };

/**
 * Evaluates candidate decision points (Buy Gate and Retest Gate) using a candidate-bound flow provider.
 * Pure function: side-effects (state mutations, logging, alerts) remain in the caller.
 */
export function evaluateCandidateDecisionPoints(
  params: EvaluateCandidateDecisionParams,
): CandidateDecisionResult {
  const { candidate, baseSpotInfo, rugMetrics, existingArmedState, currentNowMs } = params;

  // 1. Resolve candidate-bound flow with boundary validation
  const target: CandidateFlowTarget = {
    poolAddress: candidate.poolId,
    tokenMint: candidate.mintAddress,
  };
  const provider = params.flowProvider ?? new UnavailableCandidateFlowProvider();
  let flowResult: CandidateFlowResult;
  try {
    const rawResult = provider.getCandidateFlow(target, currentNowMs);
    flowResult = validateAndSnapshotCandidateFlowResult(rawResult, target, currentNowMs, {
      executionContext: params.executionContext,
    });
  } catch (providerErr) {
    flowResult = Object.freeze({
      poolAddress: candidate.poolId,
      tokenMint: candidate.mintAddress,
      recentBuys60s: null,
      recentSells60s: null,
      flowCoverage: "COLLECTION_GAP",
      isCoverageSufficient: false,
      diagnosticReason: `PROVIDER_CALL_EXCEPTION: ${providerErr instanceof Error ? providerErr.message : String(providerErr)}`,
      evaluationTimestampMs: currentNowMs,
    });
  }

  // 2. Construct RetestSpotInfo with candidate-bound flow overlay
  const retestSpotInfo = buildRetestSpotInfo(baseSpotInfo, flowResult);

  // 3. Established Runner & Viral Runner classification (pre-extraction ordering)
  // Determine cohort eligibility strictly using candidate discovery metrics and verified holder count
  const isViral =
    candidate.liquidityUsd >= 30000 &&
    candidate.marketCapUsd >= 150000 &&
    candidate.assetAgeSeconds >= 900 &&
    candidate.assetAgeSeconds <= 7200;
  const isCandidateEstablished =
    ((candidate.liquidityUsd >= 50000 && candidate.assetAgeSeconds >= 1800) || isViral) &&
    candidate.assetAgeSeconds <= 7200 &&
    rugMetrics?.holdersCount !== undefined &&
    rugMetrics.holdersCount >= (isViral ? 1000 : 250);

  // 4. Live Spot Liquidity Floor Check
  const requiredLiveLiq = isCandidateEstablished ? (isViral ? 30000 : 50000) : 20000;
  const liveLiqUsd = baseSpotInfo.liquidityUsd ?? 0;
  if (liveLiqUsd < requiredLiveLiq) {
    return {
      flowResult,
      retestSpotInfo,
      isLiveLiquiditySufficient: false,
      isEstablished: isCandidateEstablished,
      isViral,
      requiredLiveLiq,
      liveLiqUsd,
      buyGateResult: {
        triggered: false,
        poolId: candidate.poolId,
        mintAddress: candidate.mintAddress,
        symbol: candidate.symbol,
        gates: [],
        rejectionReason: "REJECTED_INSUFFICIENT_LIVE_LIQUIDITY",
      },
      outcome: "INSUFFICIENT_LIVE_LIQUIDITY",
      rejectionReason: "REJECTED_INSUFFICIENT_LIVE_LIQUIDITY",
    };
  }

  // 5. Evaluate Candidate Buy Gate (Decision Point 1)
  const buyGate = params.buyGateService ?? new BuyGateTriggerService();
  const marketContext: AdvancedMarketContext = {
    recentBuysCount60s: flowResult.recentBuys60s,
    recentSellsCount60s: flowResult.recentSells60s,
    flowCoverage: flowResult.flowCoverage,
    requireValidFlowCoverage: true,
    momentum1mBps:
      baseSpotInfo.momentum5mBps !== undefined ? Math.round(baseSpotInfo.momentum5mBps / 5) : 0,
    bundlerPct: rugMetrics?.bundlerPct,
    top10HolderPct: rugMetrics?.top10HolderPct,
    holdersCount: rugMetrics?.holdersCount,
    rugScore: rugMetrics?.rugScore,
    hasDangerRisk: rugMetrics?.hasDangerRisk,
    priceChange1hPct: baseSpotInfo.priceChange1hPct ?? 0,
    requireVerifiedHolders: params.requireVerifiedHolders ?? true,
  };

  const buyGateResult = buyGate.evaluateCandidate(candidate, marketContext);
  if (!buyGateResult.triggered) {
    return {
      flowResult,
      retestSpotInfo,
      isLiveLiquiditySufficient: true,
      isEstablished: isCandidateEstablished,
      isViral,
      requiredLiveLiq,
      liveLiqUsd,
      buyGateResult,
      outcome: "BUY_GATE_REJECTED",
      rejectionReason: buyGateResult.rejectionReason ?? "REJECTED_BUY_GATE_UNTRIGGERED",
    };
  }

  // 6. Evaluate Retest Gate (Decision Point 2)
  const retestResult = evaluateRetestGate({
    mintAddress: candidate.mintAddress,
    isEstablished: isCandidateEstablished,
    currentNowMs,
    spotInfo: retestSpotInfo,
    existingArmedState,
  });

  switch (retestResult.status) {
    case "ARMED_FIRST_TICK":
      return {
        flowResult,
        retestSpotInfo,
        isLiveLiquiditySufficient: true,
        isEstablished: isCandidateEstablished,
        isViral,
        requiredLiveLiq,
        liveLiqUsd,
        buyGateResult,
        retestResult,
        outcome: "ARMED_FIRST_TICK",
      };
    case "WAITING":
      return {
        flowResult,
        retestSpotInfo,
        isLiveLiquiditySufficient: true,
        isEstablished: isCandidateEstablished,
        isViral,
        requiredLiveLiq,
        liveLiqUsd,
        buyGateResult,
        retestResult,
        outcome: "RETEST_WAITING",
      };
    case "REJECTED":
      return {
        flowResult,
        retestSpotInfo,
        isLiveLiquiditySufficient: true,
        isEstablished: isCandidateEstablished,
        isViral,
        requiredLiveLiq,
        liveLiqUsd,
        buyGateResult,
        retestResult,
        outcome: "RETEST_REJECTED",
        rejectionReason: retestResult.rejectReason,
      };
    case "CONFIRMED":
      return {
        flowResult,
        retestSpotInfo,
        isLiveLiquiditySufficient: true,
        isEstablished: isCandidateEstablished,
        isViral,
        requiredLiveLiq,
        liveLiqUsd,
        buyGateResult,
        retestResult,
        outcome: "RETEST_CONFIRMED",
      };
  }
}
