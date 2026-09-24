import type { ReturnPoint, ScoreAttribution } from "../calibration/CalibrationTypes.js";
import type { StrategyDecision } from "../db/schema/index.js";
import type {
  ResearchArchiveMetadata,
  ResearchProviderPressureSummary,
  ResearchQuoteBudgetSummary,
} from "../research/ResearchAggregateTypes.js";
import type { ShadowEntryRepeatedAttentionStrength } from "../shadow-entry/ShadowEntryTypes.js";

export type ResearchInterpretationDedupeMode =
  | "decision"
  | "mint"
  | "first_per_mint"
  | "best_per_mint";

export type ResearchInterpretationBlockerCategory =
  | "RISK_NOT_PASS"
  | "MISSING_QUOTE"
  | "MISSING_AUTHORITY_EVIDENCE"
  | "MISSING_PRICE_IMPACT"
  | "LOW_LIQUIDITY"
  | "LOW_VOLUME"
  | "PAIR_TOO_NEW"
  | "PRICE_IMPACT_TOO_HIGH"
  | "DUPLICATE_BUY"
  | "MAX_BUY_CAP"
  | "SCORE_BELOW_BUY"
  | "SCORE_BELOW_WATCH"
  | "SCORE_THRESHOLD_ONLY"
  | "UNRESOLVED_STRATEGY_GATE"
  | "UNKNOWN";

export type ResearchInterpretationRecommendationCode = "A" | "B" | "C" | "D" | "E";

export interface ResearchInterpretationRunSourceConfig {
  readonly label: string;
  readonly path: string;
}

export interface ResearchInterpretationRuntimeConfig {
  readonly once: boolean;
  readonly json: boolean;
  readonly runSources: readonly ResearchInterpretationRunSourceConfig[];
  readonly outputDir?: string;
  readonly minScore: number;
  readonly sourceDecisions: readonly StrategyDecision[];
  readonly targetPcts: readonly number[];
  readonly stopPcts: readonly number[];
  readonly maxHoldMinutes: readonly number[];
  readonly topOpportunities: number;
  readonly topBlockers: number;
  readonly marketWindowMinutes: number;
  readonly scoreBucketSize: number;
  readonly dedupeMode: ResearchInterpretationDedupeMode;
}

export interface ResearchInterpretationRunValidation {
  readonly label: string;
  readonly runId: string;
  readonly databasePath: string;
  readonly safetyStatus: string;
  readonly cycleCount: number;
  readonly terminalSessionId?: string;
  readonly databaseSessionId?: string;
  readonly oneSession: boolean;
  readonly orderCount: number;
  readonly fillCount: number;
  readonly positionCount: number;
  readonly warnings: readonly string[];
}

export interface ResearchInterpretationScoreFactor {
  readonly ruleName: string;
  readonly points: number;
  readonly passed: boolean;
  readonly reason?: string;
  readonly warnings: readonly string[];
}

export interface ResearchInterpretationTargetStopOutcome {
  readonly targetPct: number;
  readonly stopPct: number;
  readonly ordering: "TARGET_FIRST" | "STOP_FIRST" | "AMBIGUOUS" | "NEITHER";
  readonly targetHorizonMinutes?: number;
  readonly stopHorizonMinutes?: number;
}

export interface ResearchInterpretationCandidate {
  readonly runLabel: string;
  readonly sessionId?: string;
  readonly decisionId: string;
  readonly mintAddress: string;
  readonly symbol?: string;
  readonly decidedAtMs: number;
  readonly decision: StrategyDecision;
  readonly score: number | null;
  readonly rawDecision?: StrategyDecision;
  readonly buyEligible: boolean;
  readonly duplicateBuyBlocked: boolean;
  readonly maxBuyCapBlocked: boolean;
  readonly riskResult?: string;
  readonly riskFlags: readonly string[];
  readonly missingQuote: boolean;
  readonly missingAuthorityEvidence: boolean;
  readonly missingPriceImpact: boolean;
  readonly liquidityUsd?: number;
  readonly volume5mUsd?: number;
  readonly volume1hUsd?: number;
  readonly ageSeconds?: number;
  readonly maxPriceImpactPct?: number;
  readonly scoreFactors: readonly ResearchInterpretationScoreFactor[];
  readonly blockingFactors: readonly string[];
  readonly observedPoints: readonly ReturnPoint[];
  readonly bestReturnPct?: number;
  readonly worstReturnPct?: number;
  readonly targetStopOutcomes: readonly ResearchInterpretationTargetStopOutcome[];
  readonly repeatedAttentionStrength: ShadowEntryRepeatedAttentionStrength;
  readonly repeatedAttentionReasons: readonly string[];
  readonly repeatedAttentionSourceCount: number;
  readonly firstAttentionAtMs?: number;
  readonly lastAttentionAtMs?: number;
  readonly timeBetweenAttentionSignalsMinutes?: number;
  readonly attribution: ScoreAttribution;
}

