/**
 * Phase 12.94-D: Research Eligibility Gate
 *
 * Implements mode-aware, fail-closed data quality gating for quantitative
 * strategy research. Rejects missing, stale, cross-pool, incomplete, interrupted,
 * or numerically ungrounded records without dropping them from full research denominators.
 */

import {
  isVerifiedMatchingPool,
  type SessionTelemetryMeta,
  type SessionTelemetrySummary,
} from "../telemetry/TelemetryTypes.js";
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
  readonly allowUnfinalizedSession?: boolean | undefined;
  readonly sessionMeta?: SessionTelemetryMeta | undefined;
  readonly sessionSummary?: SessionTelemetrySummary | undefined;
}

/**
 * Determines session finalization status from authoritative 12.94-B metadata and summary.
 */
export function determineSessionStatus(
  meta?: SessionTelemetryMeta | null,
  summary?: SessionTelemetrySummary | null,
): "FINALIZED" | "INTERRUPTED" | "UNFINALIZED" {
  // Check for affirmative interruption signals in either record
  const isInterrupted =
    Boolean(meta?.isInterruptedSession) ||
    meta?.sessionStatus === "INTERRUPTED" ||
    Boolean(meta?.resumedFromPriorCrash) ||
    Boolean((meta as unknown as { interruptedReason?: string })?.interruptedReason) ||
    Boolean(summary?.isInterruptedSession) ||
    summary?.isCompleteSession === false;

  if (isInterrupted) {
    return "INTERRUPTED";
  }

  // Both metadata and summary must be present for an authoritative finalized session
  if (!meta || !summary) {
    return "UNFINALIZED";
  }

  // Cross-file identity consistency checks
  if (meta.sessionId !== summary.sessionId) return "UNFINALIZED";
  if (meta.generationId !== summary.generationId) return "UNFINALIZED";
  if (
    meta.strategyRevision &&
    summary.strategyRevision &&
    meta.strategyRevision !== summary.strategyRevision
  ) {
    return "UNFINALIZED";
  }
  if (meta.startedAtIso && summary.startedAtIso && meta.startedAtIso !== summary.startedAtIso) {
    return "UNFINALIZED";
  }
  if (meta.closedAtIso && summary.closedAtIso && meta.closedAtIso !== summary.closedAtIso) {
    return "UNFINALIZED";
  }

  // Affirmative finalization requirements:
  // 1. meta must authoritatively state FINALIZED and non-interrupted
  // 2. summary must state complete session and have populated closedAtIso
  const isMetaFinalized = meta.sessionStatus === "FINALIZED" && meta.isInterruptedSession === false;
  const isSummaryComplete =
    summary.isCompleteSession === true &&
    summary.isInterruptedSession === false &&
    typeof summary.closedAtIso === "string" &&
    summary.closedAtIso.trim().length > 0;

  if (isMetaFinalized && isSummaryComplete) {
    return "FINALIZED";
  }

  // Any non-finalized or contradictory pair fails closed as UNFINALIZED
  return "UNFINALIZED";
}

/**
 * Computes exact offline research financial accounting for a simulated fill.
 * Distinguishes BUY inventory acquisitions from SELL liquidations,
 * tracks authoritative atomic lamport balance changes, and avoids double-debiting priority fees.
 */
