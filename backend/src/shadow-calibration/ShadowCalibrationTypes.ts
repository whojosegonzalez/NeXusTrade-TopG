import type {
  ProviderHealthRecord,
  RiskAssessmentRecord,
  SessionRecord,
  StrategyDecision,
  StrategyDecisionRecord,
  SystemLogRecord,
  TokenRadarRecord,
  WatchlistReturnObservationRecord,
} from "../db/schema/index.js";
import type { ReturnPoint, ScoreAttribution } from "../calibration/CalibrationTypes.js";
import type { ShadowCalibrationRuntimeConfig } from "./ShadowCalibrationConfig.js";

export type ShadowCalibrationDataSourceKind = "database" | "report-only";
export type ShadowCalibrationExitReason =
  | "TARGET_HIT"
  | "STOP_HIT"
  | "MAX_HOLD"
  | "NO_OBSERVATION"
  | "AMBIGUOUS";
export type EntryConfirmationOutcome =
  | "CONFIRMED"
  | "CONFIRMATION_REJECTED"
  | "NO_CONFIRMATION_DATA"
  | "MISSED_FAST_MOVE";
export type ShadowRecommendationConfidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_DATA";

export interface ShadowCalibrationReportOnlySummary {
  readonly radarRows?: number;
  readonly strategyRows?: number;
  readonly observedReturnRows?: number;
  readonly providerHealthRows?: number;
  readonly buyHit10Pct?: number;
  readonly buyAverageBestReturnPct?: number;
  readonly buyAverageWorstReturnPct?: number;
  readonly target10Drawdown10Evaluated?: number;
  readonly target10Drawdown10TargetFirst?: number;
  readonly target10Drawdown10DrawdownFirst?: number;
  readonly strategyRowsForProviderImpact?: number;
  readonly missingQuoteCount?: number;
  readonly missingAuthorityCount?: number;
  readonly missingImpactCount?: number;
}

export interface ShadowCalibrationRawRun {
  readonly label: string;
  readonly path: string;
  readonly sourceKind: ShadowCalibrationDataSourceKind;
  readonly warnings: readonly string[];
  readonly session?: SessionRecord;
  readonly strategyDecisions: readonly StrategyDecisionRecord[];
  readonly watchlistReturns: readonly WatchlistReturnObservationRecord[];
  readonly riskAssessments: readonly RiskAssessmentRecord[];
  readonly tokenRadar: readonly TokenRadarRecord[];
  readonly providerHealth: readonly ProviderHealthRecord[];
  readonly systemLogs: readonly SystemLogRecord[];
  readonly orderCount: number;
  readonly fillCount: number;
  readonly positionCount: number;
  readonly reportOnlySummary?: ShadowCalibrationReportOnlySummary;
}

export interface ShadowCalibrationDecisionAnalysis {
  readonly runLabel: string;
  readonly decisionId: string;
  readonly mintAddress: string;
  readonly decidedAtMs: number;
  readonly decision: StrategyDecision;
  readonly score: number | null;
  readonly attribution: ScoreAttribution;
  readonly observedPoints: readonly ReturnPoint[];
  readonly bestReturnPct?: number;
  readonly bestHorizonMinutes?: number;
  readonly worstReturnPct?: number;
  readonly worstHorizonMinutes?: number;
}

export interface ShadowCalibrationRunSummary {
  readonly label: string;
  readonly path: string;
  readonly sourceKind: ShadowCalibrationDataSourceKind;
  readonly sessionId?: string;
  readonly mechanicallyValid: boolean;
  readonly warnings: readonly string[];
  readonly scannerRuntimeMinutes?: number;
  readonly scannerCycleCount?: number;
  readonly riskSummaryCount?: number;
  readonly strategySummaryCount?: number;
  readonly tokenRadarRows: number;
  readonly uniqueRadarMints?: number;
  readonly riskRows: number;
  readonly strategyRows: number;
  readonly uniqueStrategyMints?: number;
  readonly observedReturnRows: number;
  readonly observedDecisionCount?: number;
  readonly providerHealthRows: number;
  readonly jupiterRateLimitedPercent?: number;
  readonly orderCount: number;
  readonly fillCount: number;
  readonly positionCount: number;
}

