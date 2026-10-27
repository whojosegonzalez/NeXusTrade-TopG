import { describe, expect, it } from "vitest";
import type { ArmedPullbackState } from "./BuyGateTriggerService.js";
import { evaluateRetestGate, type RetestSpotInfo } from "./RetestGateEvaluator.js";

describe("RetestGateEvaluator", () => {
  const mintAddress = "TestMint1111111111111111111111111111111111";

  const defaultSpotInfo: RetestSpotInfo = {
    spotPriceSol: 1.0,
    spotPriceUsd: 150.0,
    recentBuys60s: 20,
    recentSells60s: 10,
    liquidityUsd: 50_000,
  };

  describe("First-Tick Arming", () => {
    it("arms candidate on first tick with initial peak and tick count 1 for Micro-Cap", () => {
      const nowMs = 1_000_000;
      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: false,
        currentNowMs: nowMs,
        spotInfo: defaultSpotInfo,
        existingArmedState: undefined,
      });

      expect(result.status).toBe("ARMED_FIRST_TICK");
      if (result.status === "ARMED_FIRST_TICK") {
        expect(result.cohortLabel).toBe("MICRO_CAP");
        expect(result.targetWait).toBe("10-18% pullback or consolidation");
        expect(result.updatedArmedState).toEqual({
          mintAddress,
          armedAtMs: nowMs,
          peakPriceSol: 1.0,
          peakPriceUsd: 150.0,
          ticksObserved: 1,
        });
      }
    });

    it("arms candidate on first tick for Established cohort", () => {
      const nowMs = 1_000_000;
      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: true,
        currentNowMs: nowMs,
        spotInfo: defaultSpotInfo,
        existingArmedState: undefined,
      });

      expect(result.status).toBe("ARMED_FIRST_TICK");
      if (result.status === "ARMED_FIRST_TICK") {
        expect(result.cohortLabel).toBe("ESTABLISHED");
        expect(result.targetWait).toBe("4-8% pullback or consolidation");
        expect(result.updatedArmedState.ticksObserved).toBe(1);
      }
    });
  });

  describe("Peak Tracking and Tick Counting", () => {
    const existingArmed: ArmedPullbackState = {
      mintAddress,
      armedAtMs: 1_000_000,
      peakPriceSol: 1.0,
      peakPriceUsd: 150.0,
      ticksObserved: 1,
    };

    it("updates peak price and increments tick count when spot makes a new high", () => {
      const higherSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        spotPriceSol: 1.2,
        spotPriceUsd: 180.0,
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: false,
        currentNowMs: 1_010_000,
        spotInfo: higherSpot,
        existingArmedState: existingArmed,
      });

      expect(result.updatedArmedState.peakPriceSol).toBe(1.2);
      expect(result.updatedArmedState.peakPriceUsd).toBe(180.0);
      expect(result.updatedArmedState.ticksObserved).toBe(2);
    });

    it("preserves previous peak price and increments tick count when spot is lower", () => {
      const lowerSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        spotPriceSol: 0.98,
        spotPriceUsd: 147.0,
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: false,
        currentNowMs: 1_010_000,
        spotInfo: lowerSpot,
        existingArmedState: existingArmed,
      });

      expect(result.updatedArmedState.peakPriceSol).toBe(1.0);
      expect(result.updatedArmedState.peakPriceUsd).toBe(150.0);
      expect(result.updatedArmedState.ticksObserved).toBe(2);
    });
  });

  describe("Crater Drop Check (Rule C)", () => {
    const existingArmed: ArmedPullbackState = {
      mintAddress,
      armedAtMs: 1_000_000,
      peakPriceSol: 1.0,
      peakPriceUsd: 150.0,
      ticksObserved: 1,
    };

    it("rejects Micro-Cap plunging > 15% from peak with REJECTED_PULLBACK_CRATERED", () => {
      // 1.0 * (1 - 0.15) = 0.85; spot 0.849 < 0.85
      const craterSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        spotPriceSol: 0.849,
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: false,
        currentNowMs: 1_010_000,
        spotInfo: craterSpot,
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("REJECTED");
      if (result.status === "REJECTED") {
        expect(result.rejectReason).toBe("REJECTED_PULLBACK_CRATERED");
        expect(result.rejectionGateName).toBe("RetestCraterDrop");
        expect(result.maxCraterDropPct).toBe(0.15);
      }
    });

    it("rejects Established token plunging > 8% when unabsorbed with REJECTED_EXCESSIVE_PULLBACK", () => {
      // Unabsorbed flow: recentBuys60s < 1.15 * recentSells60s (e.g. 10 buys vs 10 sells)
      // Crater threshold: 8% (floor 0.92 SOL)
      const unabsorbedCraterSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        recentBuys60s: 10,
        recentSells60s: 10,
        spotPriceSol: 0.919, // < 0.92
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: true,
        currentNowMs: 1_010_000,
        spotInfo: unabsorbedCraterSpot,
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("REJECTED");
      if (result.status === "REJECTED") {
        expect(result.rejectReason).toBe("REJECTED_EXCESSIVE_PULLBACK");
        expect(result.rejectionGateName).toBe("RetestCraterDrop");
        expect(result.maxCraterDropPct).toBe(0.08);
      }
    });

    it("permits Established token with absorbing flow up to 12% crater ceiling before rejecting", () => {
      // Absorbing flow: recentBuys60s >= 1.15 * recentSells60s (20 buys vs 10 sells = 2.0x >= 1.15)
      // Crater threshold: 12% (floor 0.88 SOL)
      const spotAt10PctDrop: RetestSpotInfo = {
        ...defaultSpotInfo,
        recentBuys60s: 20,
        recentSells60s: 10,
        spotPriceSol: 0.9, // 10% drop, >= 0.88
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: true,
        currentNowMs: 1_010_000,
        spotInfo: spotAt10PctDrop,
        existingArmedState: existingArmed,
      });

      // Does not crater-reject at 10% drop because absorbing threshold is 12%
      expect(result.status).not.toBe("REJECTED");

      // Plunging past 12% (spot 0.879 < 0.88) does crater-reject
      const craterAbsorbingSpot: RetestSpotInfo = {
        ...spotAt10PctDrop,
        spotPriceSol: 0.879,
      };

      const rejectedResult = evaluateRetestGate({
        mintAddress,
        isEstablished: true,
        currentNowMs: 1_010_000,
        spotInfo: craterAbsorbingSpot,
        existingArmedState: existingArmed,
      });

      expect(rejectedResult.status).toBe("REJECTED");
      if (rejectedResult.status === "REJECTED") {
        expect(rejectedResult.rejectReason).toBe("REJECTED_EXCESSIVE_PULLBACK");
        expect(rejectedResult.maxCraterDropPct).toBe(0.12);
      }
    });
  });

  describe("In-Flight Seller Surge (Rule E)", () => {
    const existingArmed: ArmedPullbackState = {
      mintAddress,
      armedAtMs: 1_000_000,
      peakPriceSol: 1.0,
      peakPriceUsd: 150.0,
      ticksObserved: 1,
    };

    it("rejects when sells60s >= 25 and sells60s >= 2.5 * buys60s", () => {
      const surgeSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        spotPriceSol: 0.97, // within normal consolidation/pullback
        recentSells60s: 30, // >= 25
        recentBuys60s: 10, // 30 >= 2.5 * 10
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: false,
        currentNowMs: 1_010_000,
        spotInfo: surgeSpot,
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("REJECTED");
      if (result.status === "REJECTED") {
        expect(result.rejectReason).toBe("REJECTED_IN_FLIGHT_SELLER_SURGE");
        expect(result.rejectionGateName).toBe("RetestSellerSurge");
      }
    });

    it("does not reject for seller surge if sells60s < 25 even if sells ratio is high", () => {
      const surgeSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        spotPriceSol: 0.97,
        recentSells60s: 24, // < 25
        recentBuys60s: 5,
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: false,
        currentNowMs: 1_010_000,
        spotInfo: surgeSpot,
        existingArmedState: existingArmed,
      });

      expect(result.status).not.toBe("REJECTED");
    });
  });

  describe("Timeout Expiry Boundaries (Rule D)", () => {
    const armedAtMs = 1_000_000;
    const existingArmed: ArmedPullbackState = {
      mintAddress,
      armedAtMs,
      peakPriceSol: 1.0,
      peakPriceUsd: 150.0,
      ticksObserved: 1,
    };

    it("strictly evaluates 90s expiry for Micro-Cap cohort", () => {
      // Exactly at 90,000 ms: currentNowMs - armedAtMs === 90_000 (not > 90_000)
      const exactBoundary = evaluateRetestGate({
        mintAddress,
        isEstablished: false,
        currentNowMs: armedAtMs + 90_000,
        spotInfo: { ...defaultSpotInfo, spotPriceSol: 0.98 },
        existingArmedState: existingArmed,
      });
      expect(exactBoundary.status).not.toBe("REJECTED");

      // Past 90,000 ms: currentNowMs - armedAtMs === 90_001 (> 90_000)
      const expired = evaluateRetestGate({
        mintAddress,
        isEstablished: false,
        currentNowMs: armedAtMs + 90_001,
        spotInfo: { ...defaultSpotInfo, spotPriceSol: 0.98 },
        existingArmedState: existingArmed,
      });
      expect(expired.status).toBe("REJECTED");
      if (expired.status === "REJECTED") {
        expect(expired.rejectReason).toBe("REJECTED_PULLBACK_EXPIRED");
        expect(expired.rejectionGateName).toBe("RetestTimeout");
        expect(expired.maxExpiryMs).toBe(90_000);
      }
    });

    it("strictly evaluates 120s expiry for Established cohort", () => {
      // At 100,000 ms (past micro-cap expiry, but within established expiry)
      const withinEstablished = evaluateRetestGate({
        mintAddress,
        isEstablished: true,
        currentNowMs: armedAtMs + 100_000,
        spotInfo: { ...defaultSpotInfo, spotPriceSol: 0.98 },
        existingArmedState: existingArmed,
      });
      expect(withinEstablished.status).not.toBe("REJECTED");

      // Exactly at 120,000 ms
      const exactBoundary = evaluateRetestGate({
        mintAddress,
        isEstablished: true,
        currentNowMs: armedAtMs + 120_000,
        spotInfo: { ...defaultSpotInfo, spotPriceSol: 0.98 },
        existingArmedState: existingArmed,
      });
      expect(exactBoundary.status).not.toBe("REJECTED");

      // At 120,001 ms
      const expired = evaluateRetestGate({
        mintAddress,
        isEstablished: true,
        currentNowMs: armedAtMs + 120_001,
        spotInfo: { ...defaultSpotInfo, spotPriceSol: 0.98 },
        existingArmedState: existingArmed,
      });
      expect(expired.status).toBe("REJECTED");
      if (expired.status === "REJECTED") {
        expect(expired.rejectReason).toBe("REJECTED_PULLBACK_EXPIRED");
        expect(expired.maxExpiryMs).toBe(120_000);
      }
    });
  });

  describe("Rejection Evaluation Precedence", () => {
    const armedAtMs = 1_000_000;
    const existingArmed: ArmedPullbackState = {
      mintAddress,
      armedAtMs,
      peakPriceSol: 1.0,
      peakPriceUsd: 150.0,
      ticksObserved: 1,
    };

    it("prioritizes crater drop (Rule C) over seller surge (Rule E) and timeout (Rule D)", () => {
      // Plunged < 0.85 SOL, seller surge active, and expired past 90s
      const allFailSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        spotPriceSol: 0.5, // Plunged
        recentSells60s: 50,
        recentBuys60s: 5, // Surge
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: false,
        currentNowMs: armedAtMs + 100_000, // Expired
        spotInfo: allFailSpot,
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("REJECTED");
      if (result.status === "REJECTED") {
        expect(result.rejectionGateName).toBe("RetestCraterDrop");
        expect(result.rejectReason).toBe("REJECTED_PULLBACK_CRATERED");
      }
    });

    it("prioritizes seller surge (Rule E) over timeout expiry (Rule D) when crater drop does not trigger", () => {
      // Spot 0.95 (no crater), seller surge active, expired past 90s
      const surgeAndExpiredSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        spotPriceSol: 0.95,
        recentSells60s: 40,
        recentBuys60s: 10,
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: false,
        currentNowMs: armedAtMs + 100_000, // Expired
        spotInfo: surgeAndExpiredSpot,
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("REJECTED");
      if (result.status === "REJECTED") {
        expect(result.rejectionGateName).toBe("RetestSellerSurge");
        expect(result.rejectReason).toBe("REJECTED_IN_FLIGHT_SELLER_SURGE");
      }
    });
  });

  describe("Rule A: Pullback Discount Confirmation", () => {
    const existingArmed: ArmedPullbackState = {
      mintAddress,
      armedAtMs: 1_000_000,
      peakPriceSol: 1.0,
      peakPriceUsd: 150.0,
      ticksObserved: 1,
    };

    it("confirms Micro-Cap with 10-15% discount and >= 1.25x flow", () => {
      // 12% discount: spot 0.88 SOL (between 0.85 and 0.90)
      // Flow: 25 buys / 15 sells = 1.67x >= 1.25x
      const microPullbackSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        spotPriceSol: 0.88,
        recentBuys60s: 25,
        recentSells60s: 15,
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: false,
        currentNowMs: 1_020_000,
        spotInfo: microPullbackSpot,
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("CONFIRMED");
      if (result.status === "CONFIRMED") {
        expect(result.confirmReason).toBe("RETEST_PULLBACK_DISCOUNT");
      }
    });

    it("confirms Established with 4-10% discount and >= 1.15x flow", () => {
      // 6% discount: spot 0.94 SOL (between 0.90 and 0.96)
      // Flow: 20 buys / 15 sells = 1.33x >= 1.15x
      const establishedPullbackSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        spotPriceSol: 0.94,
        recentBuys60s: 20,
        recentSells60s: 15,
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: true,
        currentNowMs: 1_020_000,
        spotInfo: establishedPullbackSpot,
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("CONFIRMED");
      if (result.status === "CONFIRMED") {
        expect(result.confirmReason).toBe("RETEST_PULLBACK_DISCOUNT");
      }
    });
  });

  describe("Rule B: Consolidation Breakout Confirmation", () => {
    const existingArmed: ArmedPullbackState = {
      mintAddress,
      armedAtMs: 1_000_000,
      peakPriceSol: 1.0,
      peakPriceUsd: 150.0,
      ticksObserved: 1,
    };

    it("confirms Micro-Cap consolidation within 5% of peak for >= 30s with >= 1.5x flow", () => {
      // 2% drop: spot 0.98 SOL (>= 0.95)
      // Duration: 35s (>= 30s)
      // Flow: 30 buys / 15 sells = 2.0x >= 1.5x
      const consolidationSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        spotPriceSol: 0.98,
        recentBuys60s: 30,
        recentSells60s: 15,
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: false,
        currentNowMs: 1_035_000, // 35s elapsed
        spotInfo: consolidationSpot,
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("CONFIRMED");
      if (result.status === "CONFIRMED") {
        expect(result.confirmReason).toBe("CONSOLIDATION_BREAKOUT");
      }
    });

    it("confirms Micro-Cap consolidation when ticksObserved >= 3 even if < 30s elapsed", () => {
      const stateWith2Ticks: ArmedPullbackState = {
        ...existingArmed,
        ticksObserved: 2, // Next tick will be 3
      };

      const consolidationSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        spotPriceSol: 0.98,
        recentBuys60s: 30,
        recentSells60s: 15,
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: false,
        currentNowMs: 1_010_000, // only 10s elapsed
        spotInfo: consolidationSpot,
        existingArmedState: stateWith2Ticks,
      });

      expect(result.status).toBe("CONFIRMED");
      if (result.status === "CONFIRMED") {
        expect(result.confirmReason).toBe("CONSOLIDATION_BREAKOUT");
        expect(result.updatedArmedState.ticksObserved).toBe(3);
      }
    });

    it("confirms Established consolidation within 4% of peak with >= 1.25x flow", () => {
      // 3% drop: spot 0.97 SOL (>= 0.96)
      // Flow: 25 buys / 18 sells = 1.39x >= 1.25x
      const consolidationSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        spotPriceSol: 0.97,
        recentBuys60s: 25,
        recentSells60s: 18,
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: true,
        currentNowMs: 1_035_000, // 35s elapsed
        spotInfo: consolidationSpot,
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("CONFIRMED");
      if (result.status === "CONFIRMED") {
        expect(result.confirmReason).toBe("CONSOLIDATION_BREAKOUT");
      }
    });
  });

  describe("Confirmation Precedence", () => {
    it("prioritizes Rule A (RETEST_PULLBACK_DISCOUNT) over Rule B if both conditions are met", () => {
      // In Established:
      // Rule A: 0.90 to 0.96 with >= 1.15 flow
      // Rule B: >= 0.96 with >= 1.25 flow and >= 30s
      // Exactly at spot 0.96 SOL:
      // isPullbackDiscount: 0.96 <= 0.96 && 0.96 >= 0.90 (true)
      // isConsolidatingNearPeak: 0.96 >= 0.96 (true)
      const armed: ArmedPullbackState = {
        mintAddress,
        armedAtMs: 1_000_000,
        peakPriceSol: 1.0,
        peakPriceUsd: 150.0,
        ticksObserved: 3,
      };

      const overlappingSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        spotPriceSol: 0.96,
        recentBuys60s: 30,
        recentSells60s: 15, // 2.0x satisfies both 1.15x and 1.25x
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: true,
        currentNowMs: 1_040_000,
        spotInfo: overlappingSpot,
        existingArmedState: armed,
      });

      expect(result.status).toBe("CONFIRMED");
      if (result.status === "CONFIRMED") {
        expect(result.confirmReason).toBe("RETEST_PULLBACK_DISCOUNT");
      }
    });
  });

  describe("Waiting State", () => {
    it("returns WAITING with accurate pullback percentage when neither confirmed nor rejected", () => {
      const armed: ArmedPullbackState = {
        mintAddress,
        armedAtMs: 1_000_000,
        peakPriceSol: 1.0,
        peakPriceUsd: 150.0,
        ticksObserved: 1,
      };

      // 2% drop, but duration < 30s and ticks < 3 -> neither Rule A nor Rule B confirmed
      const waitingSpot: RetestSpotInfo = {
        ...defaultSpotInfo,
        spotPriceSol: 0.98,
        recentBuys60s: 10,
        recentSells60s: 10,
      };

      const result = evaluateRetestGate({
        mintAddress,
        isEstablished: false,
        currentNowMs: 1_010_000, // 10s elapsed
        spotInfo: waitingSpot,
        existingArmedState: armed,
      });

      expect(result.status).toBe("WAITING");
      if (result.status === "WAITING") {
        expect(result.pullbackPct).toBeCloseTo(-2.0, 1);
        expect(result.updatedArmedState.ticksObserved).toBe(2);
      }
    });
  });
});
