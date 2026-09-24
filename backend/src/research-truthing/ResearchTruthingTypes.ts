import type { StrategyDecision } from "../db/schema/index.js";
import type { ResearchInterpretationCandidate } from "../research-interpretation/ResearchInterpretationTypes.js";
import type { TerminalRunSummary } from "../terminal-runner/TerminalRunSummary.js";

export type ResearchTruthingDedupeMode = "decision" | "mint" | "first_per_mint" | "best_per_mint";

export interface ResearchTruthingRunSourceConfig {
  readonly label: string;
  readonly path: string;
}

export interface ResearchTruthingRuntimeConfig {
  readonly once: boolean;
  readonly json: boolean;
  readonly runSources: readonly ResearchTruthingRunSourceConfig[];
  readonly outputDir?: string;
  readonly dedupeMode: ResearchTruthingDedupeMode;
  readonly sourceDecisions: readonly StrategyDecision[];
  readonly minScore: number;
  readonly targetPcts: readonly number[];
  readonly stopPcts: readonly number[];
  readonly maxHoldMinutes: readonly number[];
  readonly topLimit: number;
  readonly marketWindowMinutes: number;
  readonly requireTerminalJson: boolean;
  readonly requireDb: boolean;
  readonly includeRunnerCycles: boolean;
}

export interface ResearchTruthingLimitMetadata {
  readonly sectionName: string;
  readonly rowsAvailable: number;
  readonly rowsEvaluated: number;
  readonly rowsDisplayed: number;
  readonly displayLimit: number;
  readonly displayTruncated: boolean;
  readonly omittedDisplayRows: number;
  readonly dedupeMode: ResearchTruthingDedupeMode;
}

export interface ResearchTruthingArchiveReference {
  readonly label: string;
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly databasePath: string;
  readonly runnerJsonPath: string;
  readonly runnerTextPath?: string;
  readonly analyticsReportPath?: string;
  readonly calibrationReportPath?: string;
  readonly shadowCalibrationReportPath?: string;
  readonly terminalSummary: Omit<TerminalRunSummary, "cycles"> & {
    readonly cycles?: TerminalRunSummary["cycles"];
  };
  readonly runnerCyclesIncluded: boolean;
  readonly warnings: readonly string[];
}

export interface ResearchTruthingArchiveCounts {
  readonly label: string;
  readonly databasePath: string;
  readonly sessionId?: string;
  readonly tableCounts: Readonly<Record<string, number>>;
  readonly oneSession: boolean;
  readonly terminalSessionId?: string;
  readonly databaseSessionIds: readonly string[];
  readonly warnings: readonly string[];
}

export type ResearchTruthingProviderRowClass =
  | "LIVE_OK"
  | "LIVE_RATE_LIMITED"
  | "LIVE_PROVIDER_FAILURE"
  | "ROUTER_CACHE_HIT"
  | "ROUTER_COOLDOWN_SKIP"
  | "POLICY_BUDGET_SKIP"
  | "POLICY_DISABLED"
  | "DIAGNOSTIC_ONLY"
  | "UNKNOWN_OR_UNCLASSIFIED";

export type ResearchTruthingMissingQuoteCategory =
  | "QUOTE_AVAILABLE"
  | "NO_BUY_QUOTE"
  | "NO_SELL_QUOTE"
  | "NO_ROUND_TRIP_QUOTE"
  | "PRICE_IMPACT_MISSING"
  | "PROVIDER_RATE_LIMITED"
  | "ROUTER_COOLDOWN"
  | "PROVIDER_UNAVAILABLE"
  | "ROUTE_UNSUPPORTED"
  | "POLICY_SKIPPED"
  | "BIRDEYE_MARKET_DATA_ONLY"
  | "INSUFFICIENT_ARCHIVE_EVIDENCE"
  | "UNEXPLAINED";

export type ResearchTruthingQuoteExplanationConfidence =
  | "DIRECT"
  | "CORRELATED"
  | "INSUFFICIENT_ARCHIVE_EVIDENCE"
  | "UNCLASSIFIED";

