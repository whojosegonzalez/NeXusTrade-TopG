/**
 * Phase 12.94-D Milestone D.3.2: Prospective Observation Contracts & Data Types
 *
 * Defines strictly typed, immutable schemas for prospective candidate evaluation
 * and forward-horizon outcome tracking.
 *
 * CAUSALITY & INTEGRITY RULES:
 * 1. Decision-time observations are frozen at creation and never mutated or backfilled.
 * 2. Forward horizon outcomes (+5m, +15m, +30m, +60m) are recorded as separate,
 *    timestamped events referencing the parent decisionEventId.
 * 3. Indicative market prices are explicitly distinguished from executable quotes.
 * 4. Rejections are categorized by Risk, Eligibility, Missing Data, and Capacity.
 * 5. Missing observations must carry explicit failure/truncation reason codes.
 */

export type ProspectiveStrategyCohort = "ESTABLISHED_RUNNER" | "MICRO_CAP_PROBE" | "UNCLASSIFIED";

export type CandidateStreamSource =
  | "RAYDIUM_TOP_TRADED"
  | "DEXSCREENER_RECENT"
  | "BIRDEYE_TRENDING"
  | "SOLANA_RPC_EVENT"
  | "MOCK_STREAM";

export type RejectionCategory =
  | "REJECTED_BY_RISK"
  | "REJECTED_BY_ELIGIBILITY"
  | "REJECTED_BY_MISSING_DATA"
  | "REJECTED_BY_CAPACITY";

export type GateDecisionOutcome = "ACCEPTED_ARMED" | "FILTERED_REJECTED";

export interface DecisionMarketFeatures {
  /** Indicative market price in SOL at decision time. NOT an executable swap quote. */
  readonly indicativePriceSol: number;
  readonly priceQuoteTimestampMs: number;
  readonly priceQuoteFreshnessMs: number;
  readonly liquidityUsd: number;
  readonly volume5mUsd: number;
  readonly marketCapUsd: number;
  readonly assetAgeSeconds: number;
  readonly holdersCount: number | null;
  readonly buyToSellRatio: number;
  readonly recentBuys60s: number | null;
  readonly recentSells60s: number | null;
  readonly lmcRatio: number;
  readonly rugScore: number | null;
  readonly bundlerPct: number | null;
  readonly top10HolderPct: number | null;
  readonly unavailableInputs: readonly string[];
}

export interface GateCheckRecord {
  readonly name: string;
  readonly passed: boolean;
  readonly value: number | null;
  readonly requirement: string;
}

export interface DecisionGateOutcome {
  readonly decision: GateDecisionOutcome;
  readonly rejectionCategory: RejectionCategory | null;
  readonly primaryFailedRule: string | null;
  readonly allFailedRules: readonly string[];
  readonly gateChecks: readonly GateCheckRecord[];
}

/**
 * Immutable record of a candidate evaluation captured at decision time.
 * MUST NOT be mutated after creation.
 */
export interface DecisionTimeObservationRecord {
  readonly decisionEventId: string;
  readonly sessionId: string;
  readonly candidateDiscoveryTimestampMs: number;
  readonly decisionTimestampMs: number;
  readonly streamSource: CandidateStreamSource;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly symbol: string;
  readonly strategyCohort: ProspectiveStrategyCohort;
  readonly configFingerprint: string;
  readonly marketFeatures: DecisionMarketFeatures;
  readonly gateOutcome: DecisionGateOutcome;
}

export const FORWARD_HORIZONS_SEC = [300, 900, 1800, 3600] as const; // +5m, +15m, +30m, +60m
export type ForwardHorizonSec = (typeof FORWARD_HORIZONS_SEC)[number];

export type ForwardOutcomeStatus =
  | "OBSERVED_PRICE"
  | "POOL_DRAINED"
  | "POOL_CLOSED"
  | "MISSING_QUOTE_UNAVAILABLE"
  | "MISSING_STALE_QUOTE"
  | "WINDOW_TRUNCATED"
  | "CENSORED_CAPACITY";

/**
 * Separate, timestamped forward outcome record referencing a decisionEventId.
 */
export interface ForwardHorizonOutcomeRecord {
  readonly forwardOutcomeId: string;
  readonly decisionEventId: string;
  readonly sessionId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly horizonSec: ForwardHorizonSec;
  readonly scheduledDueTimestampMs: number;
  readonly actualObservationTimestampMs: number | null;
  readonly observationLatencyMs: number | null;
  readonly outcomeStatus: ForwardOutcomeStatus;
  readonly indicativePriceSol: number | null;
  readonly priceReturnPct: number | null;
  readonly liquidityUsd: number | null;
  readonly liquidityChangePct: number | null;
  readonly quoteTimestampMs: number | null;
  readonly quoteSource: string | null;
  readonly quoteFreshnessMs: number | null;
  readonly isExecutableQuote: boolean;
  readonly missingReason?: string | undefined;
}

export interface SessionManifestFileEntry {
  readonly filename: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly recordCount?: number | undefined;
}

export interface SessionManifest {
  readonly manifestVersion: string;
  readonly sessionId: string;
  readonly configFingerprint: string;
  readonly createdAt: string;
  readonly files: readonly SessionManifestFileEntry[];
  readonly manifestDigestSha256: string;
  readonly verificationStatus: "VERIFIED_OFFLINE" | "VERIFIED_LIVE";
}

export interface CohortHorizonStatistics {
  readonly sampleCount: number;
  readonly validPriceCount: number;
  readonly missingCount: number;
  readonly meanReturnPct: number | null;
  readonly medianReturnPct: number | null;
  readonly minReturnPct: number | null;
  readonly maxReturnPct: number | null;
  readonly standardDeviationPct: number | null;
  readonly positiveReturnRatio: number | null; // fraction > 0%
}

export interface HorizonCoverageSummary {
  readonly scheduledCount: number;
  readonly observedCount: number;
  readonly missingCount: number;
  readonly coveragePct: number;
}

export interface ProspectiveSessionSummary {
  readonly sessionId: string;
  readonly configFingerprint: string;
  readonly sessionStartedAtMs: number;
  readonly intakeStoppedAtMs: number;
  readonly sessionClosedAtMs: number;
  readonly totalCandidatesScreened: number;
  readonly uniqueMintsCount: number;
  readonly duplicateCandidatesSuppressed: number;
  readonly acceptedCandidatesCount: number;
  readonly rejectedCandidatesCount: number;
  readonly rejectionsByCategory: Record<RejectionCategory, number>;
  readonly rejectionsByRule: Record<string, number>;
  readonly candidatesByCohort: Record<ProspectiveStrategyCohort, number>;
  readonly horizonCoverage: Record<string, HorizonCoverageSummary>;
  readonly cohortHorizonStats: {
    readonly established: Record<string, CohortHorizonStatistics>;
    readonly microCap: Record<string, CohortHorizonStatistics>;
    readonly accepted: Record<string, CohortHorizonStatistics>;
    readonly rejectedByRisk: Record<string, CohortHorizonStatistics>;
    readonly rejectedByEligibility: Record<string, CohortHorizonStatistics>;
  };
  readonly dataQuality: {
    readonly averageQuoteLatencyMs: number;
    readonly staleQuotesDetected: number;
    readonly unavailableQuotesDetected: number;
    readonly drainedPoolsDetected: number;
    readonly quoteFreshnessAverageMs: number;
  };
}
