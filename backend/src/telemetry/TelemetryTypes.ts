/**
 * Phase 12.94-B Market Telemetry Engine: Core Types and Schemas
 *
 * Implements immutable candidate discovery and decision logging, point-in-time
 * market observations, stratified counterfactual tracking, and decision context reconstruction.
 */

export type DecisionCohort =
  | "FILTERED_REJECTED"
  | "WATCHLIST_RADAR"
  | "TRIGGER_REJECTED"
  | "EXECUTED_BUY";

export interface FilterEvaluationDetail {
  readonly filterName: string;
  readonly passed: boolean;
  readonly valueObserved: number | string | boolean | null;
  readonly threshold: number | string | boolean | null;
  readonly rejectionReason?: string | undefined;
}

export interface CandidateMetricsSnapshot {
  readonly tokenAgeSec: number;
  readonly liquidityUsd: number;
  readonly marketCapUsd: number;
  readonly lmcRatio: number;
  readonly lpBurnPct: number;
  readonly spotPriceUsd: number;
  readonly volume5mUsd: number;
  readonly txCount5m: number;
  readonly buys5m: number;
  readonly sells5m: number;
}

export interface CandidateDecisionRecord {
  readonly eventId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly symbol: string;
  readonly sourceTimestampMs: number;
  readonly ingestionTimestampMs: number;
  readonly decisionTimestampMs: number;
  readonly strategyRevision: string;
  readonly decisionCohort: DecisionCohort;
  readonly primaryRejectionReason?: string | undefined;
  readonly filterEvaluations: readonly FilterEvaluationDetail[];
  readonly metricsSnapshot: CandidateMetricsSnapshot;
  readonly missingFields: readonly string[];
  readonly providerIdentity: string;
}

export type PriceSourceType = "POOL_RESERVE" | "ROUTE_QUOTE" | "INDEXED_TICK";

export interface MeasurementWindow {
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly durationSec: number;
}

export interface MarketObservationRecord {
  readonly observationId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly sourceTimestampMs: number;
  readonly ingestionTimestampMs: number;
  readonly dataFreshnessMs: number;
  readonly measurementWindow: MeasurementWindow;
  readonly providerIdentity: string;
  readonly priceMetrics: {
    readonly spotPriceUsd: number;
    readonly spotPriceSol: number;
    readonly priceSource: PriceSourceType;
  };
  readonly liquidityMetrics: {
    readonly baseReserve: number;
    readonly quoteReserve: number;
    readonly liquidityUsd: number;
  };
  readonly flowMetrics: {
    readonly txCount: number;
    readonly buys: number;
    readonly sells: number;
    readonly volumeUsd: number;
    readonly netBuyerVolumeUsd: number;
  };
  readonly holderMetrics?:
    | {
        readonly top10ConcentrationPct: number;
        readonly devHoldingPct: number;
        readonly totalHolders: number;
      }
    | undefined;
  readonly missingFields: readonly string[];
  readonly strategyRevision: string;
}

export type StratificationTier =
  | "EXECUTED_POSITION"
  | "WATCHLIST_ACTIVE"
  | "NEAR_MISS_CANDIDATE"
  | "HARD_REJECT_BASELINE"
  | "EXCLUDED_SPAM";

export interface StratifiedSamplingRecord {
  readonly trackingId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly decisionEventId: string;
  readonly tier: StratificationTier;
  readonly samplingProbability: number;
  readonly selectionSeed: string;
  readonly trackingStartedMs: number;
  readonly trackingExpiresMs: number;
  readonly currentSamplingIntervalMs: number;
  readonly observationCount: number;
  readonly initialPriceSol: number;
  readonly peakPriceSol: number;
  readonly peakGainPct: number;
  readonly troughPriceSol: number;
  readonly maxDrawdownPct: number;
  readonly latestPriceSol: number;
  readonly status: "TRACKING_ACTIVE" | "EXPIRED" | "TERMINATED_EARLY";
}

export interface SessionTelemetryMeta {
  readonly sessionId: string;
  readonly generationId: string;
  readonly strategyRevision: string;
  readonly startedAtIso: string;
  readonly closedAtIso?: string | undefined;
  readonly initialWalletBalanceSol: number;
  readonly environment: {
    readonly platform: string;
    readonly nodeVersion: string;
  };
}

export interface SessionTelemetrySummary {
  readonly sessionId: string;
  readonly generationId: string;
  readonly strategyRevision: string;
  readonly startedAtIso: string;
  readonly closedAtIso: string;
  readonly totalCandidatesScreened: number;
  readonly cohortBreakdown: {
    readonly filteredRejected: number;
    readonly watchlistRadar: number;
    readonly triggerRejected: number;
    readonly executedBuy: number;
  };
  readonly topRejectionReasons: Record<string, number>;
  readonly totalMarketObservationsRecorded: number;
  readonly totalStratifiedCandidatesTracked: number;
  readonly missedWinnersCount: number;
  readonly avoidedRugsCount: number;
}

export interface ReconstructedDecisionContext {
  readonly decisionRecord: CandidateDecisionRecord;
  readonly preDecisionWindow: readonly MarketObservationRecord[];
  readonly inTradeWindow?: readonly MarketObservationRecord[] | undefined;
  readonly postExitWindow?: readonly MarketObservationRecord[] | undefined;
  readonly reconstructedOrderBook: {
    readonly estimatedSpotSol: number;
    readonly bestAvailableLiquidityUsd: number;
    readonly observedPriceImpactBps: number;
  };
  readonly dataQualityScore: number;
  readonly missingDataFields: readonly string[];
}
