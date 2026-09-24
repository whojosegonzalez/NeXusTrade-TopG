import type { ScoreAttribution } from "../calibration/CalibrationTypes.js";
import type { ReturnPoint } from "../calibration/CalibrationTypes.js";
import type { StrategyDecision } from "../db/schema/index.js";
import type {
  ShadowEntryEarlyDrawdownMode,
  ShadowEntryProfileId,
  ShadowEntryRuntimeConfig,
  ShadowEntryTimingMode,
} from "./ShadowEntryConfig.js";

export type ShadowEntryExitReason =
  | "TARGET_HIT"
  | "STOP_HIT"
  | "MAX_HOLD"
  | "NO_OBSERVATION"
  | "AMBIGUOUS";

export type ShadowEntryGateOutcome =
  | "WOULD_ENTER"
  | "WOULD_SKIP"
  | "REJECT_SCORE_BAND"
  | "REJECT_DECISION_TYPE"
  | "REJECT_DUPLICATE_POLICY"
  | "REJECT_QUOTE_POLICY"
  | "REJECT_EARLY_DRAWDOWN"
  | "REJECT_CONFIRMATION_RETURN"
  | "WARN_EARLY_DRAWDOWN"
  | "RECOVERED_AFTER_DRAWDOWN"
  | "FAILED_RECOVERY_AFTER_DRAWDOWN"
  | "WOULD_ENTER_AFTER_RECOVERY"
  | "WOULD_SKIP_RECOVERY_TOO_LATE"
  | "MISSED_FAST_MOVE"
  | "INSUFFICIENT_CONFIRMATION_DATA"
  | "NO_OBSERVED_RETURNS";

export type ShadowEntryReadinessStatus =
  | "NOT_READY"
  | "PROMISING_RESEARCH"
  | "CANDIDATE_FOR_PROMOTION";

export type ShadowEntryDuplicatePolicy = "any" | "duplicate_or_repeated";
export type ShadowEntryQuotePolicy = "evidence_only" | "require_quote";
export type ShadowEntryRepeatedAttentionStrength = "NONE" | "LOW" | "MEDIUM" | "HIGH";
export type ShadowEntryConfidence = "LOW" | "MEDIUM" | "HIGH";
export type ShadowEntrySignalStability = "LOW" | "MEDIUM" | "HIGH";

export interface ShadowEntryProfile {
  readonly id: ShadowEntryProfileId;
  readonly profileVersion: string;
  readonly profileKey: string;
  readonly name: string;
  readonly description: string;
  readonly minScore: number;
  readonly maxScore?: number;
  readonly decisions: readonly StrategyDecision[];
  readonly timingModes: readonly ShadowEntryTimingMode[];
  readonly confirmationRequired: boolean;
  readonly duplicatePolicy: ShadowEntryDuplicatePolicy;
  readonly quotePolicy: ShadowEntryQuotePolicy;
  readonly earlyDrawdownModes: readonly ShadowEntryEarlyDrawdownMode[];
  readonly recoveryOnly: boolean;
  readonly readonlyBaseline: boolean;
}

export interface ShadowEntryCandidate {
  readonly runLabel: string;
  readonly sessionId?: string;
  readonly decisionId: string;
  readonly mintAddress: string;
  readonly decidedAtMs: number;
  readonly decision: StrategyDecision;
  readonly score: number | null;
  readonly symbol?: string;
  readonly attribution: ScoreAttribution;
  readonly observedPoints: readonly ReturnPoint[];
  readonly bestReturnPct?: number;
  readonly worstReturnPct?: number;
  readonly duplicateBuyBlocked: boolean;
  readonly repeatedMintDecision: boolean;
  readonly repeatedAttentionStrength: ShadowEntryRepeatedAttentionStrength;
  readonly repeatedAttentionReasons: readonly string[];
  readonly repeatedAttentionSourceCount: number;
  readonly firstAttentionAtMs?: number;
  readonly lastAttentionAtMs?: number;
  readonly timeBetweenAttentionSignalsMinutes?: number;
  readonly missingQuote: boolean;
}

export interface ShadowEntryScenario {
  readonly targetPct: number;
  readonly stopPct: number;
  readonly maxHoldMinutes: number;
}

