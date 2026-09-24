import type {
  ProviderHealthRecord,
  RiskAssessmentRecord,
  SessionRecord,
  StrategyDecision,
  StrategyDecisionRecord,
  TokenRadarRecord,
  WatchlistReturnObservationRecord,
} from "../db/schema/index.js";

export interface CalibrationRawDataset {
  readonly label: string;
  readonly path: string;
  readonly session: SessionRecord;
  readonly strategyDecisions: readonly StrategyDecisionRecord[];
  readonly watchlistReturns: readonly WatchlistReturnObservationRecord[];
  readonly riskAssessments: readonly RiskAssessmentRecord[];
  readonly tokenRadar: readonly TokenRadarRecord[];
  readonly providerHealth: readonly ProviderHealthRecord[];
}

export interface ScoreFactorAttribution {
  readonly ruleName: string;
  readonly points: number;
  readonly passed: boolean;
  readonly reason?: string;
  readonly warnings: readonly string[];
}

export interface ScoreAttribution {
  readonly storedScore: number | null;
  readonly factorTotal: number;
  readonly factors: readonly ScoreFactorAttribution[];
  readonly rawDecision?: StrategyDecision;
  readonly buyScoreThreshold?: number;
  readonly watchScoreThreshold?: number;
  readonly buyEligible: boolean;
  readonly duplicateBuyBlocked: boolean;
  readonly maxBuyCapBlocked: boolean;
  readonly riskResult?: string;
  readonly riskFlags: readonly string[];
  readonly symbol?: string;
  readonly name?: string;
  readonly pairAddress?: string;
  readonly liquidityUsd?: number;
  readonly volume5mUsd?: number;
  readonly volume1hUsd?: number;
  readonly ageSeconds?: number;
  readonly maxPriceImpactPct?: number;
  readonly missingQuote: boolean;
  readonly missingAuthorityEvidence: boolean;
  readonly missingPriceImpact: boolean;
  readonly blockingFactors: readonly string[];
}

export interface ReturnPoint {
  readonly horizonMinutes: number;
  readonly returnPct: number;
}

export interface ThresholdEvent {
  readonly thresholdPct: number;
  readonly horizonMinutes: number;
  readonly returnPct: number;
}

export interface ForwardReturnMetrics {
  readonly observedPoints: readonly ReturnPoint[];
  readonly bestReturnPct?: number;
  readonly bestHorizonMinutes?: number;
  readonly worstReturnPct?: number;
  readonly worstHorizonMinutes?: number;
  readonly targetHits: readonly ThresholdEvent[];
  readonly drawdownBreaches: readonly ThresholdEvent[];
  readonly ambiguousTargetStopOrdering: boolean;
}

export interface CalibrationDecisionAnalysis {
  readonly datasetLabel: string;
  readonly decisionId: string;
  readonly mintAddress: string;
  readonly decidedAtMs: number;
  readonly decision: StrategyDecision;
  readonly score: number | null;
  readonly reason: string;
  readonly attribution: ScoreAttribution;
  readonly returns: ForwardReturnMetrics;
}

export interface CalibrationDatasetReport {
  readonly label: string;
  readonly path: string;
  readonly session: CalibrationSessionSummary;
  readonly counts: CalibrationDatasetCounts;
  readonly scoreDistribution: readonly ScoreDistributionRow[];
  readonly scoreAttribution: ScoreAttributionSummary;
  readonly forwardReturns: ForwardReturnSummary;
  readonly targetSimulation: TargetSimulationSummary;
  readonly missedOpportunities: readonly MissedOpportunityCalibrationRow[];
  readonly falsePositiveBuys: readonly FalsePositiveBuyRow[];
  readonly providerImpact: ProviderImpactSummary;
  readonly thresholdComparison: readonly ThresholdScenarioSummary[];
}

export interface CalibrationSessionSummary {
  readonly id: string;
  readonly mode: string;
  readonly status: string;
  readonly startedAtMs: number;
  readonly currentCashLamports: number;
  readonly realizedPnlLamports: number;
  readonly unrealizedPnlLamports: number;
}

