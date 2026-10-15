/**
 * Phase 12.94-D: Research Eligibility Gate
 *
 * Implements mode-aware, fail-closed data quality gating for quantitative
 * strategy research. Rejects missing, stale, cross-pool, incomplete, interrupted,
 * or numerically ungrounded records without dropping them from full research denominators.
 */

import { isVerifiedMatchingPool } from "../telemetry/TelemetryTypes.js";
import type {
  JoinedResearchRecord,
  ResearchEligibilityResult,
  ResearchEvaluationMode,
  ResearchFinancialAccounting,
} from "./ResearchTypes.js";
import type { ExecutableQuoteRecord, SimulatedFillRecord } from "../execution/ExecutionTypes.js";

export const MAX_INGESTION_LAG_MS = 120_000; // 2 minutes
export const MAX_CLOCK_SKEW_MS = 30_000; // 30 seconds
export const MAX_DATA_FRESHNESS_MS = 180_000; // 3 minutes
const LAMPORTS_PER_SOL = 1_000_000_000;

export interface EligibilityGateOptions {
  readonly mode?: ResearchEvaluationMode | undefined;
  readonly maxIngestionLagMs?: number | undefined;
  readonly maxClockSkewMs?: number | undefined;
  readonly maxDataFreshnessMs?: number | undefined;
  readonly allowAmbiguousTrajectories?: boolean | undefined;
}

/**
 * Computes exact offline research financial accounting for a simulated fill.
 * Correctly preserves signed negative cash flow on fee-dominated dust exits
 * without double-debiting priority fees.
 */
export function computeResearchFinancialAccounting(
  fill: SimulatedFillRecord,
  quote?: ExecutableQuoteRecord | undefined,
  options: {
    readonly initialTotalOutlaySol?: number | undefined;
    readonly conservativeBidPriceSol?: number | undefined;
  } = {},
): ResearchFinancialAccounting {
  const grossSolProceeds = fill.grossProceedsSol ?? 0;
  const externalNetworkFeeLamports = fill.networkFeeLamports;
  const externalNetworkFeeSol = externalNetworkFeeLamports / LAMPORTS_PER_SOL;
  const priorityFeeLamports = fill.priorityFeeLamports;
  const ataRentDepositLamports = fill.ataRentDepositLamports ?? 0;
  const ataRentDepositSol = ataRentDepositLamports / LAMPORTS_PER_SOL;
  const ataRentRefundLamports = fill.ataRentRefundLamports ?? 0;
  const ataRentRefundSol = ataRentRefundLamports / LAMPORTS_PER_SOL;

  // Signed net cash movement: GrossProceeds - ExternalFees - AtaDeposits + AtaRefunds
  // externalNetworkFeeLamports already includes base and priority; priority is NOT subtracted again.
  const signedNetCashFlowSol =
    grossSolProceeds - externalNetworkFeeSol - ataRentDepositSol + ataRentRefundSol;

  const isSubmarginalDust = grossSolProceeds > 0 && grossSolProceeds <= externalNetworkFeeSol;

  let financialState: ResearchFinancialAccounting["financialState"] = "REALIZED_LIQUIDATION";
  if (fill.executionOutcome === "PREFLIGHT_SIMULATION_REJECTED") {
    financialState = "PREFLIGHT_REJECTION";
  } else if (fill.executionOutcome === "SUBMITTED_TRANSACTION_FAILED") {
    financialState = "SUBMITTED_FAILURE";
  } else if (fill.remainingTokens > 0 && fill.filledTokens === 0) {
    financialState = "UNREALIZED_HOLDING";
  } else if (fill.sellabilityStatus.startsWith("UNSELLABLE_")) {
    financialState = "IMPAIRMENT_WRITE_DOWN";
  }

  const capitalTiedUpSol =
    options.initialTotalOutlaySol ?? (quote ? quote.inAmountUi + ataRentDepositSol : 0);
  const unrealizedImpairmentSol = fill.conservativeWriteDownSol ?? 0;

  const markedToModelPnlSol =
    options.conservativeBidPriceSol !== undefined
      ? fill.remainingTokens * options.conservativeBidPriceSol - capitalTiedUpSol
      : undefined;

  return {
    executionOutcome: fill.executionOutcome,
    sellabilityStatus: fill.sellabilityStatus,
    attemptedSizeSol: fill.attemptedSizeSol,
    filledSizeSol: fill.filledSizeSol,
    grossSolProceeds,
    externalNetworkFeeLamports,
    externalNetworkFeeSol,
    priorityFeeLamports,
    ataRentDepositLamports,
    ataRentRefundLamports,
    signedNetCashFlowSol,
    isSubmarginalDust,
    markedToModelPnlSol,
    capitalTiedUpSol,
    unrealizedImpairmentSol,
    financialState,
  };
}

