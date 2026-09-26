export type RatchetTier = "HARD_STOP" | "TIER_0_DRAWDOWN" | "SCRATCH" | "TIER_1" | "TIER_2";

export type DrawdownState = "NORMAL" | "EVALUATING_DRAWDOWN";

export type ExitActionType = "HOLD" | "SELL_ALL" | "SELL_PARTIAL_50" | "SELL_PARTIAL_25";

export type ExitReasonCode =
  | "HOLD_NORMAL"
  | "HOLD_DRAWDOWN_GRACE"
  | "CATASTROPHIC_HARD_STOP"
  | "RUG_PULL_DETECTED"
  | "SELL_PRESSURE_UNABSORBED"
  | "DRAWDOWN_GRACE_EXPIRED"
  | "SCRATCH_EXIT"
  | "RATCHET_TIER_1_TRIGGERED"
  | "RATCHET_TIER_2_TRIGGERED"
  | "STAGNANCY_TIMEOUT_EXIT"
  | "MANUAL_OPERATOR_EXIT";

export interface PositionRatchetState {
  readonly positionId: string;
  readonly mintAddress: string;
  readonly entryPriceSol: number;
  readonly peakPriceSol: number;
  readonly peakGainBps: number;
  readonly currentStopFloorBps: number;
  readonly activeTier: RatchetTier;
  readonly drawdownState: DrawdownState;
  readonly drawdownEnteredAtMs: number | null;
  readonly lastEvaluatedAtMs: number;
  readonly tier1ProfitTaken?: boolean | undefined;
  readonly tier2ProfitTaken?: boolean | undefined;
}

export interface MarketEvaluationContext {
  readonly spotPriceSol: number;
  readonly lpIntact: boolean;
  readonly recentBuysCount60s: number;
  readonly recentSellsCount60s: number;
  readonly momentum5mBps: number;
  readonly volumeStalled3m: boolean;
  readonly currentTimestampMs: number;
}

export interface RatchetEvaluationDiagnostics {
  readonly currentPnlBps: number;
  readonly peakGainBps: number;
  readonly currentStopFloorBps: number;
  readonly activeTier: RatchetTier;
  readonly drawdownState: DrawdownState;
  readonly drawdownElapsedMs: number | null;
  readonly lpIntact: boolean;
  readonly buySellRatio60s: number;
  readonly momentum5mBps: number;
}

export interface RatchetEvaluationResult {
  readonly action: ExitActionType;
  readonly reasonCode: ExitReasonCode;
  readonly diagnostics: RatchetEvaluationDiagnostics;
  readonly updatedState: PositionRatchetState;
}

export interface DynamicRatchetConfig {
  readonly catastrophicFloorBps: number; // default -1200 (-12.0%)
  readonly drawdownTriggerBps: number; // default -800 (-8.0%)
  readonly drawdownRecoveryBps: number; // default -500 (-5.0%)
  readonly drawdownGracePeriodMs: number; // default 120_000 (120s)
  readonly scratchPnlMinBps: number; // default 50 (+0.5%)
  readonly scratchPnlMaxBps: number; // default 150 (+1.5%)
  readonly tier1PeakThresholdBps: number; // default 2400 (+24.0% / +25.0%)
  readonly tier1LockedFloorBps: number; // default 0 (Breakeven +0.0% floor on remaining 50%)
  readonly tier2PeakThresholdBps: number; // default 4900 (+49.0% / +50.0%)
  readonly tier2LockedFloorBps: number; // default 4000 (+40.0% floor on remaining 25%)
}

export const DEFAULT_DYNAMIC_RATCHET_CONFIG: DynamicRatchetConfig = {
  catastrophicFloorBps: -1200,
  drawdownTriggerBps: -800,
  drawdownRecoveryBps: -500,
  drawdownGracePeriodMs: 120_000,
  scratchPnlMinBps: 50,
  scratchPnlMaxBps: 150,
  tier1PeakThresholdBps: 2400,
  tier1LockedFloorBps: 0,
  tier2PeakThresholdBps: 4900,
  tier2LockedFloorBps: 4000,
};