export function computeResearchFinancialAccounting(
  fill: SimulatedFillRecord,
  quote?: ExecutableQuoteRecord | undefined,
  options: {
    readonly initialTotalOutlaySol?: number | undefined;
    readonly conservativeBidPriceSol?: number | undefined;
  } = {},
): ResearchFinancialAccounting {
  const isBuy = fill.side === "BUY";
  const externalNetworkFeeLamports = fill.networkFeeLamports;
  const externalNetworkFeeSol = externalNetworkFeeLamports / LAMPORTS_PER_SOL;
  const priorityFeeLamports = fill.priorityFeeLamports;
  const ataRentDepositLamports = fill.ataRentDepositLamports ?? 0;
  const ataRentRefundLamports = fill.ataRentRefundLamports ?? 0;

  if (isBuy) {
    // BUY Cash Accounting
    const outlaySol =
      fill.filledSizeSol > 0
        ? fill.filledSizeSol
        : quote
          ? quote.inAmountUi
          : fill.attemptedSizeSol;
    const buyOutlayLamports = BigInt(Math.round(outlaySol * LAMPORTS_PER_SOL));
    const netFeeLamports = BigInt(externalNetworkFeeLamports);
    const ataDepositLamports = BigInt(ataRentDepositLamports);
    const ataRefundLamports = BigInt(ataRentRefundLamports);

    let signedNetCashFlowLamports = 0n;
    let signedNetCashFlowSol = 0;
    let financialState: ResearchFinancialAccounting["financialState"] = "OPEN_POSITION";

    if (fill.executionOutcome === "PREFLIGHT_SIMULATION_REJECTED") {
      financialState = "PREFLIGHT_REJECTION";
      // Simulation rejection does not broadcast to cluster; zero gas debited
      signedNetCashFlowLamports = 0n;
      signedNetCashFlowSol = 0;
    } else if (fill.executionOutcome === "SUBMITTED_TRANSACTION_FAILED") {
      financialState = "SUBMITTED_FAILURE";
      // On-chain failure: debits external fees and ATA deposit
      signedNetCashFlowLamports = -netFeeLamports - ataDepositLamports + ataRefundLamports;
      signedNetCashFlowSol = Number(signedNetCashFlowLamports) / LAMPORTS_PER_SOL;
    } else {
      financialState =
        fill.filledTokens > 0 || fill.remainingTokens > 0 ? "OPEN_POSITION" : "PREFLIGHT_REJECTION";
      // Authoritative signed cash movement: -BuyOutlay - Fees - ATADeposit + ATARefund
      signedNetCashFlowLamports =
        -buyOutlayLamports - netFeeLamports - ataDepositLamports + ataRefundLamports;
      signedNetCashFlowSol = Number(signedNetCashFlowLamports) / LAMPORTS_PER_SOL;
    }

    const capitalTiedUpSol =
      outlaySol + (Number(ataDepositLamports) - Number(ataRefundLamports)) / LAMPORTS_PER_SOL;
    const unrealizedImpairmentSol = fill.conservativeWriteDownSol ?? 0;

    return {
      side: "BUY",
      executionOutcome: fill.executionOutcome,
      sellabilityStatus: fill.sellabilityStatus,
      attemptedSizeSol: fill.attemptedSizeSol,
      filledSizeSol: fill.filledSizeSol,
      grossSolProceeds: 0,
      externalNetworkFeeLamports,
      externalNetworkFeeSol,
      priorityFeeLamports,
      ataRentDepositLamports,
      ataRentRefundLamports,
      signedNetCashFlowLamports,
      signedNetCashFlowSol,
      isSubmarginalDust: false,
      capitalTiedUpSol,
      unrealizedImpairmentSol,
      financialState,
    };
  }

  // SELL Cash Accounting
  const grossSolProceeds = fill.grossProceedsSol ?? 0;
  const grossProceedsLamports = BigInt(Math.round(grossSolProceeds * LAMPORTS_PER_SOL));
  const netFeeLamports = BigInt(externalNetworkFeeLamports);
  const ataDepositLamports = BigInt(ataRentDepositLamports);
  const ataRefundLamports = BigInt(ataRentRefundLamports);

  let signedNetCashFlowLamports = 0n;
  let signedNetCashFlowSol = 0;
  let financialState: ResearchFinancialAccounting["financialState"] = "REALIZED_LIQUIDATION";

  if (fill.executionOutcome === "PREFLIGHT_SIMULATION_REJECTED") {
    financialState = "PREFLIGHT_REJECTION";
    signedNetCashFlowLamports = 0n;
    signedNetCashFlowSol = 0;
  } else if (fill.executionOutcome === "SUBMITTED_TRANSACTION_FAILED") {
    financialState = "SUBMITTED_FAILURE";
    signedNetCashFlowLamports = -netFeeLamports - ataDepositLamports + ataRefundLamports;
    signedNetCashFlowSol = Number(signedNetCashFlowLamports) / LAMPORTS_PER_SOL;
  } else if (fill.remainingTokens > 0 && fill.filledTokens === 0) {
    financialState = "UNREALIZED_HOLDING";
    signedNetCashFlowLamports =
      grossProceedsLamports - netFeeLamports - ataDepositLamports + ataRefundLamports;
    signedNetCashFlowSol = Number(signedNetCashFlowLamports) / LAMPORTS_PER_SOL;
  } else if (fill.sellabilityStatus.startsWith("UNSELLABLE_")) {
    financialState = "IMPAIRMENT_WRITE_DOWN";
    signedNetCashFlowLamports =
      grossProceedsLamports - netFeeLamports - ataDepositLamports + ataRefundLamports;
    signedNetCashFlowSol = Number(signedNetCashFlowLamports) / LAMPORTS_PER_SOL;
  } else {
    financialState = "REALIZED_LIQUIDATION";
    signedNetCashFlowLamports =
      grossProceedsLamports - netFeeLamports - ataDepositLamports + ataRefundLamports;
    signedNetCashFlowSol = Number(signedNetCashFlowLamports) / LAMPORTS_PER_SOL;
  }

  const isSubmarginalDust = grossSolProceeds > 0 && grossSolProceeds <= externalNetworkFeeSol;

  // Capital tied up for SELL MUST come from linked buy outlay, NEVER token units!
  const capitalTiedUpSol = options.initialTotalOutlaySol ?? undefined;
  const unrealizedImpairmentSol = fill.conservativeWriteDownSol ?? 0;

  const markedToModelPnlSol =
    options.conservativeBidPriceSol !== undefined && capitalTiedUpSol !== undefined
      ? fill.remainingTokens * options.conservativeBidPriceSol + grossSolProceeds - capitalTiedUpSol
      : undefined;

  return {
    side: "SELL",
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
    signedNetCashFlowLamports,
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

  // Gate 1: Duplicate Identity Quarantine
  if (record.isDuplicateQuarantined) {
    rejectionReasons.push(
      "DUPLICATE_IDENTITY_QUARANTINED: composite key collision detected in quotes, fills, or sampling records",
    );
  }

  // Gate 2: Session Finalization Check
  const effectiveSessionStatus =
    record.sessionStatus ??
    (options.sessionMeta && options.sessionSummary
      ? determineSessionStatus(options.sessionMeta, options.sessionSummary)
      : "UNFINALIZED");

  if (effectiveSessionStatus !== "FINALIZED") {
    if (options.allowUnfinalizedSession) {
      warnings.push(
        `OBSERVATIONAL_EXPLORATION_UNFINALIZED_SESSION: proceeding under exploratory override (status: ${effectiveSessionStatus})`,
      );
    } else {
      rejectionReasons.push(
        `SESSION_INTERRUPTED_OR_UNFINALIZED: session is ${effectiveSessionStatus}, lacks verified complete finalization`,
      );
    }
  }

  // Gate 3: Trajectory Link Status
  if (record.trajectoryLinkStatus === "AMBIGUOUS_TRAJECTORY") {
    if (allowAmbiguous) {
      warnings.push("AMBIGUOUS_TRAJECTORY_OBSERVATIONS_SHARED");
    } else {
      rejectionReasons.push(
        "AMBIGUOUS_TRAJECTORY_MULTIPLE_DECISIONS: multiple decisions share this pool without explicit link",
      );
    }
  } else if (record.trajectoryLinkStatus === "UNLINKED_ORPHAN") {
    rejectionReasons.push(
      "UNLINKED_ORPHAN_OBSERVATIONS: observations could not be causally attributed",
    );
  } else if (record.trajectoryLinkStatus === "UNIQUELY_INFERRED") {
    warnings.push(
      "TRAJECTORY_UNIQUELY_INFERRED: outcome linked by unique pool candidate without explicit initiating ID",
    );
  }

  // Gate 4: Mandatory Timestamps, Ingestion Lag, and Decision-Time Ordering
  const isFiniteNum = (val: unknown): val is number =>
    typeof val === "number" && Number.isFinite(val);

  if (
    !isFiniteNum(record.decisionTimestampMs) ||
    !isFiniteNum(record.sourceTimestampMs) ||
    !isFiniteNum(record.ingestionTimestampMs)
  ) {
    rejectionReasons.push(
      `INVALID_OR_NONFINITE_MANDATORY_TIMESTAMPS: decisionTimestampMs=${record.decisionTimestampMs}, sourceTimestampMs=${record.sourceTimestampMs}, ingestionTimestampMs=${record.ingestionTimestampMs}`,
    );
  } else {
    if (record.ingestionTimestampMs > record.decisionTimestampMs) {
      rejectionReasons.push(
        `DECISION_LOOKAHEAD_LEAKAGE: decision ingestion (${record.ingestionTimestampMs}) occurred after decision (${record.decisionTimestampMs})`,
      );
    }
    if (record.sourceTimestampMs > record.decisionTimestampMs) {
      rejectionReasons.push(
        `DECISION_LOOKAHEAD_LEAKAGE: decision source (${record.sourceTimestampMs}) occurred after decision (${record.decisionTimestampMs})`,
      );
    }

    const ingestionLag = record.ingestionTimestampMs - record.sourceTimestampMs;
    if (ingestionLag < 0) {
      rejectionReasons.push(
        `IMPOSSIBLE_TIMESTAMP_ORDERING: negative ingestion lag (${ingestionLag}ms)`,
      );
    } else if (ingestionLag > maxIngestionLag) {
      rejectionReasons.push(
        `EXCESSIVE_INGESTION_LAG: ${ingestionLag}ms exceeds limit ${maxIngestionLag}ms`,
      );
    }

    const clockSkew = Math.abs(record.ingestionTimestampMs - record.decisionTimestampMs);
    if (clockSkew > maxClockSkew && Math.abs(ingestionLag) > maxClockSkew) {
      warnings.push(`POSSIBLE_CLOCK_SKEW: lag=${ingestionLag}ms`);
    }
  }

  // Gate 5: Forward Observation Quality and Causality (Fail Closed on missing or mismatched pool ID and stale observations)
  for (let i = 0; i < record.forwardObservations.length; i++) {
    const obs = record.forwardObservations[i]!;

    if (!isFiniteNum(obs.sourceTimestampMs) || !isFiniteNum(obs.ingestionTimestampMs)) {
      rejectionReasons.push(
        `FORWARD_OBSERVATION_INVALID_TIMESTAMPS: obs[${i}] has nonfinite timestamp(s)`,
      );
    } else {
      if (obs.sourceTimestampMs > obs.ingestionTimestampMs) {
        rejectionReasons.push(
          `FORWARD_OBSERVATION_IMPOSSIBLE_TIMESTAMPS: obs[${i}] source (${obs.sourceTimestampMs}) > ingestion (${obs.ingestionTimestampMs})`,
        );
      }
      if (
        isFiniteNum(record.decisionTimestampMs) &&
        obs.sourceTimestampMs < record.decisionTimestampMs
      ) {
        rejectionReasons.push(
          `FORWARD_OBSERVATION_PRECEDES_DECISION: obs[${i}] source (${obs.sourceTimestampMs}) preceded decision (${record.decisionTimestampMs})`,
        );
      }
    }

    // Positive pool verification: missing OR mismatched pool ID fails closed!
    if (!isVerifiedMatchingPool(obs.actualResponsePoolId, record.poolId)) {
      rejectionReasons.push(
        `FORWARD_OBSERVATION_POOL_UNVERIFIED: obs[${i}] actual=${obs.actualResponsePoolId ?? "MISSING"}, expected=${record.poolId}`,
      );
    }

    if (
      obs.sessionId !== record.sessionId ||
      obs.generationId !== record.generationId ||
      obs.mintAddress !== record.mintAddress
    ) {
      rejectionReasons.push(
        `FORWARD_OBSERVATION_IDENTITY_MISMATCH: obs[${i}] session/gen/mint does not match record composite key`,
      );
    }

    if (obs.dataFreshnessMs > maxFreshness) {
      rejectionReasons.push(
        `FORWARD_OBSERVATION_STALE: obs[${i}] freshness=${obs.dataFreshnessMs}ms exceeds limit ${maxFreshness}ms`,
      );
    }
  }

  // Quote causality and identity verification (if quote is present)
  if (record.quote) {
    const q = record.quote;
    if (
      q.sessionId !== record.sessionId ||
      q.generationId !== record.generationId ||
      q.mintAddress !== record.mintAddress ||
      q.poolId !== record.poolId ||
      q.decisionEventId !== record.decisionEventId
    ) {
      rejectionReasons.push(
        `QUOTE_IDENTITY_MISMATCH: quote does not match decision composite identity`,
      );
    }
    if (q.routeType !== "DIRECT_TRACKED_POOL") {
      rejectionReasons.push(`UNSUPPORTED_ROUTE_TYPE: ${q.routeType}`);
    }

    if (!isFiniteNum(q.quoteInitiatedMs) || !isFiniteNum(q.quoteReceivedMs)) {
      rejectionReasons.push(
        `INVALID_OR_NONFINITE_QUOTE_TIMESTAMPS: quoteInitiatedMs=${q.quoteInitiatedMs}, quoteReceivedMs=${q.quoteReceivedMs}`,
      );
    } else {
      if (
        isFiniteNum(record.decisionTimestampMs) &&
        q.quoteInitiatedMs < record.decisionTimestampMs
      ) {
        rejectionReasons.push(
          `QUOTE_PRECEDES_DECISION: quote initiation (${q.quoteInitiatedMs}) preceded decision (${record.decisionTimestampMs})`,
        );
      }
      if (q.quoteReceivedMs < q.quoteInitiatedMs) {
        rejectionReasons.push(
          `QUOTE_CAUSAL_TIME_INVERSION: quote receipt (${q.quoteReceivedMs}) preceded quote initiation (${q.quoteInitiatedMs})`,
        );
      }
    }
  }

  // Fill causality and referential integrity (if fill is present)
  if (record.fill) {
    const f = record.fill;
    if (!isFiniteNum(f.fillTimestampMs)) {
      rejectionReasons.push(
        `INVALID_OR_NONFINITE_FILL_TIMESTAMP: fillTimestampMs=${f.fillTimestampMs}`,
      );
    }

    const extF = f as unknown as { sessionId?: string; generationId?: string };
    if (
      (extF.sessionId && extF.sessionId !== record.sessionId) ||
      (extF.generationId && extF.generationId !== record.generationId) ||
      f.mintAddress !== record.mintAddress ||
      f.poolId !== record.poolId ||
      f.decisionEventId !== record.decisionEventId
    ) {
      rejectionReasons.push(
        `FILL_IDENTITY_MISMATCH: fill does not match decision composite identity`,
      );
    }

    if (record.quote) {
      const q = record.quote;
      if (f.quoteId !== q.quoteId) {
        rejectionReasons.push(
          `FILL_QUOTE_ID_MISMATCH: fill.quoteId=${f.quoteId}, quote.quoteId=${q.quoteId}`,
        );
      }
      if (f.side !== q.side) {
        rejectionReasons.push(`FILL_SIDE_MISMATCH: fill.side=${f.side}, quote.side=${q.side}`);
      }

      // Fill causality against quote: must not precede initiation or receipt, and must not exceed validity
      if (
        isFiniteNum(f.fillTimestampMs) &&
        isFiniteNum(q.quoteInitiatedMs) &&
        f.fillTimestampMs < q.quoteInitiatedMs
      ) {
        rejectionReasons.push(
          `FILL_CAUSAL_TIME_INVERSION: fill timestamp ${f.fillTimestampMs} preceded quote initiation ${q.quoteInitiatedMs}`,
        );
      }
      if (
        isFiniteNum(f.fillTimestampMs) &&
        isFiniteNum(q.quoteReceivedMs) &&
        f.fillTimestampMs < q.quoteReceivedMs
      ) {
        rejectionReasons.push(
          `FILL_PRECEDED_QUOTE_RECEIPT: fill timestamp ${f.fillTimestampMs} preceded quote receipt ${q.quoteReceivedMs}`,
        );
      }
      if (
        isFiniteNum(f.fillTimestampMs) &&
        isFiniteNum(q.validUntilMs) &&
        f.fillTimestampMs > q.validUntilMs
      ) {
        rejectionReasons.push(
          `FILL_EXPIRED_QUOTE: fill timestamp ${f.fillTimestampMs} exceeded quote validity bound ${q.validUntilMs}`,
        );
      }
    }
  }

  // Gate 6: Synthetic Replay Specific Checks
  if (mode === "SYNTHETIC_REPLAY") {
    // Requires verified pre-decision point-in-time reserve snapshot
    const baseReserve = record.features.baseReserve;
    const quoteReserve = record.features.quoteReserve;

    if (!baseReserve.isAvailable || baseReserve.value === null || baseReserve.value <= 0) {
      rejectionReasons.push(
        "NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT: baseReserve missing, zero, or unverified",
      );
    }
    if (!quoteReserve.isAvailable || quoteReserve.value === null || quoteReserve.value <= 0) {
      rejectionReasons.push(
        "NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT: quoteReserve missing, zero, or unverified",
      );
    }

    // Explicitly require quote in synthetic replay
    if (!record.quote) {
      rejectionReasons.push(
        "SYNTHETIC_REPLAY_MISSING_QUOTE: synthetic replay requires an executable quote record",
      );
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
