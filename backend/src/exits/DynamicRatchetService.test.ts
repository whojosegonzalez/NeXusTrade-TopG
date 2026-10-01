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
      recentBuysCount60s: 6,
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

  it("Ratchet_Tier1_Lock: triggers SELL_PARTIAL_50 at +20% peak, locks floor at +10%, and exits on drop below floor", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    // Peak at +20%
    const peakResult = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 1.2, // +20% = 2000 bps (>= 2000 bps Tier 1 threshold)
      currentTimestampMs: 1_000_100,
    });

    expect(peakResult.action).toBe("SELL_PARTIAL_50");
    expect(peakResult.reasonCode).toBe("RATCHET_TIER_1_TRIGGERED");
    expect(peakResult.updatedState.activeTier).toBe("TIER_1");
    expect(peakResult.updatedState.currentStopFloorBps).toBe(1000); // Locked at +10%
    expect(peakResult.updatedState.tier1ProfitTaken).toBe(true);

    // Retracement to +9.5% (below +10% floor)
    const exitResult = service.evaluate(peakResult.updatedState, {
      ...baseContext,
      spotPriceSol: 1.095, // +9.5% = 950 bps (<= 1000 bps floor)
      currentTimestampMs: 1_000_200,
    });

    expect(exitResult.action).toBe("SELL_ALL");
    expect(exitResult.reasonCode).toBe("RATCHET_TIER_1_BREACH");
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

    // Reach Tier 1 first (+20%)
    const tier1Result = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 1.2,
      currentTimestampMs: 1_000_100,
    });
    expect(tier1Result.action).toBe("SELL_PARTIAL_50");

    // Peak at +48.5% (4850 bps Tier 2 threshold)
    const peakResult = service.evaluate(tier1Result.updatedState, {
      ...baseContext,
      spotPriceSol: 1.485, // +48.5% = 4850 bps
      currentTimestampMs: 1_000_150,
    });

    expect(peakResult.action).toBe("SELL_PARTIAL_25");
    expect(peakResult.reasonCode).toBe("RATCHET_TIER_2_TRIGGERED");
    expect(peakResult.updatedState.activeTier).toBe("TIER_2");
    expect(peakResult.updatedState.currentStopFloorBps).toBe(3500); // Locked at +35%
    expect(peakResult.updatedState.tier2ProfitTaken).toBe(true);

    // Retracement to +34% (below +35% floor)
    const exitResult = service.evaluate(peakResult.updatedState, {
      ...baseContext,
      spotPriceSol: 1.34, // +34% = 3400 bps (<= 3500 bps floor)
      currentTimestampMs: 1_000_200,
    });

    expect(exitResult.action).toBe("SELL_ALL");
    expect(exitResult.reasonCode).toBe("RATCHET_TIER_2_BREACH");
  });

  it("Ratchet_Monotonicity_Check: prevents lowering stop floor once locked", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-1", "mint-1", 1.0, 1_000_000);

    // Reach Tier 1 (+25% peak -> floor +10% = 1000 bps)
    const tier1Result = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 1.25,
    });
    expect(tier1Result.updatedState.currentStopFloorBps).toBe(1000);

    // Reach Tier 2 (+50% peak -> floor +35% = 3500 bps)
    const tier2Result = service.evaluate(tier1Result.updatedState, {
      ...baseContext,
      spotPriceSol: 1.5,
    });
    expect(tier2Result.updatedState.currentStopFloorBps).toBe(3500);

    // Attempt to manually lower floor in store
    expect(() => {
      store.update({
        ...tier2Result.updatedState,
        currentStopFloorBps: 3000, // lower than 3500!
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

  it("Cohort_Ratchets: MICRO_CAP_DYNAMIC_RATCHET_CONFIG triggers Tier 1 at +20%, Tier 2 at +48.5%, and 90s grace period", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-micro-1", "mint-micro", 1.0, 1_000_000);

    // 1. Arm breakeven at +10% (1000 bps) without selling
    const armed = service.evaluate(
      state,
      {
        ...baseContext,
        spotPriceSol: 1.1,
        currentTimestampMs: 1_000_010,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(armed.action).toBe("HOLD");
    expect(armed.updatedState.armedBreakeven).toBe(true);
    expect(armed.updatedState.currentStopFloorBps).toBe(0);

    // 2. Tier 1 at +20% (2000 bps) -> sell 50%, lock floor to +10% (1000 bps)
    const t1 = service.evaluate(
      armed.updatedState,
      {
        ...baseContext,
        spotPriceSol: 1.2,
        currentTimestampMs: 1_000_015,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(t1.action).toBe("SELL_PARTIAL_50");
    expect(t1.reasonCode).toBe("RATCHET_TIER_1_TRIGGERED");
    expect(t1.updatedState.currentStopFloorBps).toBe(1000);

    // 3. Tier 2 at +48.5% (4850 bps)
    const t2 = service.evaluate(
      t1.updatedState,
      {
        ...baseContext,
        spotPriceSol: 1.485,
        currentTimestampMs: 1_000_020,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(t2.action).toBe("SELL_PARTIAL_25");
    expect(t2.reasonCode).toBe("RATCHET_TIER_2_TRIGGERED");
    expect(t2.updatedState.currentStopFloorBps).toBe(3500);

    // 4. 90s base grace period on drawdown (-600 bps)
    const state2 = store.initPositionState("pos-micro-2", "mint-micro-2", 1.0, 1_000_000);
    const dip = service.evaluate(
      state2,
      {
        ...baseContext,
        spotPriceSol: 0.93, // -7.0% <= -6.0% trigger
        recentBuysCount60s: 5,
        recentSellsCount60s: 5, // 1.0x ratio (no strong buyer dominance)
        currentTimestampMs: 1_000_000,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(dip.action).toBe("HOLD");
    expect(dip.reasonCode).toBe("HOLD_DRAWDOWN_GRACE");

    // After 91 seconds (> 90s), base grace expires
    const expired = service.evaluate(
      dip.updatedState,
      {
        ...baseContext,
        spotPriceSol: 0.93,
        recentBuysCount60s: 5,
        recentSellsCount60s: 5,
        currentTimestampMs: 1_000_000 + 91_000,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(expired.action).toBe("SELL_ALL");
    expect(expired.reasonCode).toBe("DRAWDOWN_GRACE_EXPIRED");
  });

  it("Cohort_Ratchets: ESTABLISHED_DYNAMIC_RATCHET_CONFIG triggers Tier 1 at +20%, Tier 2 at +48.5%, and -18% hard stop", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-est-1", "mint-est", 1.0, 1_000_000);

    // Below +20% (e.g. +12%) arms breakeven at +10% but holds without selling
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
    expect(underT1.updatedState.armedBreakeven).toBe(true);

    // Tier 1 at +20%
    const t1 = service.evaluate(
      underT1.updatedState,
      {
        ...baseContext,
        spotPriceSol: 1.2,
        currentTimestampMs: 1_000_020,
      },
      ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
    );
    expect(t1.action).toBe("SELL_PARTIAL_50");
    expect(t1.reasonCode).toBe("RATCHET_TIER_1_TRIGGERED");
    expect(t1.updatedState.currentStopFloorBps).toBe(1000);

    // Tier 2 at +48.5%
    const t2 = service.evaluate(
      t1.updatedState,
      {
        ...baseContext,
        spotPriceSol: 1.485,
        currentTimestampMs: 1_000_030,
      },
      ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
    );
    expect(t2.action).toBe("SELL_PARTIAL_25");
    expect(t2.reasonCode).toBe("RATCHET_TIER_2_TRIGGERED");
    expect(t2.updatedState.currentStopFloorBps).toBe(3500);

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

  it("SubPhase12_81: Dynamic Grace Extension up to 180s when buyer dominance >= 1.25x", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-dyn-1", "mint-dyn", 1.0, 1_000_000);

    // Enter drawdown at t=0
    const dip = service.evaluate(
      state,
      {
        ...baseContext,
        spotPriceSol: 0.92, // -8.0%
        recentBuysCount60s: 25,
        recentSellsCount60s: 10, // 2.5x buyer dominance!
        currentTimestampMs: 1_000_000,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(dip.action).toBe("HOLD");
    expect(dip.reasonCode).toBe("HOLD_DRAWDOWN_GRACE");

    // At t=120s (> 90s base grace), buyer dominance extends grace up to 180s
    const extended = service.evaluate(
      dip.updatedState,
      {
        ...baseContext,
        spotPriceSol: 0.92,
        recentBuysCount60s: 20,
        recentSellsCount60s: 10, // 2.0x buyer dominance >= 1.25x
        currentTimestampMs: 1_000_000 + 120_000,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(extended.action).toBe("HOLD");
    expect(extended.reasonCode).toBe("HOLD_DRAWDOWN_GRACE");

    // At t=181s (> 180s), grace finally expires
    const expired = service.evaluate(
      extended.updatedState,
      {
        ...baseContext,
        spotPriceSol: 0.92,
        recentBuysCount60s: 20,
        recentSellsCount60s: 10,
        currentTimestampMs: 1_000_000 + 181_000,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(expired.action).toBe("SELL_ALL");
    expect(expired.reasonCode).toBe("DRAWDOWN_GRACE_EXPIRED");
  });

  it("SubPhase12_81: Flow-Aware Hard Stop cuts unabsorbed sell pressure between -12% and -20%, but allows strong buyers room", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);

    // Scenario A: Strong buyers (823 buys vs 586 sells, like SNOWBALL) at -14.0%
    const stateA = store.initPositionState("pos-flow-1", "mint-flow-1", 1.0, 1_000_000);
    const resultA = service.evaluate(
      stateA,
      {
        ...baseContext,
        spotPriceSol: 0.86, // -14.0% = -1400 bps
        recentBuysCount60s: 823,
        recentSellsCount60s: 586, // 1.4x buyer dominance >= 1.25x
        currentTimestampMs: 1_000_010,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(resultA.action).toBe("HOLD"); // Breathes through the wick!
    expect(resultA.reasonCode).toBe("HOLD_DRAWDOWN_GRACE");

    // Scenario B: Unabsorbed sell pressure at -14.0% (5 buys vs 20 sells)
    const stateB = store.initPositionState("pos-flow-2", "mint-flow-2", 1.0, 1_000_000);
    const resultB = service.evaluate(
      stateB,
      {
        ...baseContext,
        spotPriceSol: 0.86, // -14.0%
        recentBuysCount60s: 5,
        recentSellsCount60s: 20, // sells >> buys
        currentTimestampMs: 1_000_010,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(resultB.action).toBe("SELL_ALL");
    expect(resultB.reasonCode).toBe("SELL_PRESSURE_UNABSORBED");

    // Scenario C: Catastrophic hard stop breach at -20.1% (-2010 bps)
    const stateC = store.initPositionState("pos-flow-3", "mint-flow-3", 1.0, 1_000_000);
    const resultC = service.evaluate(
      stateC,
      {
        ...baseContext,
        spotPriceSol: 0.799, // -20.1% <= -20.0%
        recentBuysCount60s: 100,
        recentSellsCount60s: 50,
        currentTimestampMs: 1_000_010,
      },
      MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    );
    expect(resultC.action).toBe("SELL_ALL");
    expect(resultC.reasonCode).toBe("CATASTROPHIC_HARD_STOP");
  });

  it("SubPhase12_81: Dynamic Trailing Moonbag trails 25.0% below peak gain for Tier 2 runners", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-moon-1", "mint-moon-1", 1.0, 1_000_000);

    // 1. Tier 1 at +20%
    const t1 = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 1.2,
      currentTimestampMs: 1_000_010,
    });
    expect(t1.action).toBe("SELL_PARTIAL_50");

    // 2. Surge to +90.0% (9000 bps) -> Tier 2 triggered and trailing floor locks to 9000 - 2500 = 6500 bps (+65%)
    const runner = service.evaluate(t1.updatedState, {
      ...baseContext,
      spotPriceSol: 1.9, // +90.0%
      currentTimestampMs: 1_000_020,
    });
    expect(runner.action).toBe("SELL_PARTIAL_25");
    expect(runner.updatedState.currentStopFloorBps).toBe(6500); // 90% - 25% = +65% floor!

    // 3. Shallow pullback to +70.0% -> holds!
    const pullback = service.evaluate(runner.updatedState, {
      ...baseContext,
      spotPriceSol: 1.7, // +70.0% > 65.0% floor
      currentTimestampMs: 1_000_030,
    });
    expect(pullback.action).toBe("HOLD");

    // 4. Drop to +64.0% (below +65.0% trailing moonbag floor) -> exits with RATCHET_TIER_2_BREACH
    const breach = service.evaluate(pullback.updatedState, {
      ...baseContext,
      spotPriceSol: 1.64, // +64.0% <= 65.0% floor
      currentTimestampMs: 1_000_040,
    });
    expect(breach.action).toBe("SELL_ALL");
    expect(breach.reasonCode).toBe("RATCHET_TIER_2_BREACH");
  });

  it("SubPhase12_81: Unlatches SCRATCH tier badge to RUNNING when price expands above scratch band", () => {
    const store = new RatchetStateStore();
    const service = new DynamicRatchetService({}, store);
    const state = store.initPositionState("pos-scratch-1", "mint-scratch-1", 1.0, 1_000_000);

    // Enter scratch band (+1.0%) with active momentum -> activeTier becomes SCRATCH
    const inScratch = service.evaluate(state, {
      ...baseContext,
      spotPriceSol: 1.01, // +1.0% = 100 bps
      momentum5mBps: 20, // positive momentum -> holds in scratch tier
      currentTimestampMs: 1_000_010,
    });
    expect(inScratch.action).toBe("HOLD");
    expect(inScratch.updatedState.activeTier).toBe("SCRATCH");

    // Price expands to +8.0% (> 1.5% max scratch) -> unlatches to RUNNING!
    const running = service.evaluate(inScratch.updatedState, {
      ...baseContext,
      spotPriceSol: 1.08, // +8.0% = 800 bps
      momentum5mBps: 50,
      currentTimestampMs: 1_000_020,
    });
    expect(running.action).toBe("HOLD");
    expect(running.updatedState.activeTier).toBe("RUNNING");
  });

  describe("SubPhase12_82: Armed Breakeven (+10%) & Tier 1 Take-Profit (+20%)", () => {
    it("arms breakeven at +10.0% without selling tokens (HOLD, 0 bps floor)", () => {
      const store = new RatchetStateStore();
      const service = new DynamicRatchetService({}, store);
      const state = store.initPositionState("pos-82-1", "mint-82-1", 1.0, 1_000_000);

      const res = service.evaluate(state, {
        ...baseContext,
        spotPriceSol: 1.1, // +10.0% = 1000 bps
        currentTimestampMs: 1_000_010,
      });

      expect(res.action).toBe("HOLD");
      expect(res.reasonCode).toBe("HOLD_NORMAL");
      expect(res.updatedState.armedBreakeven).toBe(true);
      expect(res.updatedState.currentStopFloorBps).toBe(0);
      expect(res.updatedState.activeTier).toBe("RUNNING");
    });

    it("drops back to breakeven after arming and exits with ARMED_BREAKEVEN_BREACH", () => {
      const store = new RatchetStateStore();
      const service = new DynamicRatchetService({}, store);
      const state = store.initPositionState("pos-82-2", "mint-82-2", 1.0, 1_000_000);

      // 1. Arm at +10%
      const armed = service.evaluate(state, {
        ...baseContext,
        spotPriceSol: 1.1,
        currentTimestampMs: 1_000_010,
      });
      expect(armed.updatedState.armedBreakeven).toBe(true);

      // 2. Fall to 0.0% (<= 0 bps floor)
      const breach = service.evaluate(armed.updatedState, {
        ...baseContext,
        spotPriceSol: 1.0, // 0.0%
        currentTimestampMs: 1_000_020,
      });

      expect(breach.action).toBe("SELL_ALL");
      expect(breach.reasonCode).toBe("ARMED_BREAKEVEN_BREACH");
    });

    it("triggers Tier 1 at +20.0%, locks floor to +10.0%, and drops to +10.0% exiting with RATCHET_TIER_1_BREACH", () => {
      const store = new RatchetStateStore();
      const service = new DynamicRatchetService({}, store);
      const state = store.initPositionState("pos-82-3", "mint-82-3", 1.0, 1_000_000);

      // 1. Surges to +20.0% (2000 bps)
      const t1 = service.evaluate(state, {
        ...baseContext,
        spotPriceSol: 1.2,
        currentTimestampMs: 1_000_010,
      });

      expect(t1.action).toBe("SELL_PARTIAL_50");
      expect(t1.reasonCode).toBe("RATCHET_TIER_1_TRIGGERED");
      expect(t1.updatedState.activeTier).toBe("TIER_1");
      expect(t1.updatedState.currentStopFloorBps).toBe(1000); // +10.0% locked floor

      // 2. Drops to +9.9% (below +10.0% floor)
      const breach = service.evaluate(t1.updatedState, {
        ...baseContext,
        spotPriceSol: 1.099, // +9.9% < 1000 bps
        currentTimestampMs: 1_000_020,
      });

      expect(breach.action).toBe("SELL_ALL");
      expect(breach.reasonCode).toBe("RATCHET_TIER_1_BREACH");
    });
  });

  describe("SubPhase12_85: Parabolic Moonbag Trailing Stop Tightening", () => {
    it("dynamically tightens moonbag trailing buffer from 25% to 15% at >= 100% gain, and to 10% at >= 200% gain", () => {
      const store = new RatchetStateStore();
      const service = new DynamicRatchetService({}, store);
      const state = store.initPositionState("pos-moon-1", "mint-moon-1", 1.0, 1_000_000);

      // 1. Reach Tier 1 first at +20% (1.20 SOL)
      const t1 = service.evaluate(state, {
        ...baseContext,
        spotPriceSol: 1.2,
        currentTimestampMs: 1_000_005,
      });
      expect(t1.action).toBe("SELL_PARTIAL_50");

      // 2. Surges to +60.0% (6000 bps) -> Tier 2 triggered with 25% buffer (floor = 6000 - 2500 = 3500 bps)
      const t2Initial = service.evaluate(t1.updatedState, {
        ...baseContext,
        spotPriceSol: 1.6,
        currentTimestampMs: 1_000_010,
      });
      expect(t2Initial.action).toBe("SELL_PARTIAL_25");
      expect(t2Initial.updatedState.activeTier).toBe("TIER_2");
      expect(t2Initial.updatedState.currentStopFloorBps).toBe(3500); // 6000 - 2500

      // 3. Parabolic surge to +120.0% (12000 bps) -> Buffer tightens to 15% (1500 bps), floor = 12000 - 1500 = 10500 bps
      const t2Parabolic = service.evaluate(t2Initial.updatedState, {
        ...baseContext,
        spotPriceSol: 2.2,
        currentTimestampMs: 1_000_020,
      });
      expect(t2Parabolic.action).toBe("HOLD");
      expect(t2Parabolic.updatedState.currentStopFloorBps).toBe(10500); // 12000 - 1500

      // 4. Super-parabolic surge to +220.0% (22000 bps) -> Buffer tightens to 10% (1000 bps), floor = 22000 - 1000 = 21000 bps
      const t2SuperParabolic = service.evaluate(t2Parabolic.updatedState, {
        ...baseContext,
        spotPriceSol: 3.2,
        currentTimestampMs: 1_000_030,
      });
      expect(t2SuperParabolic.action).toBe("HOLD");
      expect(t2SuperParabolic.updatedState.currentStopFloorBps).toBe(21000); // 22000 - 1000
    });
  });

  describe("SubPhase12_86: In-Trade Avalanche Sell-Pressure Emergency Cut", () => {
    it("triggers EMERGENCY_SELL_PRESSURE_CUT when position is underwater (pnl <= -4.0%) and sellers overwhelm (sells >= 25 in 60s & sells >= 3.0 * buys)", () => {
      const store = new RatchetStateStore();
      const service = new DynamicRatchetService({}, store);
      const state = store.initPositionState("pos-emergency-1", "mint-emergency-1", 1.0, 1_000_000);

      // Price dips to -4.5% (-450 bps, 0.955 SOL) with severe seller avalanche: 30 sells vs 5 buys in 60s (ratio 6.0x >= 3.0x)
      const result = service.evaluate(state, {
        ...baseContext,
        spotPriceSol: 0.955,
        recentSellsCount60s: 30,
        recentBuysCount60s: 5,
        currentTimestampMs: 1_000_015,
      });

      expect(result.action).toBe("SELL_ALL");
      expect(result.reasonCode).toBe("EMERGENCY_SELL_PRESSURE_CUT");
      expect(result.updatedState.activeTier).toBe("HARD_STOP");
    });

    it("does not trigger EMERGENCY_SELL_PRESSURE_CUT if pnl is above -4.0% even with heavy sells", () => {
      const store = new RatchetStateStore();
      const service = new DynamicRatchetService({}, store);
      const state = store.initPositionState("pos-emergency-2", "mint-emergency-2", 1.0, 1_000_000);

      // Price is only down -2.5% (-250 bps, 0.975 SOL) with 30 sells vs 5 buys
      const result = service.evaluate(state, {
        ...baseContext,
        spotPriceSol: 0.975,
        recentSellsCount60s: 30,
        recentBuysCount60s: 5,
        currentTimestampMs: 1_000_015,
      });

      expect(result.action).toBe("HOLD");
      expect(result.reasonCode).not.toBe("EMERGENCY_SELL_PRESSURE_CUT");
    });

    it("does not trigger EMERGENCY_SELL_PRESSURE_CUT if sell volume is not overwhelming (< 3x buys or < 25 sells)", () => {
      const store = new RatchetStateStore();
      const service = new DynamicRatchetService({}, store);
      const state = store.initPositionState("pos-emergency-3", "mint-emergency-3", 1.0, 1_000_000);

      // Price is down -5.0% (-500 bps, 0.95 SOL) but sells = 20 (< 25)
      const result = service.evaluate(state, {
        ...baseContext,
        spotPriceSol: 0.95,
        recentSellsCount60s: 20,
        recentBuysCount60s: 5,
        currentTimestampMs: 1_000_015,
      });

      expect(result.action).toBe("HOLD");
      expect(result.reasonCode).not.toBe("EMERGENCY_SELL_PRESSURE_CUT");
    });
  });

  describe("SubPhase12_87: Single-Tick Whale/Dev Dump Circuit Breaker", () => {
    it("triggers WHALE_DEV_DUMP_CLIFF_CUT when underwater (pnl <= -8.0%), zero buys, and single-tick drop <= -10.0%", () => {
      const store = new RatchetStateStore();
      const service = new DynamicRatchetService({}, store);
      const state = store.initPositionState("pos-cliff-1", "mint-cliff-1", 1.0, 1_000_000);

      // Price plunges in a single tick to 0.88 SOL (-12.0% pnl, -1200 bps single-tick drop), 0 buys
      const result = service.evaluate(state, {
        ...baseContext,
        spotPriceSol: 0.88,
        recentBuysCount60s: 0,
        recentSellsCount60s: 1, // Single massive dev dump transaction
        singleTickDropBps: -1200, // -12.0% <= -10.0% (-1000 bps)
        currentTimestampMs: 1_000_015,
      });

      expect(result.action).toBe("SELL_ALL");
      expect(result.reasonCode).toBe("WHALE_DEV_DUMP_CLIFF_CUT");
      expect(result.updatedState.activeTier).toBe("HARD_STOP");
    });

    it("does not trigger WHALE_DEV_DUMP_CLIFF_CUT if buyers are actively present (recentBuys > 0)", () => {
      const store = new RatchetStateStore();
      const service = new DynamicRatchetService({}, store);
      const state = store.initPositionState("pos-cliff-2", "mint-cliff-2", 1.0, 1_000_000);

      // Price dips to 0.90 SOL (-10.0% pnl, -1000 bps single-tick drop), but buyers are absorbing (6 buys vs 4 sells)
      const result = service.evaluate(state, {
        ...baseContext,
        spotPriceSol: 0.9,
        recentBuysCount60s: 6,
        recentSellsCount60s: 4,
        singleTickDropBps: -1000,
        currentTimestampMs: 1_000_015,
      });

      expect(result.action).toBe("HOLD");
      expect(result.reasonCode).toBe("HOLD_DRAWDOWN_GRACE");
      expect(result.reasonCode).not.toBe("WHALE_DEV_DUMP_CLIFF_CUT");
    });

    it("does not trigger WHALE_DEV_DUMP_CLIFF_CUT if single-tick drop is milder than -10.0% (e.g. -400 bps)", () => {
      const store = new RatchetStateStore();
      const service = new DynamicRatchetService({}, store);
      const state = store.initPositionState("pos-cliff-3", "mint-cliff-3", 1.0, 1_000_000);

      // Price is down -8.5% (-850 bps pnl), with healthy gradual pullback (5 buys vs 3 sells) and -4.0% single tick
      const result = service.evaluate(state, {
        ...baseContext,
        spotPriceSol: 0.915,
        recentBuysCount60s: 5,
        recentSellsCount60s: 3,
        singleTickDropBps: -400,
        currentTimestampMs: 1_000_015,
      });

      expect(result.action).toBe("HOLD");
      expect(result.reasonCode).toBe("HOLD_DRAWDOWN_GRACE");
      expect(result.reasonCode).not.toBe("WHALE_DEV_DUMP_CLIFF_CUT");
    });
  });
});
