import {
  type DynamicRatchetConfig,
  type ExitReasonCode,
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

  evaluate(
    state: PositionRatchetState,
    context: MarketEvaluationContext,
    configOverride?: Partial<DynamicRatchetConfig>,
  ): RatchetEvaluationResult {
    if (state.entryPriceSol <= 0) {
      throw new Error(`Invalid entryPriceSol: ${state.entryPriceSol}. Must be > 0.`);
    }
    if (context.spotPriceSol <= 0) {
      throw new Error(`Invalid spotPriceSol: ${context.spotPriceSol}. Must be > 0.`);
    }

    const activeConfig = configOverride ? { ...this.config, ...configOverride } : this.config;

    const currentPnlBps = Math.round(
      ((context.spotPriceSol - state.entryPriceSol) / state.entryPriceSol) * 10_000,
    );
    const nextPeakPriceSol = Math.max(state.peakPriceSol, context.spotPriceSol);
    const nextPeakGainBps = Math.max(state.peakGainBps, currentPnlBps);

    let nextTier: RatchetTier = state.activeTier;
    let nextFloorBps = state.currentStopFloorBps;
    let nextDrawdownState: DrawdownState = state.drawdownState;
    let nextDrawdownEnteredAtMs: number | null = state.drawdownEnteredAtMs;
    let tier1ProfitTaken = state.tier1ProfitTaken ?? false;
    let tier2ProfitTaken = state.tier2ProfitTaken ?? false;
    let armedBreakeven = state.armedBreakeven ?? false;

    // 0. Optional Hard Take-Profit Cap Check
    if (
      activeConfig.hardTakeProfitBps !== undefined &&
      currentPnlBps >= activeConfig.hardTakeProfitBps
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
        ...(armedBreakeven ? { armedBreakeven: true } : {}),
        tier1ProfitTaken,
        tier2ProfitTaken,
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
        reasonCode: "HARD_TAKE_PROFIT_CAP_TRIGGERED",
        diagnostics,
        updatedState,
      };
    }

    // Smart Hold Recovery Check
    if (state.drawdownState === "EVALUATING_DRAWDOWN") {
      if (currentPnlBps >= 800) {
        nextDrawdownState = "NORMAL";
        nextDrawdownEnteredAtMs = null;
        nextFloorBps = Math.max(nextFloorBps, 0);
      } else if (currentPnlBps >= activeConfig.drawdownRecoveryBps) {
        nextDrawdownState = "NORMAL";
        nextDrawdownEnteredAtMs = null;
      }
    }

    // Milestone 0: Armed Breakeven (+10.0%) - Risk-free stop floor without selling tokens
    if (nextPeakGainBps >= activeConfig.armedBreakevenThresholdBps && !armedBreakeven) {
      armedBreakeven = true;
      nextFloorBps = Math.max(nextFloorBps, activeConfig.armedBreakevenFloorBps);
    }

    // 1. Milestone Take-Profit Scaling Checks
    // Check Tier 1 Milestone (+20%): Sell 50% of position, move floor to +10%
    if (nextPeakGainBps >= activeConfig.tier1PeakThresholdBps && !tier1ProfitTaken) {
      tier1ProfitTaken = true;
      nextTier = "TIER_1";
      nextFloorBps = Math.max(nextFloorBps, activeConfig.tier1LockedFloorBps, 0);

      const updatedState: PositionRatchetState = {
        ...state,
        peakPriceSol: nextPeakPriceSol,
        peakGainBps: nextPeakGainBps,
        currentStopFloorBps: nextFloorBps,
        activeTier: nextTier,
        drawdownState: "NORMAL",
        drawdownEnteredAtMs: null,
        lastEvaluatedAtMs: context.currentTimestampMs,
        ...(armedBreakeven ? { armedBreakeven: true } : {}),
        tier1ProfitTaken,
        tier2ProfitTaken,
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
        action: "SELL_PARTIAL_50",
        reasonCode: "RATCHET_TIER_1_TRIGGERED",
        diagnostics,
        updatedState,
      };
    }

    // Check Tier 2 Milestone (+48.5%): Sell 25% of position, move floor to Tier 2 (+35%) or trailing moonbag
    if (nextPeakGainBps >= activeConfig.tier2PeakThresholdBps && !tier2ProfitTaken) {
      tier2ProfitTaken = true;
      nextTier = "TIER_2";
      let trailBufferBps = 1800;
      if (nextPeakGainBps >= 20000) {
        trailBufferBps = 1000;
      } else if (nextPeakGainBps >= 10000) {
        trailBufferBps = 1500;
      }
      const trailingMoonbagFloor = Math.max(
        activeConfig.tier2LockedFloorBps,
        nextPeakGainBps - trailBufferBps,
      );
      nextFloorBps = Math.max(nextFloorBps, trailingMoonbagFloor);

      const updatedState: PositionRatchetState = {
        ...state,
        peakPriceSol: nextPeakPriceSol,
        peakGainBps: nextPeakGainBps,
        currentStopFloorBps: nextFloorBps,
        activeTier: nextTier,
        drawdownState: "NORMAL",
        drawdownEnteredAtMs: null,
        lastEvaluatedAtMs: context.currentTimestampMs,
        ...(armedBreakeven ? { armedBreakeven: true } : {}),
        tier1ProfitTaken,
        tier2ProfitTaken,
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
        action: "SELL_PARTIAL_25",
        reasonCode: "RATCHET_TIER_2_TRIGGERED",
        diagnostics,
        updatedState,
      };
    }

    // Update active tier and floor if milestones were previously reached
    if (nextPeakGainBps >= activeConfig.tier2PeakThresholdBps || tier2ProfitTaken) {
      nextTier = "TIER_2";
      let trailBufferBps = 1800;
      if (nextPeakGainBps >= 20000) {
        trailBufferBps = 1000;
      } else if (nextPeakGainBps >= 10000) {
        trailBufferBps = 1500;
      }
      const trailingMoonbagFloor = Math.max(
        activeConfig.tier2LockedFloorBps,
        nextPeakGainBps - trailBufferBps,
      );
      nextFloorBps = Math.max(nextFloorBps, trailingMoonbagFloor);
    } else if (nextPeakGainBps >= activeConfig.tier1PeakThresholdBps || tier1ProfitTaken) {
      nextTier = "TIER_1";
      nextFloorBps = Math.max(nextFloorBps, activeConfig.tier1LockedFloorBps);
    } else if (armedBreakeven || nextPeakGainBps >= activeConfig.armedBreakevenThresholdBps) {
      nextFloorBps = Math.max(nextFloorBps, activeConfig.armedBreakevenFloorBps);
      if (nextTier !== "TIER_1" && nextTier !== "TIER_2") {
        nextTier = "RUNNING";
      }
    } else if (
      currentPnlBps >= activeConfig.scratchPnlMinBps &&
      currentPnlBps <= activeConfig.scratchPnlMaxBps &&
      nextTier !== "TIER_1" &&
      nextTier !== "TIER_2"
    ) {
      nextTier = "SCRATCH";
    } else if (
      nextTier === "SCRATCH" &&
      (currentPnlBps > activeConfig.scratchPnlMaxBps ||
        currentPnlBps < activeConfig.scratchPnlMinBps)
    ) {
      nextTier = "RUNNING";
    }

    // 2. Evaluation Logic
    // Rule A0: Emergency Avalanche Sell-Pressure Cut
    // If position is underwater (currentPnlBps <= -400, i.e. <= -4.0%)
    // and live flow shows an extreme seller avalanche (sells >= 25 in 60s AND sells >= 3.0 * buys)
    if (
      currentPnlBps <= -400 &&
      context.recentSellsCount60s >= 25 &&
      context.recentSellsCount60s >= 3.0 * Math.max(1, context.recentBuysCount60s)
    ) {
      const updatedState: PositionRatchetState = {
        ...state,
        peakPriceSol: nextPeakPriceSol,
        peakGainBps: nextPeakGainBps,
        currentStopFloorBps: nextFloorBps,
        activeTier: "HARD_STOP",
        drawdownState: "NORMAL",
        drawdownEnteredAtMs: null,
        lastEvaluatedAtMs: context.currentTimestampMs,
        ...(armedBreakeven ? { armedBreakeven: true } : {}),
        tier1ProfitTaken,
        tier2ProfitTaken,
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
        reasonCode: "EMERGENCY_SELL_PRESSURE_CUT",
        diagnostics,
        updatedState,
      };
    }

    // Rule A0-Cliff: Single-Tick Whale/Dev Dump Circuit Breaker
    // If position is underwater (currentPnlBps <= -800, i.e. <= -8.0%),
    // buyer flow has completely ceased (recentBuysCount60s === 0),
    // and price experienced a severe instantaneous cliff in a single tick (singleTickDropBps <= -1000, i.e. <= -10.0%)
    if (
      currentPnlBps <= -800 &&
      context.recentBuysCount60s === 0 &&
      context.singleTickDropBps !== undefined &&
      context.singleTickDropBps <= -1000
    ) {
      const updatedState: PositionRatchetState = {
        ...state,
        peakPriceSol: nextPeakPriceSol,
        peakGainBps: nextPeakGainBps,
        currentStopFloorBps: nextFloorBps,
        activeTier: "HARD_STOP",
        drawdownState: "NORMAL",
        drawdownEnteredAtMs: null,
        lastEvaluatedAtMs: context.currentTimestampMs,
        ...(armedBreakeven ? { armedBreakeven: true } : {}),
        tier1ProfitTaken,
        tier2ProfitTaken,
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
        reasonCode: "WHALE_DEV_DUMP_CLIFF_CUT",
        diagnostics,
        updatedState,
      };
    }

    // Phase 12.93 Deliverable 1 & 3: Ratchet Locked Floor, Breakeven & Moonbag Defense
    // Evaluates FIRST when a position has achieved an active milestone or locked floor,
    // guaranteeing that moonbags and scaled-in pyramiding positions exit at or above breakeven
    // rather than falling through to catastrophic hard stops on discrete single-candle dumps.
    if (
      (nextTier === "TIER_1" || nextTier === "TIER_2" || armedBreakeven || nextFloorBps >= 0) &&
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
        ...(armedBreakeven ? { armedBreakeven: true } : {}),
        tier1ProfitTaken,
        tier2ProfitTaken,
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

      let reasonCode: ExitReasonCode = "ARMED_BREAKEVEN_BREACH";
      if (nextTier === "TIER_2" || nextFloorBps >= activeConfig.tier2LockedFloorBps) {
        reasonCode = "RATCHET_TIER_2_BREACH";
      } else if (nextTier === "TIER_1" || tier1ProfitTaken) {
        // Phase 12.93 Pillar 1: Moonbag Capital-Preservation Guarantee
        // If price slipped below initial entry (0 bps) after Tier 1 profit was taken,
        // flag as MOONBAG_PROTECTION_EXIT so realized trade profit is strictly preserved.
        const moonbagFloor = activeConfig.moonbagFloorBps ?? 0;
        reasonCode =
          currentPnlBps <= moonbagFloor ? "MOONBAG_PROTECTION_EXIT" : "RATCHET_TIER_1_BREACH";
      } else if (armedBreakeven && nextPeakGainBps < activeConfig.armedBreakevenThresholdBps) {
        // Phase 12.93 Pillar 3: Scaled-In Breakeven Shield
        reasonCode = "SCALED_BREAKEVEN_EXIT";
      } else if (armedBreakeven) {
        reasonCode = "ARMED_BREAKEVEN_BREACH";
      }

      return {
        action: "SELL_ALL",
        reasonCode,
        diagnostics,
        updatedState,
      };
    }

    // Phase 12.92 & Phase 12.93 Probe Quick-Cut:
    // If a position has never confirmed (+1.0% / 100 bps peak gain) and drops to <= -12.0%,
    // cut immediately unless extreme viral buyer absorption is active.
    const hasViralAbsorption =
      context.recentBuysCount60s >= 50 &&
      context.recentBuysCount60s >= 1.25 * Math.max(1, context.recentSellsCount60s);

    if (nextPeakGainBps < 100 && currentPnlBps <= -1200 && !hasViralAbsorption) {
      const updatedState: PositionRatchetState = {
        ...state,
        peakPriceSol: nextPeakPriceSol,
        peakGainBps: nextPeakGainBps,
        currentStopFloorBps: nextFloorBps,
        activeTier: "HARD_STOP",
        drawdownState: "NORMAL",
        drawdownEnteredAtMs: null,
        lastEvaluatedAtMs: context.currentTimestampMs,
        tier1ProfitTaken,
        tier2ProfitTaken,
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
        reasonCode: "PROBE_UNCONFIRMED_DUMP_CUT",
        diagnostics,
        updatedState,
      };
    }

    // Rule A: Catastrophic disaster hard floor (-18.0% / -20.0%)
    if (currentPnlBps <= activeConfig.catastrophicFloorBps) {
      const updatedState: PositionRatchetState = {
        ...state,
        peakPriceSol: nextPeakPriceSol,
        peakGainBps: nextPeakGainBps,
        currentStopFloorBps: nextFloorBps,
        activeTier: "HARD_STOP",
        drawdownState: "NORMAL",
        drawdownEnteredAtMs: null,
        lastEvaluatedAtMs: context.currentTimestampMs,
        ...(armedBreakeven ? { armedBreakeven: true } : {}),
        tier1ProfitTaken,
        tier2ProfitTaken,
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

    // Flow-Aware Stop: If price dips between -12.0% (-1200 bps) and catastrophic floor
    // and buyer flow is unabsorbed (buys < sells or buys === 0), cut immediately!
    // But if buyer dominance is strong (buys >= 1.25 * sells), allow position to breathe down to catastrophic floor.
    if (
      currentPnlBps <= -1200 &&
      (context.recentBuysCount60s === 0 || context.recentBuysCount60s < context.recentSellsCount60s)
    ) {
      const updatedState: PositionRatchetState = {
        ...state,
        peakPriceSol: nextPeakPriceSol,
        peakGainBps: nextPeakGainBps,
        currentStopFloorBps: nextFloorBps,
        activeTier: "HARD_STOP",
        drawdownState: "NORMAL",
        drawdownEnteredAtMs: null,
        lastEvaluatedAtMs: context.currentTimestampMs,
        ...(armedBreakeven ? { armedBreakeven: true } : {}),
        tier1ProfitTaken,
        tier2ProfitTaken,
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
        reasonCode: "SELL_PRESSURE_UNABSORBED",
        diagnostics,
        updatedState,
      };
    }

    // Phase 12.93 Pillar 2: Cohort-Calibrated Strict Pre-Breakeven Stop (-10.0% Established / -12.0% Micro)
    // Any candidate that has not yet confirmed the +10.0% Armed Breakeven threshold
    // must be cut strictly when underwater <= preBreakevenStopBps (-1000 bps Established, -1200 bps Micro).
    // Audit P0-F: Unconditional protective stop — smoothed 5m buyer-flow estimates cannot veto this loss cut.
    if (
      !armedBreakeven &&
      !tier1ProfitTaken &&
      nextPeakGainBps < activeConfig.armedBreakevenThresholdBps &&
      currentPnlBps <= (activeConfig.preBreakevenStopBps ?? -1200)
    ) {
      const updatedState: PositionRatchetState = {
        ...state,
        peakPriceSol: nextPeakPriceSol,
        peakGainBps: nextPeakGainBps,
        currentStopFloorBps: nextFloorBps,
        activeTier: "HARD_STOP",
        drawdownState: "NORMAL",
        drawdownEnteredAtMs: null,
        lastEvaluatedAtMs: context.currentTimestampMs,
        tier1ProfitTaken,
        tier2ProfitTaken,
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
        reasonCode: "UNCONFIRMED_PRE_BREAKEVEN_CUT",
        diagnostics,
        updatedState,
      };
    }

    // Rule C: Scratch Exit (+0.5% to +1.5% with stalled momentum / volume drop)
    if (
      currentPnlBps >= activeConfig.scratchPnlMinBps &&
      currentPnlBps <= activeConfig.scratchPnlMaxBps &&
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
        ...(armedBreakeven ? { armedBreakeven: true } : {}),
        tier1ProfitTaken,
        tier2ProfitTaken,
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
    if (currentPnlBps <= activeConfig.drawdownTriggerBps) {
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
          ...(armedBreakeven ? { armedBreakeven: true } : {}),
          tier1ProfitTaken,
          tier2ProfitTaken,
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
          ...(armedBreakeven ? { armedBreakeven: true } : {}),
          tier1ProfitTaken,
          tier2ProfitTaken,
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
      // Dynamic Grace Extension: If buyer dominance is strong (buys >= 1.25 * sells), extend grace up to 180s (3m)
      const hasStrongBuyerDominance =
        context.recentBuysCount60s >= 1.25 * Math.max(1, context.recentSellsCount60s);
      const effectiveGracePeriodMs = hasStrongBuyerDominance
        ? Math.max(activeConfig.drawdownGracePeriodMs, 180_000)
        : activeConfig.drawdownGracePeriodMs;

      if (elapsedMs > effectiveGracePeriodMs) {
        const updatedState: PositionRatchetState = {
          ...state,
          peakPriceSol: nextPeakPriceSol,
          peakGainBps: nextPeakGainBps,
          currentStopFloorBps: nextFloorBps,
          activeTier: "TIER_0_DRAWDOWN",
          drawdownState: nextDrawdownState,
          drawdownEnteredAtMs: nextDrawdownEnteredAtMs,
          lastEvaluatedAtMs: context.currentTimestampMs,
          ...(armedBreakeven ? { armedBreakeven: true } : {}),
          tier1ProfitTaken,
          tier2ProfitTaken,
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
        ...(armedBreakeven ? { armedBreakeven: true } : {}),
        tier1ProfitTaken,
        tier2ProfitTaken,
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
      currentPnlBps >= activeConfig.drawdownRecoveryBps
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
      ...(armedBreakeven ? { armedBreakeven: true } : {}),
      tier1ProfitTaken,
      tier2ProfitTaken,
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