export interface ResearchTruthingProviderReclassification {
  readonly provider: string;
  readonly total: number;
  readonly classes: Readonly<Record<ResearchTruthingProviderRowClass, number>>;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly failureCounts: Readonly<Record<string, number>>;
  readonly diagnosticCounts: Readonly<Record<string, number>>;
}

export interface ResearchTruthingQuoteEvidenceSummary {
  readonly totalCandidates: number;
  readonly missingQuoteCount: number;
  readonly directMissingQuoteCount: number;
  readonly correlatedMissingQuoteCount: number;
  readonly insufficientArchiveEvidenceMissingQuoteCount: number;
  readonly unclassifiedMissingQuoteCount: number;
  readonly quotePresentButImpactMissingCount: number;
  readonly buyQuoteAvailableCount: number;
  readonly sellQuoteAvailableCount: number;
  readonly roundTripQuoteAvailableCount: number;
  readonly buyPriceImpactAvailableCount: number;
  readonly sellPriceImpactAvailableCount: number;
  readonly roundTripImpactAvailableCount: number;
  readonly categoryCounts: Readonly<Record<ResearchTruthingMissingQuoteCategory, number>>;
  readonly explanationConfidenceCounts: Readonly<
    Record<ResearchTruthingQuoteExplanationConfidence, number>
  >;
  readonly providerCounts: Readonly<Record<string, number>>;
  readonly sourceTypeCounts: Readonly<Record<string, number>>;
  readonly failureReasonCounts: Readonly<Record<string, number>>;
  readonly exampleRows: readonly ResearchTruthingQuoteEvidenceRow[];
  readonly notes: readonly string[];
}

export interface ResearchTruthingQuoteEvidenceRow {
  readonly runLabel: string;
  readonly decisionId: string;
  readonly mintAddress: string;
  readonly symbol?: string;
  readonly decision: StrategyDecision;
  readonly score: number | null;
  readonly missingQuote: boolean;
  readonly missingPriceImpact: boolean;
  readonly buyQuoteAvailable: boolean;
  readonly sellQuoteAvailable: boolean;
  readonly roundTripQuoteAvailable: boolean;
  readonly buyPriceImpactAvailable: boolean;
  readonly sellPriceImpactAvailable: boolean;
  readonly roundTripImpactAvailable: boolean;
  readonly buyQuoteProvider?: string;
  readonly sellQuoteProvider?: string;
  readonly buyQuoteSourceType?: string;
  readonly sellQuoteSourceType?: string;
  readonly buyQuoteFailureReason?: string;
  readonly sellQuoteFailureReason?: string;
  readonly quotePresentButImpactMissing: boolean;
  readonly missingQuoteCategory: ResearchTruthingMissingQuoteCategory;
  readonly missingQuoteExplanationConfidence: ResearchTruthingQuoteExplanationConfidence;
  readonly missingQuoteExplanation: string;
}

export type ResearchTruthingOutcomeComparisonStatus =
  | "SUFFICIENT"
  | "LOW_COVERAGE"
  | "NOT_COMPARABLE";

export interface ResearchTruthingOutcomeSummary {
  readonly label: string;
  readonly count: number;
  readonly uniqueMints: number;
  readonly observedCount: number;
  readonly observedCoveragePct: number;
  readonly outcomeComparisonStatus: ResearchTruthingOutcomeComparisonStatus;
  readonly averageScore?: number;
  readonly averageBestReturnPct?: number;
  readonly averageWorstReturnPct?: number;
}

