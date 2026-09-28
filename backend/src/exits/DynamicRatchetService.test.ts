import { describe, expect, it } from "vitest";
import { DynamicRatchetService } from "./DynamicRatchetService.js";
import { RatchetStateStore } from "./RatchetStateStore.js";
import {
  type MarketEvaluationContext,
  MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
  ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
} from "./DynamicRatchetTypes.js";

describe("DynamicRatchetService", () => {
  const baseContext: MarketEvaluationContext = {
    spotPriceSol: 1.0,
    lpIntact: true,
    recentBuysCount60s: 10,
    recentSellsCount60s: 5,
    momentum5mBps: 200,
    volumeStalled3m: false,
    currentTimestampMs: 1_000_000,
  };

  it("handles normal initial hold", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    const result = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 1.05,
    });

    expect(result.action).toBe("HOLD");
    expect(result.reasonCode).toBe("HOLD_NORMAL");
    expect(result.updatedState.peakPriceSol).toBe(1.05);
    expect(result.updatedState.peakGainBps).toBe(500);
  });

  it("ReEval_Dip_HealthyRecovery: holds through -8.5% dip with healthy metrics and recovers", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    // 1. Dip to -8.5%
    const dipResult = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 0.915, // -8.5% = -850 bps
      lpIntact: true,
      recentBuysCount60s: 12,
      recentSellsCount60s: 6,
      currentTimestampMs: 1_000_010,
    });

    expect(dipResult.action).toBe("HOLD");
    expect(dipResult.reasonCode).toBe("HOLD_DRAWDOWN_GRACE");
    expect(dipResult.updatedState.drawdownState).toBe("EVALUATING_DRAWDOWN");
    expect(dipResult.updatedState.drawdownEnteredAtMs).toBe(1_000_010);

    // 2. Recovery to -4.0%
    const recoveryResult = service.evaluate(dipResult.updatedState, {
      ...baseContext,
      spotPriceSol: 0.96, // -4.0% = -400 bps (>= -500 bps recovery threshold)
      currentTimestampMs: 1_000_050,
    });

    expect(recoveryResult.action).toBe("HOLD");
    expect(recoveryResult.reasonCode).toBe("HOLD_NORMAL");
    expect(recoveryResult.updatedState.drawdownState).toBe("NORMAL");
    expect(recoveryResult.updatedState.drawdownEnteredAtMs).toBeNull();
  });

  it("ReEval_Rug_Pull_ImmediateExit: immediately exits if LP modified during -8.5% dip", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    const result = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 0.915,
      lpIntact: false, // LP pulled!
      currentTimestampMs: 1_000_010,
    });

    expect(result.action).toBe("SELL_ALL");
    expect(result.reasonCode).toBe("RUG_PULL_DETECTED");
  });

  it("ReEval_NoBuyers_ImmediateExit: immediately exits if no buyers or sell wave overwhelms", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    const result = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 0.915,
      lpIntact: true,
      recentBuysCount60s: 0, // No buys in 60s
      recentSellsCount60s: 8,
      currentTimestampMs: 1_000_010,
    });

    expect(result.action).toBe("SELL_ALL");
    expect(result.reasonCode).toBe("SELL_PRESSURE_UNABSORBED");
  });

  it("ReEval_Catastrophic_HardStop: immediately exits when price drops to -12.1%", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    const result = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 0.879, // -12.1% = -1210 bps
      lpIntact: true,
      recentBuysCount60s: 20,
      recentSellsCount60s: 5,
      currentTimestampMs: 1_000_010,
    });

    expect(result.action).toBe("SELL_ALL");
    expect(result.reasonCode).toBe("CATASTROPHIC_HARD_STOP");
  });

  it("ReEval_Grace_Timeout_Exit: exits after 120s grace period without recovery", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    // Initial dip entry at t = 1,000,000
    const dipResult = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 0.915,
      lpIntact: true,
      recentBuysCount60s: 10,
      recentSellsCount60s: 5,
      currentTimestampMs: 1_000_000,
    });

    expect(dipResult.action).toBe("HOLD");

    // Evaluation after 125 seconds (125,000ms > 120,000ms grace)
    const timeoutResult = service.evaluate(dipResult.updatedState, {
      ...baseContext,
      spotPriceSol: 0.915,
      lpIntact: true,
      recentBuysCount60s: 10,
      recentSellsCount60s: 5,
      currentTimestampMs: 1_125_000,
    });

    expect(timeoutResult.action).toBe("SELL_ALL");
    expect(timeoutResult.reasonCode).toBe("DRAWDOWN_GRACE_EXPIRED");
  });

  it("Ratchet_ScratchExit_Triggered: triggers scratch exit when gain is +1.0% and momentum stalls", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    const result = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 1.01, // +1.0% = 100 bps
      momentum5mBps: -5, // stalled momentum
      currentTimestampMs: 1_000_100,
    });

    expect(result.action).toBe("SELL_ALL");
    expect(result.reasonCode).toBe("SCRATCH_EXIT");
  });

  it("Ratchet_Tier1_Lock: triggers SELL_PARTIAL_50 at +15% peak, locks floor at breakeven +0%, and exits on drop below floor", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    // Peak at +15%
    const peakResult = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 1.15, // +15% = 1500 bps (>= 1500 bps Tier 1 threshold)
      currentTimestampMs: 1_000_100,
    });

    expect(peakResult.action).toBe("SELL_PARTIAL_50");
    expect(peakResult.reasonCode).toBe("RATCHET_TIER_1_TRIGGERED");
    expect(peakResult.updatedState.activeTier).toBe("TIER_1");
    expect(peakResult.updatedState.currentStopFloorBps).toBe(0); // Locked at breakeven +0%
    expect(peakResult.updatedState.tier1ProfitTaken).toBe(true);

    // Retracement to -0.5% (below breakeven floor)
    const exitResult = service.evaluate(peakResult.updatedState, {
      ...baseContext,
      spotPriceSol: 0.995, // -0.5% = -50 bps (<= 0 bps floor)
      currentTimestampMs: 1_000_200,
    });

    expect(exitResult.action).toBe("SELL_ALL");
    expect(exitResult.reasonCode).toBe("RATCHET_TIER_1_TRIGGERED");
  });

  it("SmartHold_Recovery_Breakeven: recovers from drawdown to +8.0% and locks stop floor to breakeven +0%", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    // 1. Enter drawdown grace (-8.5%)
    const dipResult = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 0.915,
      lpIntact: true,
      recentBuysCount60s: 15,
      recentSellsCount60s: 5,
      currentTimestampMs: 1_000_010,
    });
    expect(dipResult.action).toBe("HOLD");
    expect(dipResult.updatedState.drawdownState).toBe("EVALUATING_DRAWDOWN");

    // 2. Rally to +8.0% (+800 bps) -> recovers to NORMAL and locks floor to breakeven +0%
    const recoveryResult = service.evaluate(dipResult.updatedState, {
      ...baseContext,
      spotPriceSol: 1.08, // +8.0% = 800 bps
      currentTimestampMs: 1_000_050,
    });
    expect(recoveryResult.action).toBe("HOLD");
    expect(recoveryResult.updatedState.drawdownState).toBe("NORMAL");
    expect(recoveryResult.updatedState.currentStopFloorBps).toBe(0); // Locked to breakeven!

    // 3. Drop to -0.5% -> exits because floor is locked at breakeven
    const exitResult = service.evaluate(recoveryResult.updatedState, {
      ...baseContext,
      spotPriceSol: 0.995,
      currentTimestampMs: 1_000_090,
    });
    expect(exitResult.action).toBe("SELL_ALL");
  });

  it("HardTakeProfit_Cap: triggers SELL_ALL when spot reaches configured hardTakeProfitBps", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({ hardTakeProfitBps: 10000 }, store); // +100% hard cap
    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    const capResult = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 2.05, // +105% = 10500 bps (>= 10000 bps)
      currentTimestampMs: 1_000_100,
    });

    expect(capResult.action).toBe("SELL_ALL");
    expect(capResult.reasonCode).toBe("HARD_TAKE_PROFIT_CAP_TRIGGERED");
  });

  it("Ratchet_Tier2_Lock: triggers SELL_PARTIAL_25 at +50% peak, locks floor at +40%, and exits on drop below floor", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    // Reach Tier 1 first (+15%)
    const tier1Result = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 1.15,
      currentTimestampMs: 1_000_100,
    });
    expect(tier1Result.action).toBe("SELL_PARTIAL_50");

    // Peak at +50%
    const peakResult = service.evaluate(tier1Result.updatedState, {
      ...baseContext,
      spotPriceSol: 1.5, // +50% = 5000 bps (>= 4900 bps Tier 2 threshold)
      currentTimestampMs: 1_000_150,
    });

    expect(peakResult.action).toBe("SELL_PARTIAL_25");
    expect(peakResult.reasonCode).toBe("RATCHET_TIER_2_TRIGGERED");
    expect(peakResult.updatedState.activeTier).toBe("TIER_2");
    expect(peakResult.updatedState.currentStopFloorBps).toBe(4000); // Locked at +40%
    expect(peakResult.updatedState.tier2ProfitTaken).toBe(true);

    // Retracement to +39% (below +40% floor)
    const exitResult = service.evaluate(peakResult.updatedState, {
      ...baseContext,
      spotPriceSol: 1.39, // +39% = 3900 bps (<= 4000 bps floor)
      currentTimestampMs: 1_000_200,
    });

    expect(exitResult.action).toBe("SELL_ALL");
    expect(exitResult.reasonCode).toBe("RATCHET_TIER_2_TRIGGERED");
  });

  it("Ratchet_Monotonicity_Check: prevents lowering stop floor once locked", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    // Reach Tier 1 (+25% peak -> floor 0 bps)
    const tier1Result = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 1.25,
    });
    expect(tier1Result.updatedState.currentStopFloorBps).toBe(0);

    // Reach Tier 2 (+50% peak -> floor +40% = 4000 bps)
    const tier2Result = service.evaluate(tier1Result.updatedState, {
      ...baseContext,
      spotPriceSol: 1.5,
    });
    expect(tier2Result.updatedState.currentStopFloorBps).toBe(4000);

    // Attempt to manually lower floor in store
    expect(() => {
      store.update({
        ...tier2Result.updatedState,
        currentStopFloorBps: 3500, // lower than 4000!
      });
    }).toThrow(/Monotonicity violation/);
  });

  it("validates input boundary invariants", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);

    expect(() => {
      store.initPositionState("pos-1", "mint-1", 0, 1_000_000);
    }).toThrow(/Invalid entryPriceSol/);

    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    expect(() => {
      service.evaluate(state, {
        ...baseContext,
        spotPriceSol: -1,
      });
    }).toThrow(/Invalid spotPriceSol/);
  });

  it("Cohort_Ratchets: MICRO_CAP_DYNAMIC_RATCHET_CONFIG triggers Tier 1 at +10%, Tier 2 at +25%, and 45s grace period", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-micro-1", "mint-micro", 1.0, 1_000_000);

    // 1. Tier 1 at +10% (1000 bps)
    const t1 = service.evaluate(
      state,
      {
        ...baseContext,
        spotPriceSol: 1.1,
        currentTimestampMs: 1_000_010,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(t1.action).toBe("SELL_PARTIAL_50");
    expect(t1.reasonCode).toBe("RATCHET_TIER_1_TRIGGERED");
    expect(t1.updatedState.currentStopFloorBps).toBe(0);

    // 2. Tier 2 at +25% (2500 bps)
    const t2 = service.evaluate(
      t1.updatedState,
      {
        ...baseContext,
        spotPriceSol: 1.25,
        currentTimestampMs: 1_000_020,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(t2.action).toBe("SELL_PARTIAL_25");
    expect(t2.reasonCode).toBe("RATCHET_TIER_2_TRIGGERED");
    expect(t2.updatedState.currentStopFloorBps).toBe(1800);

    // 3. 45s grace period on drawdown (-600 bps)
    const state2 = store.initPositionState("pos-micro-2", "mint-micro-2", 1.0, 1_000_000);
    const dip = service.evaluate(
      state2,
      {
        ...baseContext,
        spotPriceSol: 0.93, // -7.0% <= -6.0% trigger
        recentBuysCount60s: 5,
        recentSellsCount60s: 3,
        currentTimestampMs: 1_000_000,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(dip.action).toBe("HOLD");
    expect(dip.reasonCode).toBe("HOLD_DRAWDOWN_GRACE");

    // After 46 seconds (> 45s), grace expires
    const expired = service.evaluate(
      dip.updatedState,
      {
        ...baseContext,
        spotPriceSol: 0.93,
        recentBuysCount60s: 5,
        recentSellsCount60s: 3,
        currentTimestampMs: 1_000_000 + 46_000,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(expired.action).toBe("SELL_ALL");
    expect(expired.reasonCode).toBe("DRAWDOWN_GRACE_EXPIRED");
  });

  it("Cohort_Ratchets: ESTABLISHED_DYNAMIC_RATCHET_CONFIG triggers Tier 1 at +15%, Tier 2 at +50%, and -18% hard stop", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-est-1", "mint-est", 1.0, 1_000_000);

    // Below +15% (e.g. +12%) does not trigger Tier 1 for established
    const underT1 = service.evaluate(
      state,
      {
        ...baseContext,
        spotPriceSol: 1.12,
        currentTimestampMs: 1_000_010,
      },
      ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
    );
    expect(underT1.action).toBe("HOLD");

    // Tier 1 at +15%
    const t1 = service.evaluate(
      underT1.updatedState,
      {
        ...baseContext,
        spotPriceSol: 1.15,
        currentTimestampMs: 1_000_020,
      },
      ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
    );
    expect(t1.action).toBe("SELL_PARTIAL_50");
    expect(t1.reasonCode).toBe("RATCHET_TIER_1_TRIGGERED");

    // Tier 2 at +50%
    const t2 = service.evaluate(
      t1.updatedState,
      {
        ...baseContext,
        spotPriceSol: 1.5,
        currentTimestampMs: 1_000_030,
      },
      ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
    );
    expect(t2.action).toBe("SELL_PARTIAL_25");
    expect(t2.reasonCode).toBe("RATCHET_TIER_2_TRIGGERED");
    expect(t2.updatedState.currentStopFloorBps).toBe(4000);

    // Hard stop at -18.0%: at -15.0% it does NOT trigger catastrophic stop for established
    const state2 = store.initPositionState("pos-est-2", "mint-est-2", 1.0, 1_000_000);
    const dip15 = service.evaluate(
      state2,
      {
        ...baseContext,
        spotPriceSol: 0.85, // -15.0%
        recentBuysCount60s: 5,
        recentSellsCount60s: 2,
        currentTimestampMs: 1_000_010,
      },
      ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
    );
    expect(dip15.action).toBe("HOLD"); // In grace period, not catastrophic stop!

    // Catastrophic hard stop at -18.1%
    const hardStop = service.evaluate(
      dip15.updatedState,
      {
        ...baseContext,
        spotPriceSol: 0.819, // -18.1% <= -18.0%
        currentTimestampMs: 1_000_020,
      },
      ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
    );
    expect(hardStop.action).toBe("SELL_ALL");
    expect(hardStop.reasonCode).toBe("CATASTROPHIC_HARD_STOP");
  });
});
