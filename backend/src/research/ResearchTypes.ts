/**
 * Phase 12.94-D: Rigorous Quantitative Strategy Research Core Types & Contracts
 *
 * Implements provenance-bearing feature representations, event-specific causal
 * join contracts, observational-only vs. synthetic replay evaluation modes,
 * sampling inclusion metadata, and offline financial cash-flow accounting.
 */

import type {
  DecisionCohort,
  MarketObservationRecord,
  StratificationTier,
  StratifiedSamplingStatus,
} from "../telemetry/TelemetryTypes.js";
import type {
  ExecutableQuoteRecord,
  ExecutionOutcome,
  SellabilityStatus,
  SimulatedFillRecord,
} from "../execution/ExecutionTypes.js";

/**
 * High-level evaluation mode for quantitative strategy research.
 */
export type ResearchEvaluationMode = "OBSERVATIONAL_ONLY" | "SYNTHETIC_REPLAY";

/**
 * Provenance classification for research metrics.
 */
export type ProvenanceClass =
  | "OBSERVED"
  | "DERIVED"
  | "SYNTHETIC_REPLAY"
  | "PLACEHOLDER"
  | "UNAVAILABLE";

/**
 * Explicit reason code when a research feature or observation is unavailable.
 */
export type UnavailabilityReason =
  | "FIELD_NOT_COLLECTED_IN_GENERATION"
  | "PROVIDER_RESPONSE_OMITTED_FIELD"
  | "POOL_IDENTITY_MISMATCH_DISCARDED"
  | "STALE_SAMPLE_DISCARDED"
  | "RESERVE_QUANTITY_ZERO_OR_NONFINITE"
  | "NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT"
  | "LATE_RECEIPT_LOOKAHEAD_PREVENTION"
  | "IMPOSSIBLE_TIMESTAMP_ORDERING"
  | "DUPLICATE_IDENTITY_QUARANTINED"
  | "SESSION_INTERRUPTED_OR_UNFINALIZED"
  | "AMBIGUOUS_TRAJECTORY_MULTIPLE_DECISIONS";

/**
 * Provenance-bearing wrapper for numeric or categorical features.
 * Guarantees missing fields are never silently zero-imputed.
 */
export interface ProvenanceFeature<T = number> {
  readonly value: T | null;
  readonly provenance: ProvenanceClass;
  readonly isAvailable: boolean;
  readonly unavailabilityReason?: UnavailabilityReason | undefined;
  readonly sourceTimestampMs?: number | undefined;
  readonly receiptTimestampMs?: number | undefined;
}

/**
 * Trajectory attribution status for forward observations.
 */
export type TrajectoryLinkStatus =
  | "EXPLICIT_LINK"
  | "UNIQUELY_INFERRED"
  | "AMBIGUOUS_TRAJECTORY"
  | "UNLINKED_ORPHAN"
  | "NO_OBSERVATIONS_FOUND";

/**
 * Complete decision-time feature vector extracted strictly at or before t_decision.
 */
export interface DecisionFeatureVector {
  readonly tokenAgeSec: ProvenanceFeature<number>;
  readonly liquidityUsd: ProvenanceFeature<number>;
  readonly marketCapUsd: ProvenanceFeature<number>;
  readonly lmcRatio: ProvenanceFeature<number>;
  readonly lpBurnPct: ProvenanceFeature<number>;
  readonly spotPriceUsd: ProvenanceFeature<number>;
  readonly spotPriceSol: ProvenanceFeature<number>;
  readonly volume5mUsd: ProvenanceFeature<number>;
  readonly txCount5m: ProvenanceFeature<number>;
  readonly buys5m: ProvenanceFeature<number>;
  readonly sells5m: ProvenanceFeature<number>;
  readonly baseReserve: ProvenanceFeature<number>;
  readonly quoteReserve: ProvenanceFeature<number>;
  readonly top10ConcentrationPct: ProvenanceFeature<number>;
  readonly devHoldingPct: ProvenanceFeature<number>;
}

/**
 * Sampling design metadata associated with a candidate decision.
 */