export interface ResearchTruthingBirdeyeSummary {
  readonly totalRows: number;
  readonly liveCalls: number;
  readonly livePriceCalls: number;
  readonly liveOverviewCalls: number;
  readonly cacheHits: number;
  readonly cachedPriceRows: number;
  readonly cachedOverviewRows: number;
  readonly estimatedCuTotal: number;
  readonly estimatedCuByEndpoint: Readonly<Record<string, number>>;
  readonly reportedCumulativeCuByRun: Readonly<Record<string, number>>;
  readonly endpointCounts: Readonly<Record<string, number>>;
  readonly selectionReasonCounts: Readonly<Record<string, number>>;
  readonly cacheStatusCounts: Readonly<Record<string, number>>;
  readonly failureCounts: Readonly<Record<string, number>>;
  readonly budgetSkipCount: number;
  readonly budgetSkippedPriceRows: number;
  readonly budgetSkippedOverviewRows: number;
  readonly providerFailureCount: number;
  readonly uniqueEnrichedMints: number;
  readonly enrichedCohort: ResearchTruthingOutcomeSummary;
  readonly eligibleControlCohort: ResearchTruthingOutcomeSummary;
  readonly notEligibleCohort: ResearchTruthingOutcomeSummary;
  readonly notes: readonly string[];
}

export interface ResearchTruthingConcentrationSummary {
  readonly totalRunGroups: number;
  readonly totalMintGroups: number;
  readonly byRun: readonly ResearchTruthingConcentrationRow[];
  readonly byMint: readonly ResearchTruthingConcentrationRow[];
  readonly leaveOneRunOut: readonly ResearchTruthingLeaveOneOutRow[];
  readonly leaveOneMintOut: readonly ResearchTruthingLeaveOneOutRow[];
  readonly notes: readonly string[];
}

export interface ResearchTruthingConcentrationRow {
  readonly key: string;
  readonly label?: string;
  readonly decisionCount: number;
  readonly observedCount: number;
  readonly targetFirstWins: number;
  readonly shareOfObservedPct: number;
  readonly shareOfTargetFirstWinsPct: number;
  readonly averageBestReturnPct?: number;
  readonly averageWorstReturnPct?: number;
}

export interface ResearchTruthingLeaveOneOutRow {
  readonly omittedKey: string;
  readonly omittedLabel?: string;
  readonly remainingDecisionCount: number;
  readonly remainingUniqueMints: number;
  readonly remainingObservedCount: number;
  readonly averageBestReturnPct?: number;
  readonly averageWorstReturnPct?: number;
  readonly quoteMissingPct: number;
  readonly targetFirstWins: number;
}

export interface ResearchTruthingBlockerAudit {
  readonly skipWithNoBlockers: number;
  readonly scoreThresholdOnly: number;
  readonly unresolvedStrategyGate: number;
  readonly insufficientArchiveEvidence: number;
  readonly highScoringSkips: number;
  readonly riskPassSkips: number;
  readonly quoteAvailableImpactMissing: number;
  readonly thresholdSourceCounts: Readonly<Record<string, number>>;
  readonly examples: readonly ResearchTruthingBlockerAuditRow[];
}

export interface ResearchTruthingStrategyThresholds {
  readonly watchScoreThreshold: number;
  readonly buyScoreThreshold: number;
  readonly source: "ARCHIVED_SESSION" | "CURRENT_DEFAULT";
}

export interface ResearchTruthingBlockerAuditRow {
  readonly runLabel: string;
  readonly decisionId: string;
  readonly mintAddress: string;
  readonly symbol?: string;
  readonly decision: StrategyDecision;
  readonly score: number | null;
  readonly watchScoreThreshold: number;
  readonly buyScoreThreshold: number;
  readonly thresholdSource: ResearchTruthingStrategyThresholds["source"];
  readonly classification:
    | "SCORE_THRESHOLD_ONLY"
    | "UNRESOLVED_STRATEGY_GATE"
    | "INSUFFICIENT_ARCHIVE_EVIDENCE";
  readonly reason: string;
}

export interface ResearchTruthingScenarioPortfolioAudit {
  readonly rows: readonly ResearchTruthingScenarioPortfolioRow[];
  readonly notes: readonly string[];
}