export interface ResearchDecisionAttribution {
  readonly decisionId: string;
  readonly mintAddress: string;
  readonly symbol?: string;
  readonly decision: StrategyDecision;
  readonly score: number | null;
  readonly riskResult?: string;
  readonly positiveFactors: readonly ResearchInterpretationScoreFactor[];
  readonly neutralOrNegativeFactors: readonly ResearchInterpretationScoreFactor[];
  readonly warnings: readonly string[];
  readonly blockerCategories: readonly ResearchInterpretationBlockerCategory[];
  readonly firstBlockingFactor: ResearchInterpretationBlockerCategory;
  readonly highestImpactBlockingFactor: ResearchInterpretationBlockerCategory;
  readonly explanation: string;
}

export interface ResearchGroupedOutcomeSummary {
  readonly label: string;
  readonly count: number;
  readonly uniqueMints: number;
  readonly observedCount: number;
  readonly averageScore?: number;
  readonly averageBestReturnPct?: number;
  readonly averageWorstReturnPct?: number;
  readonly targetHitRates: Readonly<Record<string, number>>;
  readonly drawdownFirstRates: Readonly<Record<string, number>>;
  readonly exampleMints: readonly string[];
}

export interface ResearchBlockerSummary extends ResearchGroupedOutcomeSummary {
  readonly blocker: ResearchInterpretationBlockerCategory;
  readonly decisionCounts: Readonly<Record<string, number>>;
}

export interface ResearchOpportunityRow {
  readonly runLabel: string;
  readonly decisionId: string;
  readonly mintAddress: string;
  readonly symbol?: string;
  readonly decision: StrategyDecision;
  readonly score: number | null;
  readonly decidedAtMs: number;
  readonly primaryBlocker: ResearchInterpretationBlockerCategory;
  readonly highestImpactBlocker: ResearchInterpretationBlockerCategory;
  readonly bestReturnPct?: number;
  readonly worstReturnPct?: number;
  readonly riskResult?: string;
  readonly missingQuote: boolean;
  readonly repeatedAttentionStrength: ShadowEntryRepeatedAttentionStrength;
  readonly liquidityUsd?: number;
  readonly volume1hUsd?: number;
  readonly ageSeconds?: number;
}

export interface ResearchTokenSummary {
  readonly mintAddress: string;
  readonly symbol?: string;
  readonly decisionCount: number;
  readonly runs: readonly string[];
  readonly firstDecision: StrategyDecision;
  readonly latestDecision: StrategyDecision;
  readonly highestScore: number | null;
  readonly bestReturnPct?: number;
  readonly worstReturnPct?: number;
  readonly repeatedAttentionStrength: ShadowEntryRepeatedAttentionStrength;
  readonly primaryBlockersSeen: readonly ResearchInterpretationBlockerCategory[];
}

export interface ResearchMarketWindowSummary {
  readonly runLabel: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly decisionCount: number;
  readonly uniqueMints: number;
  readonly targetFirstWins: number;
  readonly averageBestReturnPct?: number;
  readonly averageWorstReturnPct?: number;
}

export interface ResearchProviderInterpretation {
  readonly providers: readonly ResearchProviderPressureSummary[];
  readonly quoteBudget: ResearchQuoteBudgetSummary;
  readonly missingQuote: ResearchGroupedOutcomeSummary;
  readonly quoteAvailable: ResearchGroupedOutcomeSummary;
  readonly notes: readonly string[];
}

export interface ResearchRecommendationMatrixRow {
  readonly recommendationCode: ResearchInterpretationRecommendationCode;
  readonly label: string;
  readonly selected: boolean;
  readonly evidenceFor: readonly string[];
  readonly evidenceAgainst: readonly string[];
  readonly requiredNextAction: string;
  readonly safetyCaveat: string;
}

export interface ResearchInterpretationReport {
  readonly generatedAtMs: number;
  readonly config: {
    readonly runLabels: readonly string[];
    readonly minScore: number;
    readonly sourceDecisions: readonly StrategyDecision[];
    readonly targetPcts: readonly number[];
    readonly stopPcts: readonly number[];
    readonly maxHoldMinutes: readonly number[];
    readonly dedupeMode: ResearchInterpretationDedupeMode;
  };
  readonly archives: readonly ResearchArchiveMetadata[];
  readonly runValidations: readonly ResearchInterpretationRunValidation[];
  readonly aggregate: {
    readonly runCount: number;
    readonly observedDecisionCount: number;
    readonly uniqueMintCount: number;
    readonly orderCount: number;
    readonly fillCount: number;
    readonly positionCount: number;
    readonly dedupeMode: ResearchInterpretationDedupeMode;
  };
  readonly candidates: readonly ResearchInterpretationCandidate[];
  readonly decisionAttributions: readonly ResearchDecisionAttribution[];
  readonly blockerSummaries: readonly ResearchBlockerSummary[];
  readonly highScoringSkips: readonly ResearchOpportunityRow[];
  readonly warnOutcomeSummaries: readonly ResearchGroupedOutcomeSummary[];
  readonly missingQuoteAnalysis: ResearchProviderInterpretation;
  readonly marketWindows: readonly ResearchMarketWindowSummary[];
  readonly tokenSummaries: readonly ResearchTokenSummary[];
  readonly recommendationMatrix: readonly ResearchRecommendationMatrixRow[];
}
