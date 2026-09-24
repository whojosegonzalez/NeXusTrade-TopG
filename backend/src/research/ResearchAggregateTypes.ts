import type { StrategyDecision } from "../db/schema/index.js";
import type { ShadowCalibrationReport } from "../shadow-calibration/ShadowCalibrationTypes.js";
import type { ShadowEntryCandidate, ShadowEntryReport } from "../shadow-entry/ShadowEntryTypes.js";
import type { TerminalRunSummary } from "../terminal-runner/TerminalRunSummary.js";

export type ResearchReadinessLabel =
  | "NOT_READY"
  | "PROMISING_RESEARCH"
  | "CANDIDATE_FOR_CONTROLLED_PAPER_PILOT";
export type ResearchConfidenceLabel = "LOW" | "MEDIUM" | "HIGH";

export interface ResearchRunSourceConfig {
  readonly label: string;
  readonly path: string;
}

export interface ResearchThresholdProfile {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly buyScoreThreshold: number;
  readonly watchScoreThreshold: number;
}

export interface ResearchAggregateRuntimeConfig {
  readonly once: boolean;
  readonly json: boolean;
  readonly runSources: readonly ResearchRunSourceConfig[];
  readonly outputDir?: string;
  readonly minRuns: number;
  readonly minUniqueMintsForPromotion: number;
  readonly minObservedDecisionsForPromotion: number;
  readonly maxSingleRunWinSharePct: number;
  readonly targetPcts: readonly number[];
  readonly stopPcts: readonly number[];
  readonly maxHoldMinutes: readonly number[];
  readonly scoreBucketSize: number;
  readonly minScore: number;
  readonly sourceDecisions: readonly StrategyDecision[];
  readonly thresholdProfiles: readonly ResearchThresholdProfile[];
}

export interface ResearchArchiveMetadata {
  readonly label: string;
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly databasePath: string;
  readonly runnerJsonPath: string;
  readonly runnerTextPath?: string;
  readonly analyticsReportPath?: string;
  readonly calibrationReportPath?: string;
  readonly shadowCalibrationReportPath?: string;
  readonly terminalSummary: TerminalRunSummary;
  readonly warnings: readonly string[];
}

export interface ResearchRunValidation {
  readonly label: string;
  readonly runId: string;
  readonly databasePath: string;
  readonly terminalSessionId?: string;
  readonly databaseSessionId?: string;
  readonly safetyStatus: string;
  readonly cycleCount: number;
  readonly oneSession: boolean;
  readonly uniqueStageSessionIds: readonly string[];
  readonly scannerStoredCount: number;
  readonly strategyWrittenCount: number;
  readonly validForPromotion: boolean;
  readonly warnings: readonly string[];
}

export interface ResearchThresholdRunSummary {
  readonly label: string;
  readonly observedBuyCount: number;
  readonly uniqueBuyMints: number;
  readonly averageBestReturnPct?: number;
  readonly averageWorstReturnPct?: number;
  readonly targetHitRates: Readonly<Record<string, number>>;
  readonly drawdownFirstRates: Readonly<Record<string, number>>;
}

export interface ResearchThresholdComparison {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly label: string;
  readonly buyScoreThreshold: number;
  readonly watchScoreThreshold: number;
  readonly simulatedBuyCount: number;
  readonly observedBuyCount: number;
  readonly uniqueBuyMints: number;
  readonly averageBestReturnPct?: number;
  readonly averageWorstReturnPct?: number;
  readonly targetHitRates: Readonly<Record<string, number>>;
  readonly drawdownFirstRates: Readonly<Record<string, number>>;
  readonly byRun: readonly ResearchThresholdRunSummary[];
}