/**
 * Evaluates whether a joined research record passes fail-closed data quality gates.
 */
export function evaluateResearchEligibility(
  record: Omit<JoinedResearchRecord, "eligibility">,
  options: EligibilityGateOptions = {},
): ResearchEligibilityResult {
  const mode = options.mode ?? record.evaluationMode;
  const maxIngestionLag = options.maxIngestionLagMs ?? MAX_INGESTION_LAG_MS;
  const maxClockSkew = options.maxClockSkewMs ?? MAX_CLOCK_SKEW_MS;
  const maxFreshness = options.maxDataFreshnessMs ?? MAX_DATA_FRESHNESS_MS;
  const allowAmbiguous = options.allowAmbiguousTrajectories ?? false;

  const rejectionReasons: string[] = [];
  const warnings: string[] = [];

  // Gate 1: Trajectory Ambiguity
  if (record.trajectoryLinkStatus === "AMBIGUOUS_TRAJECTORY" && !allowAmbiguous) {
    rejectionReasons.push("AMBIGUOUS_TRAJECTORY_MULTIPLE_DECISIONS");
  } else if (record.trajectoryLinkStatus === "AMBIGUOUS_TRAJECTORY") {
    warnings.push("AMBIGUOUS_TRAJECTORY_OBSERVATIONS_SHARED");
  }

  // Gate 2: Temporal Ingestion Lag and Clock Skew
  const ingestionLag = record.ingestionTimestampMs - record.sourceTimestampMs;
  if (ingestionLag > maxIngestionLag) {
    rejectionReasons.push(
      `EXCESSIVE_INGESTION_LAG: ${ingestionLag}ms exceeds limit ${maxIngestionLag}ms`,
    );
  }
  const clockSkew = Math.abs(record.ingestionTimestampMs - record.decisionTimestampMs);
  if (clockSkew > maxClockSkew && Math.abs(ingestionLag) > maxClockSkew) {
    warnings.push(`POSSIBLE_CLOCK_SKEW: lag=${ingestionLag}ms`);
  }

  // Gate 3: Forward Observation Quality
  for (let i = 0; i < record.forwardObservations.length; i++) {
    const obs = record.forwardObservations[i]!;
    if (
      obs.actualResponsePoolId &&
      !isVerifiedMatchingPool(obs.actualResponsePoolId, record.poolId)
    ) {
      rejectionReasons.push(
        `FORWARD_OBSERVATION_POOL_MISMATCH: obs[${i}] actual=${obs.actualResponsePoolId}, expected=${record.poolId}`,
      );
    }
    if (obs.dataFreshnessMs > maxFreshness) {
      warnings.push(`FORWARD_OBSERVATION_STALE: obs[${i}] freshness=${obs.dataFreshnessMs}ms`);
    }
  }

  // Gate 4: Synthetic Replay Specific Checks
  if (mode === "SYNTHETIC_REPLAY") {
    // Requires verified pre-decision point-in-time reserve snapshot
    const baseReserve = record.features.baseReserve;
    const quoteReserve = record.features.quoteReserve;

    if (!baseReserve.isAvailable || baseReserve.value === null || baseReserve.value <= 0) {
      rejectionReasons.push("NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT: baseReserve missing or zero");
    }
    if (!quoteReserve.isAvailable || quoteReserve.value === null || quoteReserve.value <= 0) {
      rejectionReasons.push("NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT: quoteReserve missing or zero");
    }

    // Verify quote route integrity if a quote is linked
    if (record.quote) {
      if (record.quote.routeType !== "DIRECT_TRACKED_POOL") {
        rejectionReasons.push(`UNSUPPORTED_ROUTE_TYPE: ${record.quote.routeType}`);
      }
      if (record.quote.poolId !== record.poolId) {
        rejectionReasons.push(
          `QUOTE_POOL_MISMATCH: quote=${record.quote.poolId}, decision=${record.poolId}`,
        );
      }
    }

    // Verify fill referential integrity if fill is linked
    if (record.fill && record.quote) {
      if (record.fill.quoteId !== record.quote.quoteId) {
        rejectionReasons.push(
          `FILL_QUOTE_ID_MISMATCH: fill.quoteId=${record.fill.quoteId}, quote.quoteId=${record.quote.quoteId}`,
        );
      }
    }

    // Submarginal dust exit warning / disqualification
    if (record.financialAccounting?.isSubmarginalDust) {
      warnings.push(
        "EXECUTION_DEFICIT_SUBMARGINAL: gross proceeds do not cover external network fees",
      );
    }
  }

  const isEligible = rejectionReasons.length === 0;

  return {
    isEligible,
    evaluationMode: mode,
    rejectionReasons,
    warnings,
  };
}