export interface ResearchTruthingScenarioPortfolioRow {
  readonly targetPct: number;
  readonly stopPct: number;
  readonly maxHoldMinutes: number;
  readonly entriesConsidered: number;
  readonly uniqueMints: number;
  readonly targetFirstCount: number;
  readonly drawdownFirstCount: number;
  readonly neitherCount: number;
  readonly ambiguousCount: number;
  readonly unobservedCount: number;
  readonly averageExitReturnPct?: number;
  readonly truncated: boolean;
}

export interface ResearchTruthingRecommendation {
  readonly recommendationCode: "A" | "B" | "C" | "D" | "E";
  readonly label: string;
  readonly selected: boolean;
  readonly evidenceFor: readonly string[];
  readonly evidenceAgainst: readonly string[];
  readonly requiredNextAction: string;
  readonly safetyCaveat: string;
}

export interface ResearchTruthingDecisionRow {
  readonly runLabel: string;
  readonly sessionId?: string;
  readonly decisionId: string;
  readonly mintAddress: string;
  readonly symbol?: string;
  readonly decision: StrategyDecision;
  readonly score: number | null;
  readonly decidedAtMs: number;
  readonly riskResult?: string;
  readonly tokenRadarStatus?: string;
  readonly liquidityUsd?: number;
  readonly volume5mUsd?: number;
  readonly volume1hUsd?: number;
  readonly ageSeconds?: number;
  readonly observedReturnCoverage: number;
  readonly bestReturnPct?: number;
  readonly worstReturnPct?: number;
  readonly missingQuote: boolean;
  readonly missingPriceImpact: boolean;
  readonly missingAuthorityEvidence: boolean;
  readonly repeatedAttentionStrength: string;
  readonly blockingFactors: readonly string[];
}

export interface ResearchTruthingReport {
  readonly generatedAtMs: number;
  readonly config: {
    readonly runLabels: readonly string[];
    readonly dedupeMode: ResearchTruthingDedupeMode;
    readonly sourceDecisions: readonly StrategyDecision[];
    readonly minScore: number;
    readonly targetPcts: readonly number[];
    readonly stopPcts: readonly number[];
    readonly maxHoldMinutes: readonly number[];
    readonly topLimit: number;
    readonly marketWindowMinutes: number;
  };
  readonly safety: {
    readonly mode: "PAPER research";
    readonly databaseAccess: "read-only archived runs";
    readonly liveProviderCalls: false;
    readonly paperBuyAutomation: false;
    readonly walletLoaded: false;
    readonly transactionSigning: false;
    readonly transactionSubmission: false;
    readonly passed: boolean;
  };
  readonly archives: readonly ResearchTruthingArchiveReference[];
  readonly archiveCounts: readonly ResearchTruthingArchiveCounts[];
  readonly reportLimitAudit: readonly ResearchTruthingLimitMetadata[];
  readonly decisionTruthTable: {
    readonly rowsAvailable: number;
    readonly rowsEvaluated: number;
    readonly rowsDisplayed: number;
    readonly displayLimit: number;
    readonly displayTruncated: boolean;
    readonly omittedDisplayRows: number;
    readonly consideredDefinition: string;
    readonly dedupeMode: ResearchTruthingDedupeMode;
    readonly rows: readonly ResearchTruthingDecisionRow[];
  };
  readonly quoteEvidence: ResearchTruthingQuoteEvidenceSummary;
  readonly birdeyeAttribution: ResearchTruthingBirdeyeSummary;
  readonly providerReclassification: readonly ResearchTruthingProviderReclassification[];
  readonly concentration: ResearchTruthingConcentrationSummary;
  readonly blockerAudit: ResearchTruthingBlockerAudit;
  readonly scenarioPortfolioAudit: ResearchTruthingScenarioPortfolioAudit;
  readonly findings: readonly string[];
  readonly recommendations: readonly ResearchTruthingRecommendation[];
}

export interface ResearchTruthingCandidateInput {
  readonly candidates: readonly ResearchInterpretationCandidate[];
}
