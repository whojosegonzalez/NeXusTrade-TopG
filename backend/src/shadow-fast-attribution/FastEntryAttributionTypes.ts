import type { ResearchRunSourceConfig } from "../research/ResearchAggregateTypes.js";
import type { FastShadowClassification } from "../shadow-fast/FastShadowTypes.js";

export type FastEntryPrimaryLabel =
  | "TARGET_FIRST"
  | "STOP_FIRST"
  | "MAX_HOLD"
  | "NO_OBSERVATION"
  | "AMBIGUOUS";

export type FastEntryAttributionRecommendation =
  | "NO_DEFENSIBLE_HYPOTHESIS"
  | "PRE_REGISTER_SUCCESSOR_HYPOTHESIS";

export type FastEntryFeatureValue = string | number | boolean | readonly string[];

export interface FastEntryAttributionRuntimeConfig {
  readonly once: boolean;
  readonly json: boolean;
  readonly runSources: readonly ResearchRunSourceConfig[];
  readonly outputDir?: string;
}

export interface FastEntryFeatureSource {
  readonly kind:
    | "DECISION_SNAPSHOT"
    | "ARCHIVED_RISK"
    | "ARCHIVED_TOKEN_RADAR"
    | "DERIVED_PRE_DECISION";
  readonly path: string;
  readonly timestampMs?: number;
  readonly availability: "AVAILABLE_AT_DECISION_TIME" | "UNAVAILABLE_AT_DECISION_TIME";
  readonly unavailableReason?: string;
}

export interface FastEntryFeature {
  readonly key: string;
  readonly family:
    | "SCORE_ATTRIBUTION"
    | "RISK"
    | "MARKET_SNAPSHOT"
    | "MOMENTUM"
    | "QUOTE_AND_IMPACT"
    | "PROVIDER_PROVENANCE"
    | "REPEATED_ATTENTION";
  readonly value?: FastEntryFeatureValue;
  readonly source: FastEntryFeatureSource;
}

export interface FastEntryCandidateAttribution {
  readonly runLabel: string;
  readonly decisionId: string;
  readonly mintAddress: string;
  readonly symbol?: string;
  readonly decidedAtMs: number;
  readonly classification: FastShadowClassification;
  readonly classificationReason: string;
  readonly primaryLabel: FastEntryPrimaryLabel;
  readonly exactCoverage: readonly {
    readonly horizonMinutes: 3 | 5 | 15;
    readonly onTime: boolean;
  }[];
  readonly features: readonly FastEntryFeature[];
}

export interface FastEntryFeatureLabelSummary {
  readonly label: FastEntryPrimaryLabel;
  readonly candidateCount: number;
  readonly availableCount: number;
  readonly unavailableCount: number;
  readonly values: readonly FastEntryFeatureValue[];
}

export interface FastEntryFeatureSummary {
  readonly key: string;
  readonly family: FastEntryFeature["family"];
  readonly candidateCount: number;
  readonly availableCount: number;
  readonly unavailableCount: number;
  readonly hasVariation: boolean;
  readonly byLabel: readonly FastEntryFeatureLabelSummary[];
}

export interface FastEntryAttributionGate {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface FastEntryArchiveSummary {
  readonly label: string;
  readonly inputPath: string;
  readonly warnings: readonly string[];
}

export interface RegisteredFastEntryHypothesis {
  readonly profileId: string;
  readonly version: string;
  readonly featureKey: string;
  readonly expectedValue: FastEntryFeatureValue;
  readonly rationale: string;
}

export interface FastEntryAttributionReport {
  readonly generatedAtMs: number;
  readonly profile: {
    readonly sourceProfileKey: "F65E@v1";
    readonly analysisKey: "F65E_ATTRIBUTION@v1";
    readonly sourceDecision: "SKIP";
    readonly originalBuyScoreThreshold: 90;
    readonly originalWatchScoreThreshold: 70;
    readonly observationHorizonsMinutes: readonly [3, 5, 15];
    readonly primaryScenario: {
      readonly targetPct: 10;
      readonly stopPct: 15;
      readonly maxHoldMinutes: 15;
    };
  };
  readonly archives: readonly FastEntryArchiveSummary[];
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
  readonly runs: readonly {
    readonly label: string;
    readonly mechanicallyValid: boolean;
    readonly selectedCount: number;
    readonly labelCounts: Readonly<Record<FastEntryPrimaryLabel, number>>;
    readonly orderCount: number;
    readonly fillCount: number;
    readonly positionCount: number;
    readonly warnings: readonly string[];
  }[];
  readonly aggregate: {
    readonly selectedCount: number;
    readonly exactCoverageCount: number;
    readonly labelCounts: Readonly<Record<FastEntryPrimaryLabel, number>>;
    readonly selectedRunSharesPct: Readonly<Record<string, number>>;
    readonly targetRunSharesPct: Readonly<Record<string, number>>;
    readonly nonTargetRunSharesPct: Readonly<Record<string, number>>;
  };
  readonly featureSummaries: readonly FastEntryFeatureSummary[];
  readonly gates: readonly FastEntryAttributionGate[];
  readonly recommendation: FastEntryAttributionRecommendation;
  readonly recommendationReason: string;
  readonly successor?: RegisteredFastEntryHypothesis & {
    readonly collectionContract: readonly string[];
    readonly promotionGates: readonly string[];
  };
  readonly candidates: readonly FastEntryCandidateAttribution[];
  readonly limitations: readonly string[];
}