export interface ShadowEntryExitOutcome {
  readonly scenario: ShadowEntryScenario;
  readonly exitReason: ShadowEntryExitReason;
  readonly exitReturnPct?: number;
  readonly exitHorizonMinutes?: number;
}

export interface ShadowEntryVariant {
  readonly profile: ShadowEntryProfile;
  readonly timingMode: ShadowEntryTimingMode;
  readonly confirmationHorizonMinutes?: number;
  readonly confirmationMinReturnPct?: number;
  readonly earlyDrawdownMode: ShadowEntryEarlyDrawdownMode;
  readonly recoveryConfirmationReturnPct?: number;
  readonly recoveryWindowMinutes?: number;
}

export interface ShadowEntryCandidateDecision {
  readonly runLabel: string;
  readonly profileId: ShadowEntryProfileId;
  readonly profileVersion: string;
  readonly profileKey: string;
  readonly profileName: string;
  readonly timingMode: ShadowEntryTimingMode;
  readonly decisionId: string;
  readonly mintAddress: string;
  readonly symbol?: string;
  readonly sourceDecision: StrategyDecision;
  readonly score: number | null;
  readonly outcome: ShadowEntryGateOutcome;
  readonly entered: boolean;
  readonly gateReason: string;
  readonly confirmationHorizonMinutes?: number;
  readonly confirmationMinReturnPct?: number;
  readonly earlyDrawdownMode: ShadowEntryEarlyDrawdownMode;
  readonly recoveryConfirmationReturnPct?: number;
  readonly recoveryWindowMinutes?: number;
  readonly entryHorizonMinutes?: number;
  readonly entryReturnPct?: number;
  readonly firstObservedReturnPct?: number;
  readonly bestObservedReturnPct?: number;
  readonly worstObservedReturnPct?: number;
  readonly repeatedAttentionStrength: ShadowEntryRepeatedAttentionStrength;
  readonly repeatedAttentionReasons: readonly string[];
  readonly repeatedAttentionSourceCount: number;
  readonly firstAttentionAtMs?: number;
  readonly lastAttentionAtMs?: number;
  readonly timeBetweenAttentionSignalsMinutes?: number;
  readonly primaryExitOutcome?: ShadowEntryExitOutcome;
}

export interface ShadowEntryRunSummary {
  readonly label: string;
  readonly sourceKind: string;
  readonly sessionId?: string;
  readonly strategyRows: number;
  readonly observedReturnRows: number;
  readonly observedDecisionCount: number;
  readonly uniqueMints: number;
  readonly orderCount: number;
  readonly fillCount: number;
  readonly positionCount: number;
  readonly warnings: readonly string[];
}

export interface ShadowEntryProfileSummary {
  readonly label: string;
  readonly profileId: ShadowEntryProfileId;
  readonly profileVersion: string;
  readonly profileKey: string;
  readonly profileName: string;
  readonly timingMode: ShadowEntryTimingMode;
  readonly consideredCount: number;
  readonly enteredCount: number;
  readonly uniqueMints: number;
  readonly targetFirstRatePct: number;
  readonly stopFirstRatePct: number;
  readonly averageBestReturnPct?: number;
  readonly averageWorstReturnPct?: number;
  readonly medianExitReturnPct?: number;
  readonly missedFastMoveCount: number;
  readonly falsePositiveAvoidedCount: number;
}

export interface ShadowEntryBaselineReproductionSummary {
  readonly applicable: boolean;
  readonly passed: boolean;
  readonly reason: string;
  readonly expected: {
    readonly entries: number;
    readonly target10HitRatePct: number;
    readonly averageWorstReturnPct: number;
    readonly drawdownFirst10RatePct: number;
  };
  readonly observed: {
    readonly entries: number;
    readonly target10HitRatePct: number;
    readonly averageWorstReturnPct?: number;
    readonly drawdownFirst10RatePct: number;
  };
}

