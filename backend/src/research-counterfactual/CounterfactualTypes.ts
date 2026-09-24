import type { ReturnPoint, ScoreAttribution } from "../calibration/CalibrationTypes.js";
import type { StrategyDecision } from "../db/schema/index.js";
import type { ResearchArchiveMetadata } from "../research/ResearchAggregateTypes.js";

export type CounterfactualDedupeMode = "decision" | "mint" | "first_per_mint" | "best_per_mint";

export type CounterfactualScenarioSet = "default" | "thresholds" | "gates" | "policies";

export type CounterfactualScenarioId =
  | "SCORE_THRESHOLD_75_70"
  | "SCORE_THRESHOLD_65_60"
  | "DUPLICATE_BUY_DISABLED"
  | "MAX_BUY_CAP_DISABLED"
  | "RISK_ELIGIBILITY_OVERRIDE"
  | "LIQUIDITY_GATE_OVERRIDE"
  | "VOLUME_GATE_OVERRIDE"
  | "PAIR_AGE_GATE_OVERRIDE"
  | "PRICE_IMPACT_GATE_OVERRIDE";

export type CounterfactualReplayFidelity =
  | "REPRODUCED"
  | "PARTIALLY_REPRODUCED"
  | "MISMATCH"
  | "NOT_REPLAYABLE";

export type CounterfactualEvidenceQuality = "DIRECT" | "GATE_OVERRIDE" | "NOT_EVALUABLE";

export type CounterfactualOutcome =
  | "UNCHANGED"
  | "PROMOTED_TO_WATCH"
  | "PROMOTED_TO_BUY"
  | "DEMOTED_TO_SKIP"
  | "BLOCKED_BY_ANOTHER_GATE"
  | "NOT_EVALUABLE";

export interface CounterfactualRunSourceConfig {
  readonly label: string;
  readonly path: string;
}

export interface CounterfactualRuntimeConfig {
  readonly once: boolean;
  readonly json: boolean;
  readonly runSources: readonly CounterfactualRunSourceConfig[];
  readonly outputDir?: string;
  readonly minScore: number;
  readonly sourceDecisions: readonly StrategyDecision[];
  readonly targetPcts: readonly number[];
  readonly stopPcts: readonly number[];
  readonly maxHoldMinutes: readonly number[];
  readonly dedupeMode: CounterfactualDedupeMode;
  readonly scenarioSet: CounterfactualScenarioSet;
  readonly scenarioIds: readonly CounterfactualScenarioId[];
  readonly topResults: number;
}

export interface CounterfactualCandidate {
  readonly runLabel: string;
  readonly decisionId: string;
  readonly mintAddress: string;
  readonly symbol?: string;
  readonly decidedAtMs: number;
  readonly decision: StrategyDecision;
  readonly score: number | null;
  readonly attribution: ScoreAttribution;
  readonly observedPoints: readonly ReturnPoint[];
  readonly bestReturnPct?: number;
  readonly worstReturnPct?: number;
}

export interface CounterfactualScenarioDefinition {
  readonly id: CounterfactualScenarioId;
  readonly label: string;
  readonly category: "thresholds" | "gates" | "policies";
  readonly description: string;
}

export interface CounterfactualReplayResult {
  readonly fidelity: CounterfactualReplayFidelity;
  readonly baselineDecision?: StrategyDecision;
  readonly baselineRawDecision?: StrategyDecision;
  readonly baselineBuyEligible?: boolean;
  readonly warnings: readonly string[];
}

export interface CounterfactualScenarioResult {
  readonly scenarioId: CounterfactualScenarioId;
  readonly scenarioLabel: string;
  readonly category: "thresholds" | "gates" | "policies";
  readonly evidenceQuality: CounterfactualEvidenceQuality;
  readonly outcome: CounterfactualOutcome;
  readonly baselineDecision: StrategyDecision;
  readonly counterfactualDecision?: StrategyDecision;
  readonly score?: number;
  readonly changedInput: string;
  readonly remainingBlockers: readonly string[];
  readonly notes: readonly string[];
}

export interface CounterfactualCandidateAnalysis {
  readonly candidate: CounterfactualCandidate;
  readonly baseline: CounterfactualReplayResult;
  readonly scenarios: readonly CounterfactualScenarioResult[];
}

export interface CounterfactualScenarioSummary {
  readonly scenarioId: CounterfactualScenarioId;
  readonly scenarioLabel: string;
  readonly category: "thresholds" | "gates" | "policies";
  readonly evaluatedCount: number;
  readonly uniqueMintCount: number;
  readonly outcomeCounts: Readonly<Record<CounterfactualOutcome, number>>;
  readonly directEvidenceCount: number;
  readonly gateOverrideEvidenceCount: number;
  readonly promotedToWatchCount: number;
  readonly promotedToBuyCount: number;
  readonly observedPromotedCount: number;
  readonly scoreBucketCounts: Readonly<Record<string, number>>;
  readonly targetFirstRates: Readonly<Record<string, number>>;
  readonly drawdownFirstRates: Readonly<Record<string, number>>;
  readonly maxMintPromotionSharePct: number;
  readonly maxRunPromotionSharePct: number;
  readonly averagePromotedBestReturnPct?: number;
  readonly averagePromotedWorstReturnPct?: number;
}

export interface CounterfactualReport {
  readonly generatedAtMs: number;
  readonly config: {
    readonly runLabels: readonly string[];
    readonly catalogVersion: string;
    readonly minScore: number;
    readonly sourceDecisions: readonly StrategyDecision[];
    readonly targetPcts: readonly number[];
    readonly stopPcts: readonly number[];
    readonly maxHoldMinutes: readonly number[];
    readonly dedupeMode: CounterfactualDedupeMode;
    readonly scenarioSet: CounterfactualScenarioSet;
    readonly scenarioIds: readonly CounterfactualScenarioId[];
  };
  readonly archives: readonly ResearchArchiveMetadata[];
  readonly safety: {
    readonly databaseAccess: "READ_ONLY_ARCHIVES";
    readonly providerCalls: false;
    readonly databaseWrites: false;
    readonly sessionCreation: false;
    readonly paperExecution: false;
    readonly walletLoaded: false;
    readonly transactionSigning: false;
    readonly transactionSubmission: false;
  };
  readonly aggregate: {
    readonly candidateCount: number;
    readonly observedCandidateCount: number;
    readonly uniqueMintCount: number;
    readonly fidelityCounts: Readonly<Record<CounterfactualReplayFidelity, number>>;
    readonly orderCount: number;
    readonly fillCount: number;
    readonly positionCount: number;
  };
  readonly scenarios: readonly CounterfactualScenarioDefinition[];
  readonly scenarioSummaries: readonly CounterfactualScenarioSummary[];
  readonly topPromotions: readonly CounterfactualCandidateAnalysis[];
  readonly notReplayable: readonly CounterfactualCandidateAnalysis[];
  readonly recommendation: string;
  readonly limitations: readonly string[];
}
