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
    expect(result.gates.length).toBe(11);
    expect(result.gates.every((g) => g.passed)).toBe(true);
    expect(result.rejectionReason).toBeUndefined();
  });

  it("fails when bundler / insider holdings breach 85%", () => {
    const service = new BuyGateTriggerService();
    const result = service.evaluateCandidate(candidate, {
      bundlerPct: 0.88, // 88% > 85%
    });
    expect(result.triggered).toBe(false);
    expect(result.rejectionReason).toBe("BUNDLER_CONCENTRATION_GATE_FAILED");
  });

  it("fails when top 10 holders breach 30% concentration", () => {
    const service = new BuyGateTriggerService();
    const result = service.evaluateCandidate(candidate, {
      top10HolderPct: 0.38, // 38% > 30%
    });
    expect(result.triggered).toBe(false);
    expect(result.rejectionReason).toBe("TOP_10_CONCENTRATION_FAILED");
  });

  it("fails when unique holders count is below 350", () => {
    const service = new BuyGateTriggerService();
    const result = service.evaluateCandidate(candidate, {
      holdersCount: 180, // 180 < 350
    });
    expect(result.triggered).toBe(false);
    expect(result.rejectionReason).toBe("INSUFFICIENT_HOLDERS_COUNT_FAILED");
  });

  it("fails when RugCheck risk score exceeds 700", () => {
    const service = new BuyGateTriggerService();
    const result = service.evaluateCandidate(candidate, {
      rugScore: 850, // 850 > 700
      holdersCount: 500,
    });
    expect(result.triggered).toBe(false);
    expect(result.rejectionReason).toBe("RUGCHECK_HIGH_RISK_SCORE_FAILED");
  });

  it("fails when RugCheck flags any danger risk level", () => {
    const service = new BuyGateTriggerService();
    const result = service.evaluateCandidate(candidate, {
      rugScore: 400, // <= 700
      hasDangerRisk: true,
      holdersCount: 500,
    });
    expect(result.triggered).toBe(false);
    expect(result.rejectionReason).toBe("RUGCHECK_DANGER_FLAG_FAILED");
  });

  it("passes when bundler and RugCheck security metrics are within healthy limits", () => {
    const service = new BuyGateTriggerService();
    const result = service.evaluateCandidate(candidate, {
      rugScore: 250,
      hasDangerRisk: false,
      bundlerPct: 0.12,
      top10HolderPct: 0.18,
      holdersCount: 520,
    });
    expect(result.triggered).toBe(true);
    expect(result.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE")?.passed).toBe(true);
  });

  it("fetches and parses live RugCheck /report format with score, danger risks, and holders", async () => {
    const mockFetch: typeof fetch = async (url) => {
      expect(String(url)).toContain("/report");
      return new Response(
        JSON.stringify({
          score: 2884,
          score_normalised: 28.84,
          totalHolders: 39,
          topHolders: [{ pct: 15.0 }, { pct: 8.5 }],
          risks: [
            { name: "Top 10 Holders Concentration", level: "danger", score: 500 },
            { name: "Single holder ownership", level: "warn", score: 200 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const metrics = await BuyGateTriggerService.fetchRugCheckMetrics(
      "2z1kjXiQzWtq75QEnAEQEMyS332toNEcSno3wceJpump",
      mockFetch,
    );
    expect(metrics).not.toBeNull();
    expect(metrics?.rugScore).toBe(2884);
    expect(metrics?.hasDangerRisk).toBe(true);
    expect(metrics?.holdersCount).toBe(39);
    expect(metrics?.top10HolderPct).toBeCloseTo(0.235, 3);

    // Evaluate candidate with these metrics -> immediately rejected
    const service = new BuyGateTriggerService();
    const result = service.evaluateCandidate(candidate, {
      rugScore: metrics?.rugScore,
      hasDangerRisk: metrics?.hasDangerRisk,
      holdersCount: metrics?.holdersCount,
      top10HolderPct: metrics?.top10HolderPct,
    });
    expect(result.triggered).toBe(false);
    expect(result.rejectionReason).toBe("RUGCHECK_HIGH_RISK_SCORE_FAILED");
  });

  it("permits established pool with $100k liquidity and $1.5M market cap (L/MC 6.6%) via adaptive depth gate", () => {
    const service = new BuyGateTriggerService();
    const establishedPool: WatchlistCandidateItem = {
      ...candidate,
      liquidityUsd: 100_000,
      marketCapUsd: 1_500_000,
      lmcRatio: 100_000 / 1_500_000, // 0.0667 (6.67%)
      assetAgeSeconds: 3600, // 1 hour (within 30m - 2h established window)
      volume5mUsd: 35_000,
      buys5m: 50,
      sells5m: 25,
      buyToSellRatio: 2.0,
    };
    const result = service.evaluateCandidate(establishedPool, {
      maxSingleDisposalUsd: 1000,
      recentBuysCount60s: 10,
      recentSellsCount60s: 4,
      momentum1mBps: 50,
      holdersCount: 500,
    });
    expect(result.triggered).toBe(true);
    const depthGate = result.gates.find((g) => g.name === "DEPTH_BALANCE_GATE");
    expect(depthGate?.passed).toBe(true);
  });

  it("permits established runners within 30m to 2h age ceiling and rejects stale tokens > 2h", () => {
    const service = new BuyGateTriggerService();
    const runner = {
      ...candidate,
      assetAgeSeconds: 3600, // 1 hour (within 1800s - 7200s)
      liquidityUsd: 50_000,
      marketCapUsd: 200_000,
      lmcRatio: 0.25,
      buys5m: 50,
      sells5m: 25,
      buyToSellRatio: 2.0,
      volume5mUsd: 15_000,
    };
    const result = service.evaluateCandidate(runner, {
      maxSingleDisposalUsd: 500,
      holdersCount: 500,
    });
    expect(result.triggered).toBe(true);
    expect(result.gates.find((g) => g.name === "MATURITY_WINDOW_GATE")?.passed).toBe(true);

    // Stale token > 7200s (e.g. 4 hours = 14400s) must fail maturity
    const staleRunner = {
      ...runner,
      assetAgeSeconds: 14400,
    };
    const staleResult = service.evaluateCandidate(staleRunner, { maxSingleDisposalUsd: 500 });
    expect(staleResult.triggered).toBe(false);
    expect(staleResult.rejectionReason).toBe("MATURITY_WINDOW_GATE_FAILED");
  });

  it("fails when liquidity is below $20,000", () => {
    const service = new BuyGateTriggerService();

    const lowLiq = service.evaluateCandidate({
      ...candidate,
      liquidityUsd: 15_000, // below $20,000
    });
    expect(lowLiq.triggered).toBe(false);
    expect(lowLiq.rejectionReason).toBe("MIN_LIQUIDITY_GATE_FAILED");
  });

  it("fails when outside the maturity window", () => {
    const service = new BuyGateTriggerService();

    // Too young (150s)
    const tooYoung = service.evaluateCandidate({ ...candidate, assetAgeSeconds: 150 });
    expect(tooYoung.triggered).toBe(false);
    expect(tooYoung.rejectionReason).toBe("MATURITY_WINDOW_GATE_FAILED");

    // Too old for standard micro-cap (1000s)
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

  it("permits healthy deep liquidity up to 55% L/MC and fails when outside 15% - 55% range", () => {
    const service = new BuyGateTriggerService();

    // Low depth (10%)
    const lowDepth = service.evaluateCandidate({ ...candidate, lmcRatio: 0.1 });
    expect(lowDepth.triggered).toBe(false);
    expect(lowDepth.rejectionReason).toBe("DEPTH_BALANCE_GATE_FAILED");

    // Deep healthy liquidity (35% & 45%) -> passes with 55% ceiling
    const deepLiq35 = service.evaluateCandidate({ ...candidate, lmcRatio: 0.35 });
    expect(deepLiq35.triggered).toBe(true);
    expect(deepLiq35.gates.find((g) => g.name === "DEPTH_BALANCE_GATE")?.passed).toBe(true);

    const deepLiq45 = service.evaluateCandidate({ ...candidate, lmcRatio: 0.45 });
    expect(deepLiq45.triggered).toBe(true);
    expect(deepLiq45.gates.find((g) => g.name === "DEPTH_BALANCE_GATE")?.passed).toBe(true);

    // Excessively high depth / thin cap (60%)
    const extremeDepth = service.evaluateCandidate({ ...candidate, lmcRatio: 0.6 });
    expect(extremeDepth.triggered).toBe(false);
    expect(extremeDepth.rejectionReason).toBe("DEPTH_BALANCE_GATE_FAILED");
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

  it("fails when 5m sells count is below 15 (anti-sniper trap protection)", () => {
    const service = new BuyGateTriggerService();

    const lowSells = service.evaluateCandidate({
      ...candidate,
      sells5m: 10, // only 10 sells (requires >= 15)
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

  it("relaxes FLOW_ABSORPTION_GATE buyer dominance requirement for volume breakouts", () => {
    const service = new BuyGateTriggerService();

    // 1. Under standard volume ($6,000), a 1.28x ratio fails the standard 1.50x requirement
    const standardFail = service.evaluateCandidate({
      ...candidate,
      volume5mUsd: 6000,
      buyToSellRatio: 1.28,
    });
    expect(standardFail.triggered).toBe(false);
    expect(standardFail.rejectionReason).toBe("FLOW_ABSORPTION_GATE_FAILED");

    // 2. For strong volume surge >= $15,000, requirement relaxes to 1.25x (1.28x passes)
    const surge15k = service.evaluateCandidate({
      ...candidate,
      volume5mUsd: 16000,
      buyToSellRatio: 1.28,
    });
    expect(surge15k.triggered).toBe(true);
    const flowGate15k = surge15k.gates.find((g) => g.name === "FLOW_ABSORPTION_GATE");
    expect(flowGate15k?.passed).toBe(true);
    expect(flowGate15k?.requirement).toBe("Buys/Sells >= 1.25x");

    // 3. For major volume surge >= $35,000, requirement relaxes to 1.15x (1.18x passes)
    const surge35k = service.evaluateCandidate({
      ...candidate,
      volume5mUsd: 40000,
      buyToSellRatio: 1.18,
    });
    expect(surge35k.triggered).toBe(true);
    const flowGate35k = surge35k.gates.find((g) => g.name === "FLOW_ABSORPTION_GATE");
    expect(flowGate35k?.passed).toBe(true);
    expect(flowGate35k?.requirement).toBe("Buys/Sells >= 1.15x");
  });

  describe("SubPhase12_83: Established Macro Trend Gate (Anti-Dead-Cat Bounce)", () => {
    const establishedRunner: WatchlistCandidateItem = {
      ...candidate,
      liquidityUsd: 100_000,
      marketCapUsd: 1_500_000,
      lmcRatio: 100_000 / 1_500_000,
      assetAgeSeconds: 7200, // 2h (Established)
      volume5mUsd: 35_000,
      buys5m: 50,
      sells5m: 25,
      buyToSellRatio: 2.0,
    };

    it("rejects established tokens in macro downtrends (priceChange1h < -15%)", () => {
      const service = new BuyGateTriggerService();
      const deadCatResult = service.evaluateCandidate(establishedRunner, {
        recentBuysCount60s: 10,
        recentSellsCount60s: 4,
        momentum1mBps: 50,
        priceChange1hPct: -45.2, // e.g. cNFTs (-45.2%) or BOT (-60.2%)
        holdersCount: 500,
      });

      expect(deadCatResult.triggered).toBe(false);
      expect(deadCatResult.rejectionReason).toBe("REJECTED_ESTABLISHED_MACRO_DOWNTREND");
      const macroGate = deadCatResult.gates.find((g) => g.name === "ESTABLISHED_MACRO_TREND_GATE");
      expect(macroGate?.passed).toBe(false);
      expect(macroGate?.value).toBe(-45.2);
    });

    it("accepts established tokens with healthy macro trend (priceChange1h >= -15%)", () => {
      const service = new BuyGateTriggerService();
      const healthyResult = service.evaluateCandidate(establishedRunner, {
        recentBuysCount60s: 10,
        recentSellsCount60s: 4,
        momentum1mBps: 50,
        priceChange1hPct: 120.0, // e.g. PFSOL (+120%) or ARCH (+246%)
        holdersCount: 500,
      });

      expect(healthyResult.triggered).toBe(true);
      const macroGate = healthyResult.gates.find((g) => g.name === "ESTABLISHED_MACRO_TREND_GATE");
      expect(macroGate?.passed).toBe(true);
      expect(macroGate?.value).toBe(120.0);
    });

    it("does not reject fresh micro-caps even if priceChange1h < -15%", () => {
      const service = new BuyGateTriggerService();
      const microCapResult = service.evaluateCandidate(candidate, {
        recentBuysCount60s: 8,
        recentSellsCount60s: 3,
        momentum1mBps: 50,
        priceChange1hPct: -25.0, // Fresh micro-cap (< 1h age, not established)
      });

      expect(microCapResult.triggered).toBe(true);
      const macroGate = microCapResult.gates.find((g) => g.name === "ESTABLISHED_MACRO_TREND_GATE");
      expect(macroGate).toBeUndefined(); // Gate not added for micro-caps
    });
  });

  describe("SubPhase12_84: Mandatory Liquidity Floor for Established Cohort", () => {
    it("never classifies tokens with liquidity < $50,000 as Established, even with mature age (2h) or high MC ($300k)", () => {
      const service = new BuyGateTriggerService();
      // Token with $45k liquidity, $450k MC (L/MC = 10%), age 7200s (2h)
      // Because liquidity < $50k, this is strictly a MICRO_CAP:
      // 1. It must satisfy micro-cap L/MC >= 15% (10% fails DEPTH_BALANCE_GATE)
      // 2. It does not get the ESTABLISHED_MACRO_TREND_GATE
      const thinCandidate: WatchlistCandidateItem = {
        poolId: "pool-thin-1",
        mintAddress: "ThinMint111111111111111111111111111111111111",
        symbol: "THIN",
        liquidityUsd: 45_000,
        marketCapUsd: 450_000,
        lmcRatio: 0.1, // 10% (< 15% micro-cap threshold, but >= 3% established threshold)
        lpBurnPct: 100,
        assetAgeSeconds: 7200, // 2 hours
        volume5mUsd: 30_000,
        buys5m: 40,
        sells5m: 20,
        buyToSellRatio: 2.0,
        status: "WATCHING",
        discoveredAt: new Date().toISOString(),
        lastEvaluatedAt: new Date().toISOString(),
      };

      const result = service.evaluateCandidate(thinCandidate, {
        recentBuysCount60s: 10,
        recentSellsCount60s: 4,
        momentum1mBps: 50,
      });

      // Should fail DEPTH_BALANCE_GATE because micro-cap requires 15%
      expect(result.triggered).toBe(false);
      const depthGate = result.gates.find((g) => g.name === "DEPTH_BALANCE_GATE");
      expect(depthGate?.passed).toBe(false);
      expect(depthGate?.requirement).toContain("15% <= L/MC <= 55%");
      expect(depthGate?.requirement).not.toContain("Adaptive Established Pool");

      // Gate 10 should not be attached to non-established tokens
      const macroGate = result.gates.find((g) => g.name === "ESTABLISHED_MACRO_TREND_GATE");
      expect(macroGate).toBeUndefined();
    });

    it("classifies tokens with liquidity >= $50,000 and age >= 1h as Established (3% L/MC floor, macro gate active)", () => {
      const service = new BuyGateTriggerService();
      // Token with $55k liquidity, $700k MC (L/MC = 7.8%), age 7200s (2h)
      const establishedCandidate: WatchlistCandidateItem = {
        poolId: "pool-estab-1",
        mintAddress: "EstabMint11111111111111111111111111111111111",
        symbol: "ESTAB",
        liquidityUsd: 55_000,
        marketCapUsd: 700_000,
        lmcRatio: 55_000 / 700_000, // ~7.86% (passes established 3% floor)
        lpBurnPct: 100,
        assetAgeSeconds: 7200,
        volume5mUsd: 30_000,
        buys5m: 40,
        sells5m: 20,
        buyToSellRatio: 2.0,
        status: "WATCHING",
        discoveredAt: new Date().toISOString(),
        lastEvaluatedAt: new Date().toISOString(),
      };

      const result = service.evaluateCandidate(establishedCandidate, {
        recentBuysCount60s: 10,
        recentSellsCount60s: 4,
        momentum1mBps: 50,
        priceChange1hPct: 25.0,
        holdersCount: 500,
      });

      expect(result.triggered).toBe(true);
      const depthGate = result.gates.find((g) => g.name === "DEPTH_BALANCE_GATE");
      expect(depthGate?.passed).toBe(true);
      expect(depthGate?.requirement).toContain("3% <= L/MC <= 55% (Adaptive Established Pool)");

      const macroGate = result.gates.find((g) => g.name === "ESTABLISHED_MACRO_TREND_GATE");
      expect(macroGate).toBeDefined();
      expect(macroGate?.passed).toBe(true);
    });

    it("enforces that tokens younger than 1800s are not classified as Established even with high MC and liquidity", () => {
      const service = new BuyGateTriggerService();
      const largeCapCandidate: WatchlistCandidateItem = {
        poolId: "pool-large-1",
        mintAddress: "LargeCapMint11111111111111111111111111111111",
        symbol: "LARGE",
        liquidityUsd: 60_000,
        marketCapUsd: 600_000,
        lmcRatio: 0.1, // 10% (fails standard micro-cap 15% depth floor)
        lpBurnPct: 100,
        assetAgeSeconds: 500, // Young (< 30m / 1800s)
        volume5mUsd: 30_000,
        buys5m: 40,
        sells5m: 20,
        buyToSellRatio: 2.0,
        status: "WATCHING",
        discoveredAt: new Date().toISOString(),
        lastEvaluatedAt: new Date().toISOString(),
      };

      const result = service.evaluateCandidate(largeCapCandidate, {
        recentBuysCount60s: 10,
        recentSellsCount60s: 4,
        momentum1mBps: 50,
        priceChange1hPct: 10.0,
      });

      // Because age < 1800s, it is NOT classified as Established; standard micro-cap 15% floor applies
      expect(result.triggered).toBe(false);
      expect(result.rejectionReason).toBe("DEPTH_BALANCE_GATE_FAILED");
    });
  });

  describe("SubPhase12_85: Stale Age Ceiling and Fail-Closed RugCheck", () => {
    it("fails closed on micro-caps when RugCheck is unindexed or holders count is unknown", () => {
      const service = new BuyGateTriggerService();
      const microCandidate: WatchlistCandidateItem = {
        ...candidate,
        liquidityUsd: 25_000,
        assetAgeSeconds: 600,
      };

      const result = service.evaluateCandidate(microCandidate, {
        requireVerifiedHolders: true,
        holdersCount: undefined,
      });

      expect(result.triggered).toBe(false);
      expect(result.rejectionReason).toBe("REJECTED_RUGCHECK_UNINDEXED_OR_HOLDERS_UNKNOWN");
    });

    it("fails micro-caps when verified holders count is below 100", () => {
      const service = new BuyGateTriggerService();
      const microCandidate: WatchlistCandidateItem = {
        ...candidate,
        liquidityUsd: 25_000,
        assetAgeSeconds: 600,
      };

      const result = service.evaluateCandidate(microCandidate, {
        requireVerifiedHolders: true,
        holdersCount: 85, // < 100
      });

      expect(result.triggered).toBe(false);
      expect(result.rejectionReason).toBe("INSUFFICIENT_HOLDERS_COUNT_FAILED");
    });

    it("passes micro-caps when verified holders count is >= 100", () => {
      const service = new BuyGateTriggerService();
      const microCandidate: WatchlistCandidateItem = {
        ...candidate,
        liquidityUsd: 25_000,
        assetAgeSeconds: 600,
      };

      const result = service.evaluateCandidate(microCandidate, {
        requireVerifiedHolders: true,
        holdersCount: 150, // >= 100
        recentBuysCount60s: 8,
        recentSellsCount60s: 3,
        momentum1mBps: 50,
      });

      expect(result.triggered).toBe(true);
    });

    it("rejects tokens older than 7200s (2h) even with >= $50,000 liquidity", () => {
      const service = new BuyGateTriggerService();
      const staleToken: WatchlistCandidateItem = {
        ...candidate,
        liquidityUsd: 65_000,
        assetAgeSeconds: 7300, // > 7200s (2h)
        marketCapUsd: 500_000,
      };

      const result = service.evaluateCandidate(staleToken, {
        recentBuysCount60s: 10,
        recentSellsCount60s: 4,
        momentum1mBps: 50,
      });

      expect(result.triggered).toBe(false);
      expect(result.rejectionReason).toBe("MATURITY_WINDOW_GATE_FAILED");
    });
  });

  describe("SubPhase12_86: Anti-Cabal Wash-Trading Defense & Sell Congestion Shield", () => {
    it("rejects micro-caps when 5m total transactions exceed 300", () => {
      const service = new BuyGateTriggerService();
      const washTradedCandidate: WatchlistCandidateItem = {
        ...candidate,
        liquidityUsd: 25_000,
        assetAgeSeconds: 600,
        buys5m: 250,
        sells5m: 80, // Total tx = 330 > 300
        buyToSellRatio: 250 / 80,
      };

      const result = service.evaluateCandidate(washTradedCandidate);
      expect(result.triggered).toBe(false);
      expect(result.rejectionReason).toBe("REJECTED_EXCESSIVE_WASH_TRADING_TX_COUNT");
      const washGate = result.gates.find((g) => g.name === "WASH_TRADING_CEILING_GATE");
      expect(washGate?.passed).toBe(false);
    });

    it("rejects micro-caps when 5m sells exceed 100", () => {
      const service = new BuyGateTriggerService();
      const sellCongestedCandidate: WatchlistCandidateItem = {
        ...candidate,
        liquidityUsd: 25_000,
        assetAgeSeconds: 600,
        buys5m: 160,
        sells5m: 105, // Sells = 105 > 100, Total tx = 265 <= 300
        buyToSellRatio: 160 / 105,
      };

      const result = service.evaluateCandidate(sellCongestedCandidate);
      expect(result.triggered).toBe(false);
      expect(result.rejectionReason).toBe("REJECTED_EXCESSIVE_SELL_CONGESTION");
      const congestionGate = result.gates.find((g) => g.name === "SELL_CONGESTION_CEILING_GATE");
      expect(congestionGate?.passed).toBe(false);
    });

    it("permits established runners even with totalTx5m > 300 and sells5m > 100", () => {
      const service = new BuyGateTriggerService();
      const highVolumeRunner: WatchlistCandidateItem = {
        ...candidate,
        liquidityUsd: 75_000,
        assetAgeSeconds: 2700, // 45m (Established)
        marketCapUsd: 600_000,
        lmcRatio: 75_000 / 600_000,
        buys5m: 280,
        sells5m: 140, // Total tx = 420 > 300, Sells = 140 > 100
        buyToSellRatio: 2.0,
        volume5mUsd: 50_000,
      };

      const result = service.evaluateCandidate(highVolumeRunner, {
        recentBuysCount60s: 20,
        recentSellsCount60s: 8,
        momentum1mBps: 50,
        holdersCount: 500,
      });

      expect(result.triggered).toBe(true);
      const washGate = result.gates.find((g) => g.name === "WASH_TRADING_CEILING_GATE");
      expect(washGate?.passed).toBe(true);
      expect(washGate?.requirement).toContain("Uncapped (Established Pool)");

      const congestionGate = result.gates.find((g) => g.name === "SELL_CONGESTION_CEILING_GATE");
      expect(congestionGate?.passed).toBe(true);
      expect(congestionGate?.requirement).toContain("Uncapped (Established Pool)");
    });

    it("rejects micro-caps when bundler concentration exceeds 50%", () => {
      const service = new BuyGateTriggerService();
      const microCandidate: WatchlistCandidateItem = {
        ...candidate,
        liquidityUsd: 25_000,
        assetAgeSeconds: 600,
      };

      // 55% bundler is > 50% micro ceiling, but < 85% established ceiling
      const result = service.evaluateCandidate(microCandidate, {
        bundlerPct: 0.55,
      });

      expect(result.triggered).toBe(false);
      expect(result.rejectionReason).toBe("BUNDLER_CONCENTRATION_GATE_FAILED");
    });

    it("permits established runners with bundler concentration between 50% and 85%", () => {
      const service = new BuyGateTriggerService();
      const runner: WatchlistCandidateItem = {
        ...candidate,
        liquidityUsd: 60_000,
        assetAgeSeconds: 3600, // 1h (Established)
        marketCapUsd: 500_000,
        lmcRatio: 60_000 / 500_000,
        volume5mUsd: 30_000,
        buys5m: 50,
        sells5m: 25,
        buyToSellRatio: 2.0,
      };

      const result = service.evaluateCandidate(runner, {
        bundlerPct: 0.65, // 65% > 50% but <= 85%
        recentBuysCount60s: 10,
        recentSellsCount60s: 4,
        momentum1mBps: 50,
        holdersCount: 500,
      });

      expect(result.triggered).toBe(true);
      const bundlerGate = result.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE");
      expect(bundlerGate?.passed).toBe(true);
    });
  });

  describe("SubPhase12_87: Mandatory Verified Holder Floor for Established Runners", () => {
    const candidate50k: WatchlistCandidateItem = {
      ...candidate,
      liquidityUsd: 55_000,
      marketCapUsd: 220_000,
      lmcRatio: 55_000 / 220_000, // 25% (passes both 3% and 15% depth gates)
      assetAgeSeconds: 2700, // 45m (within 30m-2h)
      volume5mUsd: 30_000,
      buys5m: 50,
      sells5m: 20,
      buyToSellRatio: 2.5,
    };

    it("does not classify candidate as established if holdersCount < 250 (e.g. 86 holders) and rejects when holders < 100", () => {
      const service = new BuyGateTriggerService();
      // Candidate like SIC: $55k liquidity, 45m age, but only 86 holders
      const result = service.evaluateCandidate(candidate50k, {
        holdersCount: 86,
        requireVerifiedHolders: true,
        recentBuysCount60s: 10,
        recentSellsCount60s: 4,
        momentum1mBps: 50,
      });

      expect(result.triggered).toBe(false);
      // Because holders < 250, isEstablished = false; falls back to micro-cap rules
      // With requireVerifiedHolders and holders < 100, fails INSUFFICIENT_HOLDERS_COUNT_FAILED
      expect(result.rejectionReason).toBe("INSUFFICIENT_HOLDERS_COUNT_FAILED");
      const macroGate = result.gates.find((g) => g.name === "ESTABLISHED_MACRO_TREND_GATE");
      expect(macroGate).toBeUndefined(); // Micro-cap does not get macro gate
    });

    it("classifies candidate as established when holdersCount >= 250 (e.g. 300 holders)", () => {
      const service = new BuyGateTriggerService();
      const result = service.evaluateCandidate(candidate50k, {
        holdersCount: 300,
        recentBuysCount60s: 10,
        recentSellsCount60s: 4,
        momentum1mBps: 50,
        priceChange1hPct: 20.0,
      });

      expect(result.triggered).toBe(true);
      const depthGate = result.gates.find((g) => g.name === "DEPTH_BALANCE_GATE");
      expect(depthGate?.passed).toBe(true);
      expect(depthGate?.requirement).toContain("Adaptive Established Pool");

      const macroGate = result.gates.find((g) => g.name === "ESTABLISHED_MACRO_TREND_GATE");
      expect(macroGate).toBeDefined();
      expect(macroGate?.passed).toBe(true);
    });
  });

  describe("SubPhase12_88: Candidate Established Runner Pre-Screening Unblock", () => {
    const candidate60k: WatchlistCandidateItem = {
      ...candidate,
      liquidityUsd: 60_000,
      marketCapUsd: 460_000, // L/MC = ~13% (healthy depth)
      lmcRatio: 60_000 / 460_000,
      assetAgeSeconds: 3600, // 60m age (within 30m - 2h)
      volume5mUsd: 30_000,
      buys5m: 50,
      sells5m: 20,
      buyToSellRatio: 2.5,
    };

    it("passes preliminary in-memory screening with empty marketContext ({})", () => {
      const service = new BuyGateTriggerService();
      // Preliminary in-memory screening has no RugCheck or spot metrics yet
      const result = service.evaluateCandidate(candidate60k, {});

      expect(result.triggered).toBe(true);
      expect(result.rejectionReason).toBeUndefined();
      const maturityGate = result.gates.find((g) => g.name === "MATURITY_WINDOW_GATE");
      expect(maturityGate?.passed).toBe(true);
      expect(maturityGate?.requirement).toContain("Established Runner");

      const depthGate = result.gates.find((g) => g.name === "DEPTH_BALANCE_GATE");
      expect(depthGate?.passed).toBe(true);
      expect(depthGate?.requirement).toContain("Adaptive Established Pool");
    });

    it("fails Stage 2 evaluation when candidate has insufficient holders (holdersCount: 86, requireVerifiedHolders: true)", () => {
      const service = new BuyGateTriggerService();
      // Stage 2 post-RugCheck verification for dev trap with 86 holders
      const result = service.evaluateCandidate(candidate60k, {
        holdersCount: 86,
        requireVerifiedHolders: true,
        recentBuysCount60s: 10,
        recentSellsCount60s: 4,
        momentum1mBps: 50,
      });

      expect(result.triggered).toBe(false);
      expect(result.rejectionReason).toBe("INSUFFICIENT_HOLDERS_COUNT_FAILED");
      const bundlerGate = result.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE");
      expect(bundlerGate?.passed).toBe(false);
    });

    it("passes Stage 2 evaluation when candidate has verified sufficient holders (holdersCount: 4180, bundlerPct: 0.42)", () => {
      const service = new BuyGateTriggerService();
      // Stage 2 post-RugCheck verification for genuine runner like SII
      const result = service.evaluateCandidate(candidate60k, {
        holdersCount: 4180,
        bundlerPct: 0.42,
        recentBuysCount60s: 15,
        recentSellsCount60s: 6,
        momentum1mBps: 100,
        priceChange1hPct: 25.0,
      });

      expect(result.triggered).toBe(true);
      expect(result.rejectionReason).toBeUndefined();
      const bundlerGate = result.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE");
      expect(bundlerGate?.passed).toBe(true);
      const macroGate = result.gates.find((g) => g.name === "ESTABLISHED_MACRO_TREND_GATE");
      expect(macroGate?.passed).toBe(true);
    });
  });
});
