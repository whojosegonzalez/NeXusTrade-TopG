import type {
  SessionRecord,
  StrategyDecision,
  StrategyDecisionRecord,
  WatchlistReturnObservationRecord,
} from "../db/schema/index.js";
import type { ShadowRuntimeConfig } from "./ShadowConfig.js";

export type ShadowExitReason =
  | "TARGET_HIT"
  | "STOP_HIT"
  | "MAX_HOLD"
  | "NO_OBSERVATION"
  | "AMBIGUOUS";

export interface ShadowCandidate {
  readonly decision: StrategyDecisionRecord;
  readonly symbol?: string | undefined;
  readonly name?: string | undefined;
  readonly pairAddress?: string | undefined;
  readonly baselinePriceSol?: string | undefined;
  readonly baselinePriceUsd?: string | undefined;
  readonly liquidityUsd?: string | undefined;
  readonly volume1hUsd?: string | undefined;
  readonly ageSeconds?: number | undefined;
  readonly selectionMode: "BUY" | "SHADOW_SCORE";
  readonly skippedReason?: string | undefined;
}

export interface ShadowObservedReturn {
  readonly horizonMinutes: number;
  readonly returnPct: number;
  readonly status: WatchlistReturnObservationRecord["status"];
}

export interface ShadowExitScenario {
  readonly targetPct: number;
  readonly stopPct: number;
  readonly maxHoldMinutes: number;
}

export interface ShadowExitOutcome {
  readonly scenario: ShadowExitScenario;
  readonly exitReason: ShadowExitReason;
  readonly exitReturnPct?: number | undefined;
  readonly exitHorizonMinutes?: number | undefined;
  readonly targetHorizonMinutes?: number | undefined;
  readonly stopHorizonMinutes?: number | undefined;
}

export interface ShadowCandidateResult {
  readonly strategyDecisionId: string;
  readonly mintAddress: string;
  readonly symbol?: string | undefined;
  readonly decision: StrategyDecision;
  readonly score?: number | undefined;
  readonly selectionMode: ShadowCandidate["selectionMode"];
  readonly baselinePriceSol?: string | undefined;
  readonly liquidityUsd?: string | undefined;
  readonly volume1hUsd?: string | undefined;
  readonly ageSeconds?: number | undefined;
  readonly observedReturns: readonly ShadowObservedReturn[];
  readonly bestReturnPct?: number | undefined;
  readonly worstReturnPct?: number | undefined;
  readonly outcomes: readonly ShadowExitOutcome[];
}

export interface ShadowScenarioSummary {
  readonly targetPct: number;
  readonly stopPct: number;
  readonly maxHoldMinutes: number;
  readonly evaluatedCount: number;
  readonly targetHitCount: number;
  readonly stopHitCount: number;
  readonly maxHoldCount: number;
  readonly noObservationCount: number;
  readonly ambiguousCount: number;
  readonly averageExitReturnPct?: number | undefined;
  readonly targetHitRatePct: number;
}

export interface ShadowPortfolioTrade {
  readonly strategyDecisionId: string;
  readonly symbol?: string | undefined;
  readonly mintAddress: string;
  readonly decision: StrategyDecision;
  readonly score?: number | undefined;
  readonly entrySol: number;
  readonly exitReturnPct: number;
  readonly pnlSol: number;
  readonly exitReason: ShadowExitReason;
  readonly exitHorizonMinutes?: number | undefined;
}

export interface ShadowPortfolioSummary {
  readonly startingBalanceSol: number;
  readonly endingBalanceSol: number;
  readonly pnlSol: number;
  readonly pnlPct: number;
  readonly goalBalanceSol: number;
  readonly goalReached: boolean;
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly averageWinnerPct?: number | undefined;
  readonly averageLoserPct?: number | undefined;
  readonly maxDrawdownPct: number;
  readonly trades: readonly ShadowPortfolioTrade[];
}

export interface ShadowExitReport {
  readonly generatedAtMs: number;
  readonly session: SessionRecord;
  readonly config: ShadowRuntimeConfig;
  readonly selectedCount: number;
  readonly skippedCount: number;
  readonly skippedReasons: readonly string[];
  readonly candidates: readonly ShadowCandidateResult[];
  readonly scenarioSummaries: readonly ShadowScenarioSummary[];
  readonly portfolio: ShadowPortfolioSummary;
  readonly recommendations: readonly string[];
}