export interface ResearchProviderPressureSummary {
  readonly provider: string;
  readonly total: number;
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
  readonly jupiterDemandActionCounts: Readonly<Record<string, number>>;
  readonly jupiterDemandOperationCounts: Readonly<Record<string, number>>;
  readonly jupiterDemandPriorityCounts: Readonly<Record<string, number>>;
  readonly jupiterDemandDeferredCount: number;
  readonly jupiterLiveAllowedCount: number;
  readonly jupiterControllerRateLimitObservedCount: number;
  readonly jupiterEffectiveIntervalMsAverage: number;
  readonly jupiterAdaptiveLevelMax: number;
  readonly jupiterSharedWindowUsageMax: number;
  readonly quoteSchedulerWaitMsTotal: number;
  readonly quoteSingleFlightJoinCount: number;
  readonly quoteNegativeCacheHitCount: number;
  readonly quoteNegativeCacheReasonCounts: Readonly<Record<string, number>>;
  readonly raydiumVenueGuardDecisionCounts: Readonly<Record<string, number>>;
  readonly raydiumVenueGuardReasonCounts: Readonly<Record<string, number>>;
  readonly liveQuoteCallsAvoidedEstimate: number;
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

export interface ResearchConcentrationSummary {
  readonly targetPct: number;
  readonly stopPct: number;
  readonly targetFirstWinCount: number;
  readonly maxSingleRunWinSharePct: number;
  readonly maxSingleMintWinSharePct: number;
  readonly dominantRunLabel?: string;
  readonly dominantMintAddress?: string;
}

/** Local allocation telemetry from TerminalRunner risk-stage counts, never provider health. */
export interface ResearchQuoteBudgetSummary {
  readonly riskCycleCount: number;
  readonly plannerEnabledCycleCount: number;
  readonly selectedCount: number;
  readonly notSelectedCount: number;
  readonly skippedLiveCallsEstimate: number;
}

export interface ResearchCrossRunSummary {
  readonly runCount: number;
  readonly validRunCount: number;
  readonly observedDecisionCount: number;
  readonly uniqueMintCount: number;
  readonly orderCount: number;
  readonly fillCount: number;
  readonly positionCount: number;
  readonly thresholdComparisons: readonly ResearchThresholdComparison[];
  readonly providerPressure: readonly ResearchProviderPressureSummary[];
  readonly quoteBudget?: ResearchQuoteBudgetSummary;
  readonly concentration: ResearchConcentrationSummary;
}

export interface ResearchPromotionGateResult {
  readonly readiness: ResearchReadinessLabel;
  readonly confidence: ResearchConfidenceLabel;
  readonly candidateProfileId?: string;
  readonly controlledPaperPilotRecommended: boolean;
  readonly paperBuyAutomationEnabled: false;
  readonly blockingReasons: readonly string[];
  readonly supportingEvidence: readonly string[];
  readonly cautionNotes: readonly string[];
}

export interface ResearchAggregateReport {
  readonly generatedAtMs: number;
  readonly config: {
    readonly runLabels: readonly string[];
    readonly minRuns: number;
    readonly minUniqueMintsForPromotion: number;
    readonly minObservedDecisionsForPromotion: number;
    readonly maxSingleRunWinSharePct: number;
    readonly targetPcts: readonly number[];
    readonly stopPcts: readonly number[];
    readonly maxHoldMinutes: readonly number[];
    readonly sourceDecisions: readonly StrategyDecision[];
    readonly minScore: number;
  };
  readonly archives: readonly ResearchArchiveMetadata[];
  readonly runValidations: readonly ResearchRunValidation[];
  readonly crossRun: ResearchCrossRunSummary;
  readonly shadowCalibration: ShadowCalibrationReport;
  readonly shadowEntries: ShadowEntryReport;
  readonly promotionGate: ResearchPromotionGateResult;
  readonly recommendations: readonly string[];
}

export interface ResearchAggregateServiceInput {
  readonly config: ResearchAggregateRuntimeConfig;
  readonly archives: readonly ResearchArchiveMetadata[];
  readonly shadowCalibration: ShadowCalibrationReport;
  readonly shadowEntries: ShadowEntryReport;
  readonly candidates: readonly ShadowEntryCandidate[];
}
