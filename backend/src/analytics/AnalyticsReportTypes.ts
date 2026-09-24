import type { StrategyDecision } from "../db/schema/index.js";
export interface AnalyticsReport {
  readonly generatedAtMs: number;
  readonly session: SessionReport;
  readonly funnel: FunnelReport;
  readonly scoreBuckets: readonly ScoreBucketReport[];
  readonly nearMisses: readonly NearMissReport[];
  readonly missedOpportunities: readonly MissedOpportunityReport[];
  readonly providerHealth: readonly ProviderHealthReport[];
  readonly quoteBudget: QuoteBudgetReport;
  readonly jupiterRateLimitSummary?: ProviderHealthReport | undefined;
}

/** Local pre-router allocation telemetry. It is intentionally separate from provider health. */
export interface QuoteBudgetReport {
  readonly assessmentsWithPlan: number;
  readonly selectedCount: number;
  readonly notSelectedCount: number;
  readonly skippedLiveCallsEstimate: number;
  readonly selectionReasonCounts: Readonly<Record<string, number>>;
  readonly signalCounts: Readonly<Record<string, number>>;
  readonly rankBucketCounts: Readonly<Record<string, number>>;
  readonly quoteSuccessCount: number;
}

export interface SessionReport {
  readonly id: string;
  readonly mode: string;
  readonly status: string;
  readonly startingBalanceLamports: number;
  readonly currentCashLamports: number;
  readonly targetProfitLamports: number | null;
  readonly targetProfitBps: number | null;
  readonly maxDrawdownLamports: number | null;
  readonly realizedPnlLamports: number;
  readonly unrealizedPnlLamports: number;
  readonly terminationReason: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface FunnelReport {
  readonly tokenRadarTotal: number;
  readonly tokenRadarByStatus: Readonly<Record<string, number>>;
  readonly riskAssessmentTotal: number;
  readonly riskByResult: Readonly<Record<string, number>>;
  readonly strategyDecisionTotal: number;
  readonly strategyByDecision: Readonly<Record<string, number>>;
  readonly orderTotal: number;
  readonly ordersByStatus: Readonly<Record<string, number>>;
  readonly fillTotal: number;
  readonly positionsByStatus: Readonly<Record<string, number>>;
  readonly equitySnapshotTotal: number;
  readonly watchlistReturnTotal: number;
  readonly watchlistReturnsByStatus: Readonly<Record<string, number>>;
}

export interface ScoreBucketReport {
  readonly bucket: string;
  readonly total: number;
  readonly buyCount: number;
  readonly watchCount: number;
  readonly skipCount: number;
}

export interface NearMissReport {
  readonly decidedAtMs: number;
  readonly mintAddress: string;
  readonly symbol?: string | undefined;
  readonly decision: StrategyDecision;
  readonly score: number | null;
  readonly reason: string;
  readonly riskResult?: string | undefined;
  readonly riskFlags: readonly string[];
  readonly blockingFactors: readonly string[];
  readonly liquidityUsd?: string | undefined;
  readonly volume1hUsd?: string | undefined;
  readonly ageSeconds?: number | undefined;
  readonly maxPriceImpactPct?: number | undefined;
}

export interface MissedOpportunityReport {
  readonly mintAddress: string;
  readonly symbol?: string | undefined;
  readonly decision: StrategyDecision;
  readonly score: number | null;
  readonly reason: string;
  readonly riskResult?: string | undefined;
  readonly blockingFactors: readonly string[];
  readonly baselinePriceSol?: string | undefined;
  readonly returnsByHorizon: Readonly<Record<string, string>>;
  readonly bestHorizonMinutes: number;
  readonly bestReturnPct: string;
}

export interface ProviderHealthReport {
  readonly provider: string;
  readonly operation?: string | undefined;
  readonly total: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly okPercent: number;
  readonly degradedPercent: number;
  readonly rateLimitedPercent: number;
  readonly errorPercent: number;
  readonly liveRows: number;
  readonly routerRows: number;
  readonly liveRateLimitedPercent: number;
  readonly liveErrorPercent: number;
  readonly routerCacheHits: number;
  readonly routerCooldownSkips: number;
  readonly routerUnavailable: number;
  readonly routerCooldownSkipPercent: number;
  readonly combinedRateLimitedPercent: number;
  readonly quoteSourceTypeCounts: Readonly<Record<string, number>>;
  readonly quoteFallbackReasonCounts: Readonly<Record<string, number>>;
  readonly quoteDemandActionCounts: Readonly<Record<string, number>>;
  readonly quoteSchedulerWaitMsTotal: number;
  readonly quoteSingleFlightJoinCount: number;
  readonly quoteNegativeCacheHitCount: number;
  readonly quoteNegativeCacheReasonCounts: Readonly<Record<string, number>>;
  readonly raydiumVenueGuardDecisionCounts: Readonly<Record<string, number>>;
  readonly raydiumVenueGuardReasonCounts: Readonly<Record<string, number>>;
  readonly liveQuoteCallsAvoidedEstimate: number;
  readonly jupiterDemandActionCounts: Readonly<Record<string, number>>;
  readonly jupiterDemandOperationCounts: Readonly<Record<string, number>>;
  readonly jupiterDemandPriorityCounts: Readonly<Record<string, number>>;
  readonly jupiterDemandDeferredCount: number;
  readonly jupiterLiveAllowedCount: number;
  readonly jupiterControllerRateLimitObservedCount: number;
  readonly jupiterEffectiveIntervalMsAverage: number;
  readonly jupiterAdaptiveLevelMax: number;
  readonly jupiterSharedWindowUsageMax: number;
  readonly authorityEvidenceSourceCounts: Readonly<Record<string, number>>;
  readonly mintAuthorityStateCounts: Readonly<Record<string, number>>;
  readonly freezeAuthorityStateCounts: Readonly<Record<string, number>>;
  readonly rpcCacheStatusCounts: Readonly<Record<string, number>>;
  readonly rpcFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly dasProviderCounts: Readonly<Record<string, number>>;
  readonly dasFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly raydiumFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly raydiumPreflightStatusCounts: Readonly<Record<string, number>>;
  readonly heliusEvidenceSourceCounts: Readonly<Record<string, number>>;
  readonly heliusCacheStatusCounts: Readonly<Record<string, number>>;
  readonly birdeyeEndpointCounts: Readonly<Record<string, number>>;
  readonly birdeyeCacheStatusCounts: Readonly<Record<string, number>>;
  readonly birdeyeFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly birdeyeSelectionReasonCounts: Readonly<Record<string, number>>;
  readonly birdeyeBudgetReasonCounts: Readonly<Record<string, number>>;
  readonly latestStatus?: string | undefined;
  readonly latestErrorMessage?: string | null | undefined;
}
