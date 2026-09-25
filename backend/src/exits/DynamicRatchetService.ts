import {
  type DynamicRatchetConfig,
  type MarketEvaluationContext,
  type PositionRatchetState,
  type RatchetEvaluationResult,
  type RatchetEvaluationDiagnostics,
  type RatchetTier,
  type DrawdownState,
  DEFAULT_DYNAMIC_RATCHET_CONFIG,
} from "./DynamicRatchetTypes.js";
import { RatchetStateStore } from "./RatchetStateStore.js";

export class DynamicRatchetService {
  private readonly config: DynamicRatchetConfig;
  private readonly store: RatchetStateStore;

  constructor(
    config: Partial<DynamicRatchetConfig> = {},
    store: RatchetStateStore = new RatchetStateStore(),
  ) {
    this.config = { ...DEFAULT_DYNAMIC_RATCHET_CONFIG, ...config };
    this.store = store;
  }

  getStore(): RatchetStateStore {
    return this.store;
  }

  evaluate(state: PositionRatchetState, context: MarketEvaluationContext): RatchetEvaluationResult {
    if (state.entryPriceSol <= 0) {
      throw new Error(`Invalid entryPriceSol: ${state.entryPriceSol}. Must be > 0.`);
    }
    if (context.spotPriceSol <= 0) {
      throw new Error(`Invalid spotPriceSol: ${context.spotPriceSol}. Must be > 0.`);
    }

    const currentPnlBps = Math.round(
      ((context.spotPriceSol - state.entryPriceSol) / state.entryPriceSol) * 10_000,
    );
    const nextPeakPriceSol = Math.max(state.peakPriceSol, context.spotPriceSol);
    const nextPeakGainBps = Math.max(state.peakGainBps, currentPnlBps);

    let nextTier: RatchetTier = state.activeTier;
    let nextFloorBps = state.currentStopFloorBps;
    let nextDrawdownState: DrawdownState = state.drawdownState;
    let nextDrawdownEnteredAtMs: number | null = state.drawdownEnteredAtMs;

    // 1. Ratchet Progression Rules
    if (nextPeakGainBps >= this.config.tier2PeakThresholdBps) {
      nextTier = "TIER_2";
      nextFloorBps = Math.max(nextFloorBps, this.config.tier2LockedFloorBps);
    } else if (nextPeakGainBps >= this.config.tier1PeakThresholdBps) {
      nextTier = "TIER_1";
      nextFloorBps = Math.max(nextFloorBps, this.config.tier1LockedFloorBps);
    } else if (
      currentPnlBps >= this.config.scratchPnlMinBps &&
      currentPnlBps <= this.config.scratchPnlMaxBps &&
      nextTier !== "TIER_1" &&
      nextTier !== "TIER_2"
    ) {
      nextTier = "SCRATCH";
    }

    // 2. Evaluation Logic
    // Rule A: Catastrophic disaster hard floor (-12.0%)
    if (currentPnlBps <= this.config.catastrophicFloorBps) {
      const updatedState: PositionRatchetState = {
        ...state,
        peakPriceSol: nextPeakPriceSol,
        peakGainBps: nextPeakGainBps,
        currentStopFloorBps: nextFloorBps,
        activeTier: "HARD_STOP",
        drawdownState: "NORMAL",
        drawdownEnteredAtMs: null,
        lastEvaluatedAtMs: context.currentTimestampMs,
      };
      this.store.update(updatedState);

      const diagnostics = this.buildDiagnostics(
        currentPnlBps,
        nextPeakGainBps,
        nextFloorBps,
        "HARD_STOP",
        "NORMAL",
        null,
        context,
      );

      return {
        action: "SELL_ALL",
        reasonCode: "CATASTROPHIC_HARD_STOP",
        diagnostics,
        updatedState,
      };
    }

    // Rule B: Ratchet locked floor breach (+20% / +45%)
    if (
      (nextTier === "TIER_1" || nextTier === "TIER_2" || nextFloorBps > 0) &&
      currentPnlBps <= nextFloorBps
    ) {
      const updatedState: PositionRatchetState = {
        ...state,
        peakPriceSol: nextPeakPriceSol,
        peakGainBps: nextPeakGainBps,
        currentStopFloorBps: nextFloorBps,
        activeTier: nextTier,
        drawdownState: "NORMAL",
        drawdownEnteredAtMs: null,
        lastEvaluatedAtMs: context.currentTimestampMs,
      };
      this.store.update(updatedState);

      const diagnostics = this.buildDiagnostics(
        currentPnlBps,
        nextPeakGainBps,
        nextFloorBps,
        nextTier,
        "NORMAL",
        null,
        context,
      );

      return {
        action: "SELL_ALL",
        reasonCode:
          nextTier === "TIER_2" || nextFloorBps >= this.config.tier2LockedFloorBps
            ? "RATCHET_TIER_2_TRIGGERED"
            : "RATCHET_TIER_1_TRIGGERED",
        diagnostics,
        updatedState,
      };
    }

    // Rule C: Scratch Exit (+0.5% to +1.5% with stalled momentum / volume drop)
    if (
      currentPnlBps >= this.config.scratchPnlMinBps &&
      currentPnlBps <= this.config.scratchPnlMaxBps &&
      (context.momentum5mBps <= 0 || context.volumeStalled3m)
    ) {
      const updatedState: PositionRatchetState = {
        ...state,
        peakPriceSol: nextPeakPriceSol,
        peakGainBps: nextPeakGainBps,
        currentStopFloorBps: nextFloorBps,
        activeTier: "SCRATCH",
        drawdownState: "NORMAL",
        drawdownEnteredAtMs: null,
        lastEvaluatedAtMs: context.currentTimestampMs,
      };
      this.store.update(updatedState);

      const diagnostics = this.buildDiagnostics(
        currentPnlBps,
        nextPeakGainBps,
        nextFloorBps,
        "SCRATCH",
        "NORMAL",
        null,
        context,
      );

      return {
        action: "SELL_ALL",
        reasonCode: "SCRATCH_EXIT",
        diagnostics,
        updatedState,
      };
    }

    // Rule D: Smart Re-evaluation Gate at -8.0% (-800 bps)
    if (currentPnlBps <= this.config.drawdownTriggerBps) {
      if (nextDrawdownState === "NORMAL") {
        nextDrawdownState = "EVALUATING_DRAWDOWN";
        nextDrawdownEnteredAtMs = context.currentTimestampMs;
      } else if (nextDrawdownEnteredAtMs === null) {
        nextDrawdownEnteredAtMs = context.currentTimestampMs;
      }

      const elapsedMs = context.currentTimestampMs - nextDrawdownEnteredAtMs;

      // Health Check 1: LP integrity
      if (!context.lpIntact) {
        const updatedState: PositionRatchetState = {
          ...state,
          peakPriceSol: nextPeakPriceSol,
          peakGainBps: nextPeakGainBps,
          currentStopFloorBps: nextFloorBps,
          activeTier: "TIER_0_DRAWDOWN",
          drawdownState: nextDrawdownState,
          drawdownEnteredAtMs: nextDrawdownEnteredAtMs,
          lastEvaluatedAtMs: context.currentTimestampMs,
        };
        this.store.update(updatedState);

        const diagnostics = this.buildDiagnostics(
          currentPnlBps,
          nextPeakGainBps,
          nextFloorBps,
          "TIER_0_DRAWDOWN",
          nextDrawdownState,
          elapsedMs,
          context,
        );

        return {
          action: "SELL_ALL",
          reasonCode: "RUG_PULL_DETECTED",
          diagnostics,
          updatedState,
        };
      }

      // Health Check 2: Buyer absorption
      if (
        context.recentBuysCount60s === 0 ||
        context.recentBuysCount60s < context.recentSellsCount60s
      ) {
        const updatedState: PositionRatchetState = {
          ...state,
          peakPriceSol: nextPeakPriceSol,
          peakGainBps: nextPeakGainBps,
          currentStopFloorBps: nextFloorBps,
          activeTier: "TIER_0_DRAWDOWN",
          drawdownState: nextDrawdownState,
          drawdownEnteredAtMs: nextDrawdownEnteredAtMs,
          lastEvaluatedAtMs: context.currentTimestampMs,
        };
        this.store.update(updatedState);

        const diagnostics = this.buildDiagnostics(
          currentPnlBps,
          nextPeakGainBps,
          nextFloorBps,
          "TIER_0_DRAWDOWN",
          nextDrawdownState,
          elapsedMs,
          context,
        );

        return {
          action: "SELL_ALL",
          reasonCode: "SELL_PRESSURE_UNABSORBED",
          diagnostics,
          updatedState,
        };
      }

      // Health Check 3: Grace period timeout
      if (elapsedMs > this.config.drawdownGracePeriodMs) {
        const updatedState: PositionRatchetState = {
          ...state,
          peakPriceSol: nextPeakPriceSol,
          peakGainBps: nextPeakGainBps,
          currentStopFloorBps: nextFloorBps,
          activeTier: "TIER_0_DRAWDOWN",
          drawdownState: nextDrawdownState,
          drawdownEnteredAtMs: nextDrawdownEnteredAtMs,
          lastEvaluatedAtMs: context.currentTimestampMs,
        };
        this.store.update(updatedState);

        const diagnostics = this.buildDiagnostics(
          currentPnlBps,
          nextPeakGainBps,
          nextFloorBps,
          "TIER_0_DRAWDOWN",
          nextDrawdownState,
          elapsedMs,
          context,
        );

        return {
          action: "SELL_ALL",
          reasonCode: "DRAWDOWN_GRACE_EXPIRED",
          diagnostics,
          updatedState,
        };
      }

      // Healthy Dip: LP intact, buyers absorbing, grace period active
      const updatedState: PositionRatchetState = {
        ...state,
        peakPriceSol: nextPeakPriceSol,
        peakGainBps: nextPeakGainBps,
        currentStopFloorBps: nextFloorBps,
        activeTier: "TIER_0_DRAWDOWN",
        drawdownState: "EVALUATING_DRAWDOWN",
        drawdownEnteredAtMs: nextDrawdownEnteredAtMs,
        lastEvaluatedAtMs: context.currentTimestampMs,
      };
      this.store.update(updatedState);

      const diagnostics = this.buildDiagnostics(
        currentPnlBps,
        nextPeakGainBps,
        nextFloorBps,
        "TIER_0_DRAWDOWN",
        "EVALUATING_DRAWDOWN",
        elapsedMs,
        context,
      );

      return {
        action: "HOLD",
        reasonCode: "HOLD_DRAWDOWN_GRACE",
        diagnostics,
        updatedState,
      };
    }

    // Rule E: Drawdown Recovery (price recovers above -5.0%)
    if (
      state.drawdownState === "EVALUATING_DRAWDOWN" &&
      currentPnlBps >= this.config.drawdownRecoveryBps
    ) {
      nextDrawdownState = "NORMAL";
      nextDrawdownEnteredAtMs = null;
    }

    // Rule F: Default Normal Hold
    const updatedState: PositionRatchetState = {
      ...state,
      peakPriceSol: nextPeakPriceSol,
      peakGainBps: nextPeakGainBps,
      currentStopFloorBps: nextFloorBps,
      activeTier: nextTier,
      drawdownState: nextDrawdownState,
      drawdownEnteredAtMs: nextDrawdownEnteredAtMs,
      lastEvaluatedAtMs: context.currentTimestampMs,
    };
    this.store.update(updatedState);

    const diagnostics = this.buildDiagnostics(
      currentPnlBps,
      nextPeakGainBps,
      nextFloorBps,
      nextTier,
      nextDrawdownState,
      nextDrawdownEnteredAtMs !== null
        ? context.currentTimestampMs - nextDrawdownEnteredAtMs
        : null,
      context,
    );

    return {
      action: "HOLD",
      reasonCode: "HOLD_NORMAL",
      diagnostics,
      updatedState,
    };
  }

  private buildDiagnostics(
    currentPnlBps: number,
    peakGainBps: number,
    currentStopFloorBps: number,
    activeTier: RatchetTier,
    drawdownState: DrawdownState,
    drawdownElapsedMs: number | null,
    context: MarketEvaluationContext,
  ): RatchetEvaluationDiagnostics {
    const buySellRatio60s =
      context.recentSellsCount60s === 0
        ? context.recentBuysCount60s > 0
          ? 999
          : 0
        : Number((context.recentBuysCount60s / context.recentSellsCount60s).toFixed(2));

    return {
      currentPnlBps,
      peakGainBps,
      currentStopFloorBps,
      activeTier,
      drawdownState,
      drawdownElapsedMs,
      lpIntact: context.lpIntact,
      buySellRatio60s,
      momentum5mBps: context.momentum5mBps,
    };
  }
}