export interface ShadowDecisionOutcomeSummary {
  readonly label: string;
  readonly group: string;
  readonly count: number;
  readonly uniqueMints: number;
  readonly averageBestReturnPct?: number;
  readonly averageWorstReturnPct?: number;
  readonly medianBestReturnPct?: number;
  readonly medianWorstReturnPct?: number;
  readonly targetHitRates: Readonly<Record<string, number>>;
  readonly drawdownFirstRates: Readonly<Record<string, number>>;
}

export interface ShadowUniqueMintOutcomeSummary extends ShadowDecisionOutcomeSummary {
  readonly dedupeMode: string;
}

export interface ShadowScenario {
  readonly targetPct: number;
  readonly stopPct: number;
  readonly maxHoldMinutes: number;
}

export interface ShadowExitOutcome {
  readonly scenario: ShadowScenario;
  readonly exitReason: ShadowCalibrationExitReason;
  readonly exitReturnPct?: number;
  readonly exitHorizonMinutes?: number;
}

export interface ShadowScenarioPortfolioSummary {
  readonly label: string;
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
  readonly winRatePct: number;
  readonly lossRatePct: number;
  readonly simulatedEndingSol: number;
  readonly simulatedPnlSol: number;
  readonly simulatedPnlPct: number;
  readonly maxDrawdownPct: number;
  readonly goalReached: boolean;
}

export interface EntryConfirmationSummary {
  readonly label: string;
  readonly horizonMinutes: number;
  readonly minReturnPct: number;
  readonly maxDrawdownPct: number;
  readonly targetPct: number;
  readonly stopPct: number;
  readonly maxHoldMinutes: number;
  readonly consideredCount: number;
  readonly confirmedCount: number;
  readonly rejectedCount: number;
  readonly noDataCount: number;
  readonly missedFastMoveCount: number;
  readonly targetHitCount: number;
  readonly stopHitCount: number;
  readonly averageConfirmedExitReturnPct?: number;
  readonly falsePositiveBuysAvoided: number;
  readonly missedWinnersCausedByWaiting: number;
}

export interface CandidateFilterSummary {
  readonly label: string;
  readonly filterName: string;
  readonly bucket: string;
  readonly count: number;
  readonly sampleWarning: boolean;
  readonly targetHitRates: Readonly<Record<string, number>>;
  readonly drawdownFirstRates: Readonly<Record<string, number>>;
  readonly averageBestReturnPct?: number;
  readonly averageWorstReturnPct?: number;
  readonly medianBestReturnPct?: number;
  readonly medianWorstReturnPct?: number;
}

export interface ShadowCalibrationRecommendation {
  readonly confidence: ShadowRecommendationConfidence;
  readonly category: string;
  readonly recommendation: string;
  readonly evidence: readonly string[];
}

export interface ShadowCalibrationReport {
  readonly generatedAtMs: number;
  readonly config: ShadowCalibrationRuntimeConfig;
  readonly runs: readonly ShadowCalibrationRunSummary[];
  readonly aggregate: {
    readonly runCount: number;
    readonly databaseRunCount: number;
    readonly reportOnlyRunCount: number;
    readonly observedDecisionCount: number;
    readonly uniqueMintCount: number;
    readonly orderCount: number;
    readonly fillCount: number;
    readonly positionCount: number;
  };
  readonly decisionOutcomes: readonly ShadowDecisionOutcomeSummary[];
  readonly uniqueMintOutcomes: readonly ShadowUniqueMintOutcomeSummary[];
  readonly scenarioPortfolioGrid: readonly ShadowScenarioPortfolioSummary[];
  readonly confirmationResults: readonly EntryConfirmationSummary[];
  readonly filterAnalysis: readonly CandidateFilterSummary[];
  readonly recommendations: readonly ShadowCalibrationRecommendation[];
  readonly nextTestPlan: readonly string[];
}
