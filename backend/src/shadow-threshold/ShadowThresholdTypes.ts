import type { ReturnPoint, ScoreAttribution } from "../calibration/CalibrationTypes.js";
import type { StrategyDecision } from "../db/schema/index.js";
import type {
  ResearchArchiveMetadata,
  ResearchRunSourceConfig,
} from "../research/ResearchAggregateTypes.js";

export const shadowThresholdProfile = {
  id: "T65N",
  version: "v1",
  key: "T65N@v1",
  label: "narrow_score65_shadow",
} as const;

export type ShadowThresholdClassification =
  | "SELECTED"
  | "NOT_SCORE_BAND"
  | "NOT_BASELINE_SKIP"
  | "THRESHOLD_SNAPSHOT_MISMATCH"
  | "MISSING_OR_INVALID_SCORE_SNAPSHOT"
  | "HARD_GATE_BLOCKED"
  | "MISSING_QUOTE_OR_PRICE_IMPACT"
  | "DUPLICATE_ATTENTION_SUPPRESSED"
  | "NO_FORWARD_OBSERVATION";

export type ShadowThresholdRaceOutcome =
  | "TARGET_FIRST"
  | "STOP_FIRST"
  | "AMBIGUOUS"
  | "NEITHER"
  | "NO_OBSERVATION";

export type ShadowThresholdRecommendation =
  | "REJECT_NARROW_THRESHOLD"
  | "COLLECT_MORE_INDEPENDENT_DATA"
  | "CONTINUE_SHADOW_RESEARCH"
  | "PREPARE_SEPARATE_PROMOTION_REVIEW";

export interface ShadowThresholdRuntimeConfig {
  readonly once: boolean;
  readonly json: boolean;
  readonly runSources: readonly ResearchRunSourceConfig[];
  readonly outputDir?: string;
}

export interface ShadowThresholdSourceRow {
  readonly profileId: "T65N";
  readonly profileVersion: "v1";
  readonly profileKey: "T65N@v1";
  readonly runLabel: string;
  readonly decisionId: string;
  readonly mintAddress: string;
  readonly symbol?: string;
  readonly decidedAtMs: number;
  readonly decision: StrategyDecision;
  readonly reason: string;
  readonly score: number | null;
  readonly attribution: ScoreAttribution;
  readonly observedPoints: readonly ReturnPoint[];
  readonly repeatedAttentionCount: number;
  readonly repeatedAttentionStrength: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  readonly classification: ShadowThresholdClassification;
  readonly classificationReason: string;
}

export interface ShadowThresholdSelectedCandidate extends ShadowThresholdSourceRow {
  readonly selectedAtDecisionTime: true;
  readonly outcomes: readonly ShadowThresholdHorizonOutcome[];
}

export interface ShadowThresholdHorizonOutcome {
  readonly maxHoldMinutes: number;
  readonly observedPointCount: number;
  readonly hasExactHorizonObservation: boolean;
  readonly mfePct?: number;
  readonly maePct?: number;
  readonly averageReturnPct?: number;
  readonly medianReturnPct?: number;
  readonly races: readonly ShadowThresholdRace[];
}

export interface ShadowThresholdRace {
  readonly targetPct: number;
  readonly stopPct: number;
  readonly outcome: ShadowThresholdRaceOutcome;
  readonly targetHorizonMinutes?: number;
  readonly stopHorizonMinutes?: number;
}

export interface ShadowThresholdScenarioSummary {
  readonly targetPct: number;
  readonly stopPct: number;
  readonly maxHoldMinutes: number;
  readonly candidateCount: number;
  readonly observedCount: number;
  readonly targetFirstCount: number;
  readonly stopFirstCount: number;
  readonly ambiguousCount: number;
  readonly neitherCount: number;
  readonly noObservationCount: number;
  readonly targetFirstRatePct: number;
  readonly stopFirstRatePct: number;
  readonly averageMfePct?: number;
  readonly medianMfePct?: number;
  readonly averageMaePct?: number;
  readonly medianMaePct?: number;
  readonly averageReturnPct?: number;
  readonly medianReturnPct?: number;
}

