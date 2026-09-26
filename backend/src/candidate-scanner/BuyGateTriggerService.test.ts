import { describe, expect, it } from "vitest";
import type { WatchlistCandidateItem } from "@nexustrade/shared";
import { BuyGateTriggerService } from "./BuyGateTriggerService.js";

describe("BuyGateTriggerService", () => {
  const candidate: WatchlistCandidateItem = {
    poolId: "pool-cand-1",
    mintAddress: "TokenMintCand111111111111111111111111111111111",
    symbol: "CAND",
    liquidityUsd: 20_000,
    marketCapUsd: 80_000, // L/MC = 25% (within 15% - 30%)
    lmcRatio: 0.25,
    lpBurnPct: 99.0,
    assetAgeSeconds: 450, // 450s (within 300s - 900s)
    volume5mUsd: 6_000, // >= $2,500
    buys5m: 40,
    sells5m: 15, // Buys / Sells = 2.67x (>= 1.5x)
    buyToSellRatio: 2.67,
    status: "WATCHING",
    discoveredAt: new Date().toISOString(),
    lastEvaluatedAt: new Date().toISOString(),
  };

  it("confirms candidate and triggers buy when all quantitative gates pass", () => {
    const service = new BuyGateTriggerService();
    const result = service.evaluateCandidate(candidate, {
      maxSingleDisposalUsd: 500, // $500 / $20,000 = 2.5% <= 5%
      recentBuysCount60s: 8,
      recentSellsCount60s: 3,
      momentum1mBps: 100,
    });

    expect(result.triggered).toBe(true);
    expect(result.gates.length).toBe(7);
    expect(result.gates.every((g) => g.passed)).toBe(true);
    expect(result.rejectionReason).toBeUndefined();
  });

  it("fails when outside the maturity window", () => {
    const service = new BuyGateTriggerService();

    // Too young (150s)
    const tooYoung = service.evaluateCandidate({ ...candidate, assetAgeSeconds: 150 });
    expect(tooYoung.triggered).toBe(false);
    expect(tooYoung.rejectionReason).toBe("MATURITY_WINDOW_GATE_FAILED");

    // Too old for standard volume/liquidity (1000s)
    const tooOld = service.evaluateCandidate({ ...candidate, assetAgeSeconds: 1000 });
    expect(tooOld.triggered).toBe(false);
    expect(tooOld.rejectionReason).toBe("MATURITY_WINDOW_GATE_FAILED");
  });

  it("permits extended maturity age up to 2700s for high liquidity and volume candidates", () => {
    const service = new BuyGateTriggerService();

    // 1800s (30m) age with $25k liquidity and $30k volume -> passes adaptive window
    const extendedCandidate = {
      ...candidate,
      liquidityUsd: 25_000,
      volume5mUsd: 30_000,
      assetAgeSeconds: 1800,
    };
    const result = service.evaluateCandidate(extendedCandidate, { maxSingleDisposalUsd: 500 });
    expect(result.triggered).toBe(true);
    expect(result.gates.find((g) => g.name === "MATURITY_WINDOW_GATE")?.passed).toBe(true);
  });

  it("fails when L/MC depth ratio is outside 15% - 30% balance", () => {
    const service = new BuyGateTriggerService();

    // Low depth (10%)
    const lowDepth = service.evaluateCandidate({ ...candidate, lmcRatio: 0.1 });
    expect(lowDepth.triggered).toBe(false);
    expect(lowDepth.rejectionReason).toBe("DEPTH_BALANCE_GATE_FAILED");

    // High depth / thin cap (35%)
    const highDepth = service.evaluateCandidate({ ...candidate, lmcRatio: 0.35 });
    expect(highDepth.triggered).toBe(false);
    expect(highDepth.rejectionReason).toBe("DEPTH_BALANCE_GATE_FAILED");
  });

  it("fails when seller flow dominates or buyer dominance < 1.5x", () => {
    const service = new BuyGateTriggerService();

    const lowBuyerRatio = service.evaluateCandidate({
      ...candidate,
      buys5m: 20,
      sells5m: 20,
      buyToSellRatio: 1.0,
    });
    expect(lowBuyerRatio.triggered).toBe(false);
    expect(lowBuyerRatio.rejectionReason).toBe("FLOW_ABSORPTION_GATE_FAILED");
  });

  it("relaxes buy-to-sell ratio to 1.20x for high-volume breakouts (>= $50k)", () => {
    const service = new BuyGateTriggerService();

    // Volume $60k, buy/sell ratio 1.25 (would fail standard 1.50x, passes high-volume 1.20x)
    const highVolBreakout = {
      ...candidate,
      volume5mUsd: 60_000,
      buys5m: 50,
      sells5m: 40,
      buyToSellRatio: 1.25,
    };
    const result = service.evaluateCandidate(highVolBreakout, { maxSingleDisposalUsd: 500 });
    expect(result.triggered).toBe(true);
    expect(result.gates.find((g) => g.name === "FLOW_ABSORPTION_GATE")?.passed).toBe(true);
  });

  it("fails when 5m sells count is below 5 (anti-sniper trap protection)", () => {
    const service = new BuyGateTriggerService();

    const lowSells = service.evaluateCandidate({
      ...candidate,
      sells5m: 2, // only 2 sells
    });
    expect(lowSells.triggered).toBe(false);
    expect(lowSells.rejectionReason).toBe("MIN_SELLS_GATE_FAILED");
  });

  it("fails when short-horizon flow deteriorates (sells60s > buys60s or momentum1m < -5%)", () => {
    const service = new BuyGateTriggerService();

    // Sells outweigh buys in 60s
    const sellOverwhelm = service.evaluateCandidate(candidate, {
      recentBuysCount60s: 3,
      recentSellsCount60s: 8,
      momentum1mBps: 0,
    });
    expect(sellOverwhelm.triggered).toBe(false);
    expect(sellOverwhelm.rejectionReason).toBe("SHORT_HORIZON_FLOW_GATE_FAILED");

    // 1m momentum drops below -5% (-500 bps)
    const flashDrop = service.evaluateCandidate(candidate, {
      recentBuysCount60s: 5,
      recentSellsCount60s: 5,
      momentum1mBps: -650, // -6.5%
    });
    expect(flashDrop.triggered).toBe(false);
    expect(flashDrop.rejectionReason).toBe("SHORT_HORIZON_FLOW_GATE_FAILED");
  });

  it("fails when volume surge is insufficient (< $2,500)", () => {
    const service = new BuyGateTriggerService();

    const lowVolume = service.evaluateCandidate({ ...candidate, volume5mUsd: 1500 });
    expect(lowVolume.triggered).toBe(false);
    expect(lowVolume.rejectionReason).toBe("VOLUME_SURGE_GATE_FAILED");

    // Extreme low-activity token ($119 volume, 1 transaction)
    const lowActivityToken = service.evaluateCandidate({
      ...candidate,
      volume5mUsd: 119,
      buys5m: 1,
      sells5m: 0,
      buyToSellRatio: 2.0,
    });
    expect(lowActivityToken.triggered).toBe(false);
    expect(lowActivityToken.rejectionReason).toBe("VOLUME_SURGE_GATE_FAILED");
    expect(lowActivityToken.gates.find((g) => g.name === "VOLUME_SURGE_GATE")?.passed).toBe(false);
  });

  it("fails when a single dev/whale disposal breaches 5% of liquidity depth", () => {
    const service = new BuyGateTriggerService();

    // $1,500 dump on $20,000 liquidity = 7.5% > 5% limit
    const whaleDump = service.evaluateCandidate(candidate, { maxSingleDisposalUsd: 1500 });
    expect(whaleDump.triggered).toBe(false);
    expect(whaleDump.rejectionReason).toBe("DEV_DISPOSAL_GATE_FAILED");
  });

  it("respects customized StrategyThresholds", () => {
    const customService = BuyGateTriggerService.fromStrategyThresholds({
      minLmcRatio: 0.2,
      maxLmcRatio: 0.4,
      minBuyToSellRatio: 2.0,
      minVolume5mUsd: 5000,
      minMaturityAgeSec: 200,
      maxMaturityAgeSec: 1000,
    });

    const result = customService.evaluateCandidate({
      ...candidate,
      assetAgeSeconds: 250,
      lmcRatio: 0.35,
      buyToSellRatio: 2.5,
      volume5mUsd: 5500,
    });

    expect(result.triggered).toBe(true);
  });
});
