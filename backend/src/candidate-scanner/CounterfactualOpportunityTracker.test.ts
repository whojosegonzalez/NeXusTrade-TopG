import { describe, expect, it } from "vitest";
import { CounterfactualOpportunityTracker } from "./CounterfactualOpportunityTracker.js";
import type { ScannedPoolRecord } from "./CandidateScannerTypes.js";

describe("CounterfactualOpportunityTracker", () => {
  const basePool: ScannedPoolRecord = {
    poolId: "pool-alpha",
    mintAddress: "MintAlpha111111111111111111111111111111111",
    symbol: "ALPHA",
    decimals: 9,
    baseMint: "So11111111111111111111111111111111111111112",
    liquidityUsd: 15_000,
    marketCapUsd: 60_000,
    openTimeSec: 1_000_000,
    lpBurnPct: 100,
    mintAuthority: null,
    freezeAuthority: null,
    volume5mUsd: 5_000,
    txCount5m: 20,
    buys5m: 15,
    sells5m: 5,
    spotPriceUsd: 0.01,
    fetchedAt: new Date(1_000_000_000).toISOString(),
  };

  it("records new candidates and cohorts accurately", () => {
    const tracker = new CounterfactualOpportunityTracker();
    const nowMs = 1_000_000_000;

    tracker.recordCandidate(basePool, "WATCHLIST_RADAR", 0.0001, nowMs);
    const records = tracker.getRecords();
    expect(records.length).toBe(1);
    expect(records[0]?.symbol).toBe("ALPHA");
    expect(records[0]?.cohort).toBe("WATCHLIST_RADAR");
    expect(records[0]?.initialPriceSol).toBe(0.0001);
  });

  it("samples price movements and calculates peak gain and max loss", () => {
    const tracker = new CounterfactualOpportunityTracker();
    const nowMs = 1_000_000_000;

    tracker.recordCandidate(basePool, "WATCHLIST_RADAR", 0.0001, nowMs);

    // Price pumps +25%
    tracker.samplePrice(basePool.mintAddress, 0.000125, nowMs + 60_000);
    let record = tracker.getRecords()[0]!;
    expect(record.maxGainBps).toBe(2500); // +25.00%
    expect(record.maxPriceSol).toBe(0.000125);

    // Price dumps -10% from entry
    tracker.samplePrice(basePool.mintAddress, 0.00009, nowMs + 120_000);
    record = tracker.getRecords()[0]!;
    expect(record.maxGainBps).toBe(2500); // peak gain preserved
    expect(record.minReturnBps).toBe(-1000); // -10.00%
  });

  it("identifies missed winners and avoided rugs in post-run report", () => {
    const tracker = new CounterfactualOpportunityTracker();
    const nowMs = 1_000_000_000;

    // 1. Missed Winner (Runner on radar that was not bought, gained +50%)
    tracker.recordCandidate(basePool, "WATCHLIST_RADAR", 0.0001, nowMs);
    tracker.samplePrice(basePool.mintAddress, 0.00015, nowMs + 300_000);

    // 2. Avoided Rug (Rejected pool that dumped -80%)
    const rugPool: ScannedPoolRecord = {
      ...basePool,
      poolId: "pool-rug",
      mintAddress: "MintRug2222222222222222222222222222222222222",
      symbol: "RUGCOIN",
    };
    tracker.recordCandidate(
      rugPool,
      "FILTERED_REJECTED",
      0.001,
      nowMs,
      "REJECTED_LOW_LIQUIDITY_UNDER_2500",
    );
    tracker.samplePrice(rugPool.mintAddress, 0.0002, nowMs + 300_000); // -80%

    // 3. Executed Buy
    const buyPool: ScannedPoolRecord = {
      ...basePool,
      poolId: "pool-buy",
      mintAddress: "MintBuy3333333333333333333333333333333333333",
      symbol: "BUYCOIN",
    };
    tracker.recordCandidate(buyPool, "EXECUTED_BUY", 0.005, nowMs);

    const report = tracker.generateReport(10.0, 10.45);

    expect(report.totalCandidatesObserved).toBe(3);
    expect(report.executedBuysCount).toBe(1);
    expect(report.watchlistRadarCount).toBe(1);
    expect(report.filteredRejectedCount).toBe(1);

    expect(report.missedWinnersCount).toBe(1);
    expect(report.missedWinners[0]?.symbol).toBe("ALPHA");
    expect(report.missedWinners[0]?.peakGainPct).toBe(50);

    expect(report.avoidedRugsCount).toBe(1);
    expect(report.avoidedRugs[0]?.symbol).toBe("RUGCOIN");
    expect(report.avoidedRugs[0]?.maxLossPct).toBe(-80);
    expect(report.avoidedRugs[0]?.rejectionReason).toBe("REJECTED_LOW_LIQUIDITY_UNDER_2500");

    expect(report.rejectionReasonBreakdown["REJECTED_LOW_LIQUIDITY_UNDER_2500"]).toBe(1);
  });
});