export interface ShadowEntryProfileImprovementSummary {
  readonly label: string;
  readonly profileId: ShadowEntryProfileId;
  readonly profileVersion: string;
  readonly profileKey: string;
  readonly profileName: string;
  readonly observedEntriesDelta: number;
  readonly targetFirstRateDeltaPct: number;
  readonly stopFirstRateDeltaPct: number;
  readonly averageBestReturnDeltaPct?: number;
  readonly averageWorstReturnDeltaPct?: number;
  readonly medianExitReturnDeltaPct?: number;
  readonly simulatedPnlDeltaSol: number;
  readonly maxDrawdownDeltaPct: number;
  readonly missedFastMoversDelta: number;
  readonly falsePositiveAvoidedDelta: number;
}

export interface ShadowEntryScenarioSummary {
  readonly label: string;
  readonly profileId: ShadowEntryProfileId;
  readonly profileVersion: string;
  readonly profileKey: string;
  readonly profileName: string;
  readonly targetPct: number;
  readonly stopPct: number;
  readonly maxHoldMinutes: number;
  readonly evaluatedCount: number;
  readonly targetHitCount: number;
  readonly stopHitCount: number;
  readonly maxHoldCount: number;
  readonly noObservationCount: number;
  readonly ambiguousCount: number;
  readonly averageExitReturnPct?: number;
  readonly medianExitReturnPct?: number;
  readonly simulatedEndingSol: number;
  readonly simulatedPnlSol: number;
  readonly simulatedPnlPct: number;
  readonly maxDrawdownPct: number;
  readonly goalReached: boolean;
}

export interface ShadowEntryProfileExitPairingSummary {
  readonly label: string;
  readonly profileId: ShadowEntryProfileId;
  readonly profileVersion: string;
  readonly profileKey: string;
  readonly profileName: string;
  readonly targetPct: number;
  readonly stopPct: number;
  readonly maxHoldMinutes: number;
  readonly evaluatedCount: number;
  readonly simulatedPnlPct: number;
  readonly maxDrawdownPct: number;
  readonly targetHitCount: number;
  readonly stopHitCount: number;
}

export interface ShadowEntryPortfolioSummary {
  readonly label: string;
  readonly profileId: ShadowEntryProfileId;
  readonly profileVersion: string;
  readonly profileKey: string;
  readonly profileName: string;
  readonly enteredCount: number;
  readonly simulatedEndingSol: number;
  readonly simulatedPnlSol: number;
  readonly simulatedPnlPct: number;
  readonly maxDrawdownPct: number;
  readonly goalReached: boolean;
}

export interface ShadowEntryReadinessSummary {
  readonly label: string;
  readonly profileId: ShadowEntryProfileId;
  readonly profileVersion: string;
  readonly profileKey: string;
  readonly profileName: string;
  readonly status: ShadowEntryReadinessStatus;
  readonly confidence: ShadowEntryConfidence;
  readonly signalStability: ShadowEntrySignalStability;
  readonly maxMarketWindowWinConcentrationPct: number;
  readonly evidence: readonly string[];
}

export interface ShadowEntryRecommendation {
  readonly category: string;
  readonly recommendation: string;
  readonly evidence: readonly string[];
}

export interface ShadowEntryReport {
  readonly generatedAtMs: number;
  readonly config: ShadowEntryRuntimeConfig;
  readonly runs: readonly ShadowEntryRunSummary[];
  readonly aggregate: {
    readonly runCount: number;
    readonly observedDecisionCount: number;
    readonly uniqueMintCount: number;
    readonly orderCount: number;
    readonly fillCount: number;
    readonly positionCount: number;
  };
  readonly normalizedProfiles: readonly ShadowEntryProfileSummary[];
  readonly profiles: readonly ShadowEntryProfileSummary[];
  readonly baselineReproduction: ShadowEntryBaselineReproductionSummary;
  readonly improvementVsBaseline: readonly ShadowEntryProfileImprovementSummary[];
  readonly candidates: readonly ShadowEntryCandidateDecision[];
  readonly scenarioGrid: readonly ShadowEntryScenarioSummary[];
  readonly bestExitByProfile: readonly ShadowEntryProfileExitPairingSummary[];
  readonly portfolioSummaries: readonly ShadowEntryPortfolioSummary[];
  readonly readinessByProfile: readonly ShadowEntryReadinessSummary[];
  readonly recommendations: readonly ShadowEntryRecommendation[];
  readonly nextTestPlan: readonly string[];
}