export interface CalibrationDatasetCounts {
  readonly tokenRadarRows: number;
  readonly uniqueRadarMints: number;
  readonly strategyRows: number;
  readonly uniqueStrategyMints: number;
  readonly observedReturnRows: number;
  readonly riskRows: number;
  readonly providerHealthRows: number;
}

export interface ScoreDistributionRow {
  readonly bucket: string;
  readonly total: number;
  readonly buyCount: number;
  readonly watchCount: number;
  readonly skipCount: number;
  readonly uniqueMints: number;
}

export interface ScoreAttributionRuleSummary {
  readonly ruleName: string;
  readonly count: number;
  readonly averagePoints: number;
  readonly zeroPointCount: number;
  readonly failedCount: number;
  readonly warningCount: number;
}

export interface ScoreAttributionSummary {
  readonly maxObservedScore: number | null;
  readonly averageScore: number | null;
  readonly storedScoreMismatchCount: number;
  readonly missingSnapshotCount: number;
  readonly missingQuoteCount: number;
  readonly missingAuthorityEvidenceCount: number;
  readonly missingPriceImpactCount: number;
  readonly ruleSummaries: readonly ScoreAttributionRuleSummary[];
}

export interface ReturnGroupSummary {
  readonly label: string;
  readonly count: number;
  readonly averageBestReturnPct: number | null;
  readonly averageWorstReturnPct: number | null;
  readonly hitRatesByTargetPct: Readonly<Record<string, number>>;
}

export interface ForwardReturnSummary {
  readonly analyzedDecisionCount: number;
  readonly observedDecisionCount: number;
  readonly byDecision: readonly ReturnGroupSummary[];
  readonly byScoreBucket: readonly ReturnGroupSummary[];
}

export interface TargetSimulationSummary {
  readonly maxHoldMinutes: number;
  readonly targetPcts: readonly number[];
  readonly drawdownPcts: readonly number[];
  readonly rows: readonly TargetSimulationRow[];
}

export interface TargetSimulationRow {
  readonly targetPct: number;
  readonly drawdownPct: number;
  readonly evaluatedCount: number;
  readonly targetBeforeDrawdownCount: number;
  readonly drawdownBeforeTargetCount: number;
  readonly ambiguousCount: number;
  readonly neitherCount: number;
}

export interface MissedOpportunityCalibrationRow {
  readonly datasetLabel: string;
  readonly symbol?: string;
  readonly mintAddress: string;
  readonly decision: StrategyDecision;
  readonly score: number | null;
  readonly bestReturnPct: number;
  readonly bestHorizonMinutes: number;
  readonly worstReturnPct?: number;
  readonly riskFlags: readonly string[];
  readonly blockingFactors: readonly string[];
  readonly liquidityUsd?: number;
  readonly volume1hUsd?: number;
  readonly ageSeconds?: number;
  readonly missingQuote: boolean;
}

export interface FalsePositiveBuyRow extends MissedOpportunityCalibrationRow {
  readonly failedTargetPct: number;
}

export interface ProviderStatusSummary {
  readonly provider: string;
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
}

export interface ProviderImpactSummary {
  readonly providers: readonly ProviderStatusSummary[];
  readonly strategyRows: number;
  readonly missingQuoteCount: number;
  readonly missingAuthorityEvidenceCount: number;
  readonly missingPriceImpactCount: number;
  readonly averageScoreWithQuote: number | null;
  readonly averageScoreWithoutQuote: number | null;
  readonly target10HitRateWithQuote: number | null;
  readonly target10HitRateWithoutQuote: number | null;
}

export interface ThresholdScenarioSummary {
  readonly buyScoreThreshold: number;
  readonly watchScoreThreshold: number;
  readonly buyCount: number;
  readonly watchCount: number;
  readonly skipCount: number;
  readonly uniqueBuyMints: number;
  readonly observedBuyCount: number;
  readonly targetHitRatesByPct: Readonly<Record<string, number>>;
  readonly averageBuyBestReturnPct: number | null;
  readonly averageBuyWorstReturnPct: number | null;
}

export interface CalibrationReport {
  readonly generatedAtMs: number;
  readonly datasets: readonly CalibrationDatasetReport[];
  readonly recommendations: readonly string[];
}