export interface ResearchSamplingMetadata {
  readonly trackingId?: string | undefined;
  readonly tier: StratificationTier;
  readonly samplingProbability: number;
  readonly effectiveInclusionProbability: number;
  readonly ipwEstimable: boolean;
  readonly status: StratifiedSamplingStatus;
}

/**
 * Offline research financial accounting.
 * Computes exact signed cash movements in atomic lamports and SOL,
 * distinguishes BUY inventory acquisitions from SELL liquidations,
 * and preserves signed cash flow on fee-dominated dust exits.
 */
export interface ResearchFinancialAccounting {
  readonly side: "BUY" | "SELL";
  readonly executionOutcome: ExecutionOutcome;
  readonly sellabilityStatus: SellabilityStatus;
  readonly attemptedSizeSol: number;
  readonly filledSizeSol: number;
  readonly grossSolProceeds: number;
  /**
   * Itemized external network fees (base signature fee + priority fee).
   * Note: externalNetworkFeeLamports already contains priority fee; do NOT double-debit.
   */
  readonly externalNetworkFeeLamports: number;
  readonly externalNetworkFeeSol: number;
  readonly priorityFeeLamports: number;
  readonly ataRentDepositLamports: number;
  readonly ataRentRefundLamports: number;
  /**
   * Authoritative signed net cash movement in atomic lamports:
   * For BUY: -buyOutlayLamports - externalNetworkFeeLamports - ataDepositLamports + ataRefundLamports
   * For SELL: grossProceedsLamports - externalNetworkFeeLamports - ataDepositLamports + ataRefundLamports
   */
  readonly signedNetCashFlowLamports: bigint;
  /**
   * Signed net cash flow in SOL (derived from signedNetCashFlowLamports / 1e9).
   */
  readonly signedNetCashFlowSol: number;
  readonly isSubmarginalDust: boolean;
  readonly markedToModelPnlSol?: number | undefined;
  readonly capitalTiedUpSol?: number | undefined;
  readonly unrealizedImpairmentSol: number;
  readonly financialState:
    | "OPEN_POSITION"
    | "REALIZED_LIQUIDATION"
    | "UNREALIZED_HOLDING"
    | "PREFLIGHT_REJECTION"
    | "SUBMITTED_FAILURE"
    | "IMPAIRMENT_WRITE_DOWN";
}

/**
 * Canonical joined research record combining 12.94-B decision context,
 * 12.94-C execution realism estimates (if available), forward trajectory observations,
 * and exact provenance metadata.
 */
export interface JoinedResearchRecord {
  readonly joinId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly decisionEventId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly symbol: string;

  // Chronological timestamps
  readonly decisionTimestampMs: number;
  readonly sourceTimestampMs: number;
  readonly ingestionTimestampMs: number;

  // Decision Context
  readonly decisionCohort: DecisionCohort;
  readonly strategyRevision: string;

  // Evaluation Mode & Linkage
  readonly evaluationMode: ResearchEvaluationMode;
  readonly trajectoryLinkStatus: TrajectoryLinkStatus;

  // Decision-time features
  readonly features: DecisionFeatureVector;

  // Linked Execution Realism (optional, populated in SYNTHETIC_REPLAY or when C records exist)
  readonly quote?: ExecutableQuoteRecord | undefined;
  readonly fill?: SimulatedFillRecord | undefined;

  // Forward Outcome Trajectory Observations (chronologically after decision)
  readonly forwardObservations: readonly MarketObservationRecord[];

  // Sampling & Design Metadata
  readonly samplingMetadata?: ResearchSamplingMetadata | undefined;

  // Session Finalization & Deduplication State
  readonly sessionStatus?: "FINALIZED" | "INTERRUPTED" | "UNFINALIZED" | undefined;
  readonly isDuplicateQuarantined?: boolean | undefined;

  // Offline Financial Accounting (if quote/fill modeled)
  readonly financialAccounting?: ResearchFinancialAccounting | undefined;

  // Research Eligibility
  readonly eligibility: ResearchEligibilityResult;
}

/**
 * Result of the fail-closed research eligibility evaluation.
 */
export interface ResearchEligibilityResult {
  readonly isEligible: boolean;
  readonly evaluationMode: ResearchEvaluationMode;
  readonly rejectionReasons: readonly string[];
  readonly warnings: readonly string[];
}