export interface ShadowThresholdRunSummary {
  readonly label: string;
  readonly mechanicallyValid: boolean;
  readonly sourceDecisionCount: number;
  readonly selectedCount: number;
  readonly selectedObservedCount: number;
  readonly uniqueSelectedMints: number;
  readonly orderCount: number;
  readonly fillCount: number;
  readonly positionCount: number;
  readonly warnings: readonly string[];
}

export interface ShadowThresholdControlSummary {
  readonly classification: ShadowThresholdClassification;
  readonly count: number;
  readonly observedCount: number;
  readonly uniqueMints: number;
  readonly averageBestReturnPct?: number;
  readonly averageWorstReturnPct?: number;
}

export interface ShadowThresholdConcentrationSummary {
  readonly maxSelectedMintSharePct: number;
  readonly maxSelectedRunSharePct: number;
  readonly maxTargetFirstMintSharePct: number;
  readonly maxTargetFirstRunSharePct: number;
  readonly leaveOneRunOutStable: boolean;
  readonly leaveOneMintOutStable: boolean;
}

export interface ShadowThresholdSampleQuality {
  readonly validArchiveCount: number;
  readonly selectedCount: number;
  readonly selectedWith60mObservationCount: number;
  readonly uniqueSelectedMintCount: number;
  readonly runsWithSelectedCandidateCount: number;
  readonly sampleGatePassed: boolean;
  readonly failedRequirements: readonly string[];
}

export interface ShadowThresholdReport {
  readonly generatedAtMs: number;
  readonly config: {
    readonly profileId: string;
    readonly profileVersion: string;
    readonly profileKey: string;
    readonly sourceDecision: "SKIP";
    readonly scoreMin: 65;
    readonly scoreMax: 69;
    readonly originalBuyScoreThreshold: 90;
    readonly originalWatchScoreThreshold: 70;
    readonly targetPcts: readonly [10, 15, 25];
    readonly stopPcts: readonly [10, 15, 25];
    readonly maxHoldMinutes: readonly [15, 30, 60];
    readonly selectionMode: "FIRST_ELIGIBLE_PER_MINT_PER_RUN";
  };
  readonly archives: readonly ResearchArchiveMetadata[];
  readonly safety: {
    readonly databaseAccess: "READ_ONLY_ARCHIVES";
    readonly providerCalls: false;
    readonly databaseWrites: false;
    readonly sessionCreation: false;
    readonly strategyDefaultsChanged: false;
    readonly paperExecution: false;
    readonly walletLoaded: false;
    readonly transactionSigning: false;
    readonly transactionSubmission: false;
  };
  readonly runs: readonly ShadowThresholdRunSummary[];
  readonly aggregate: {
    readonly sourceDecisionCount: number;
    readonly scoreBandCount: number;
    readonly thresholdOnlyEligibleCount: number;
    readonly selectedCount: number;
    readonly selectedObservedCount: number;
    readonly selectedWith60mObservationCount: number;
    readonly uniqueSelectedMintCount: number;
    readonly runsWithSelectedCandidateCount: number;
    readonly classificationCounts: Readonly<Record<ShadowThresholdClassification, number>>;
    readonly orderCount: number;
    readonly fillCount: number;
    readonly positionCount: number;
  };
  readonly selectedCandidates: readonly ShadowThresholdSelectedCandidate[];
  readonly controls: readonly ShadowThresholdControlSummary[];
  readonly scenarios: readonly ShadowThresholdScenarioSummary[];
  readonly concentration: ShadowThresholdConcentrationSummary;
  readonly sampleQuality: ShadowThresholdSampleQuality;
  readonly recommendation: ShadowThresholdRecommendation;
  readonly recommendationReason: string;
  readonly limitations: readonly string[];
}
