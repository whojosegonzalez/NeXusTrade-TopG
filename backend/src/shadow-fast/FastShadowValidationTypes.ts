import type {
  ResearchArchiveMetadata,
  ResearchRunSourceConfig,
} from "../research/ResearchAggregateTypes.js";
import type { FastShadowClassification } from "./FastShadowTypes.js";

export type FastShadowExitOutcome =
  | "TARGET_FIRST"
  | "STOP_FIRST"
  | "MAX_HOLD"
  | "NO_OBSERVATION"
  | "AMBIGUOUS";

export type FastShadowRecommendation =
  | "REJECT_FAST_EXIT_PROFILE"
  | "COLLECT_MORE_INDEPENDENT_DATA"
  | "CONTINUE_SHADOW_RESEARCH"
  | "PREPARE_SEPARATE_PROMOTION_REVIEW";

export interface FastShadowValidationRuntimeConfig {
  readonly once: boolean;
  readonly json: boolean;
  readonly runSources: readonly ResearchRunSourceConfig[];
  readonly outputDir?: string;
}

export interface FastShadowScenario {
  readonly name: "PRIMARY" | "SECONDARY_10_10_15" | "SECONDARY_10_15_5" | "SECONDARY_10_10_5";
  readonly targetPct: 10;
  readonly stopPct: 10 | 15;
  readonly maxHoldMinutes: 5 | 15;
}

export interface FastShadowCoverageSummary {
  readonly horizonMinutes: 3 | 5 | 15;
  readonly exactOnTimeCount: number;
  readonly lateCount: number;
  readonly missingCount: number;
}

export interface FastShadowScenarioSummary {
  readonly scenario: FastShadowScenario;
  readonly candidateCount: number;
  readonly evaluableCount: number;
  readonly targetFirstCount: number;
  readonly stopFirstCount: number;
  readonly maxHoldCount: number;
  readonly noObservationCount: number;
  readonly ambiguousCount: number;
  readonly targetFirstRatePct: number;
  readonly stopFirstRatePct: number;
  readonly averageMfePct?: number;
  readonly medianMfePct?: number;
  readonly averageMaePct?: number;
  readonly medianMaePct?: number;
  readonly averageExitReturnPct?: number;
  readonly medianExitReturnPct?: number;
}

export interface FastShadowCandidateOutcome {
  readonly runLabel: string;
  readonly decisionId: string;
  readonly mintAddress: string;
  readonly symbol?: string;
  readonly score: number | null;
  readonly decidedAtMs: number;
  readonly classification: FastShadowClassification;
  readonly classificationReason: string;
  readonly coverage: readonly FastShadowCoverageSummary[];
  readonly outcomes: readonly {
    readonly scenario: FastShadowScenario;
    readonly outcome: FastShadowExitOutcome;
    readonly mfePct?: number;
    readonly maePct?: number;
    readonly exitReturnPct?: number;
  }[];
}

export interface FastShadowValidationReport {
  readonly generatedAtMs: number;
  readonly profile: {
    readonly id: "F65E";
    readonly version: "v1";
    readonly key: "F65E@v1";
    readonly sourceDecision: "SKIP";
    readonly scoreRange: "65-69";
    readonly observationHorizonsMinutes: readonly [3, 5, 15];
    readonly maxLateMinutes: 2;
    readonly selectionMode: "FIRST_ELIGIBLE_PER_MINT_PER_RUN_CAP_10";
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
  readonly runs: readonly {
    readonly label: string;
    readonly mechanicallyValid: boolean;
    readonly selectedCount: number;
    readonly selectedWith15mCoverageCount: number;
    readonly orderCount: number;
    readonly fillCount: number;
    readonly positionCount: number;
    readonly warnings: readonly string[];
  }[];
  readonly aggregate: {
    readonly selectedCount: number;
    readonly selectedWith15mCoverageCount: number;
    readonly uniqueMintCount: number;
    readonly classificationCounts: Readonly<Record<FastShadowClassification, number>>;
    readonly coverage: readonly FastShadowCoverageSummary[];
    readonly orderCount: number;
    readonly fillCount: number;
    readonly positionCount: number;
  };
  readonly controls: readonly {
    readonly classification: FastShadowClassification;
    readonly count: number;
  }[];
  readonly scenarios: readonly FastShadowScenarioSummary[];
  readonly concentration: {
    readonly maxSelectedMintSharePct: number;
    readonly maxSelectedRunSharePct: number;
    readonly maxPrimaryWinnerMintSharePct: number;
    readonly maxPrimaryWinnerRunSharePct: number;
    readonly leaveOneMintOutStable: boolean;
    readonly leaveOneRunOutStable: boolean;
  };
  readonly sampleQuality: {
    readonly passed: boolean;
    readonly failedRequirements: readonly string[];
  };
  readonly recommendation: FastShadowRecommendation;
  readonly recommendationReason: string;
  readonly candidates: readonly FastShadowCandidateOutcome[];
  readonly limitations: readonly string[];
}
