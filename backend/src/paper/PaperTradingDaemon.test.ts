import { describe, expect, it } from "vitest";
import { PaperTradingDaemon, type PaperTradingDaemonConfig } from "./PaperTradingDaemon.js";
import type { ScannedPoolRecord } from "../candidate-scanner/CandidateScannerTypes.js";
import type { MarketEvaluationContext } from "../exits/DynamicRatchetTypes.js";

describe("PaperTradingDaemon", () => {
  const baseConfig: PaperTradingDaemonConfig = {
    sessionId: "test-paper-session-1",
    durationHours: 1,
    maxOpenPositions: 3,
    positionSizeSol: 1.0,
    initialPortfolioSol: 10.0,
    maxPortfolioDrawdownBps: -500, // -5.0%
    maxConsecutiveErrors: 3,
    maxClockDriftMs: 5000,
    pollIntervalMs: 1000,
    dryRun: false,
  };

  const nowSec = 1_000_000;
  const nowMs = nowSec * 1000;

  const validPool: ScannedPoolRecord = {
    poolId: "pool-1",
    mintAddress: "TokenMintValid11111111111111111111111111111111",
    symbol: "VALID",
    decimals: 9,
    baseMint: "So11111111111111111111111111111111111111112",
    liquidityUsd: 20_000,
    marketCapUsd: 100_000, // L/MC = 20.0%
    openTimeSec: nowSec - 500, // 500s ago (within 300s - 900s window)
    lpBurnPct: 95.0,
    mintAuthority: null,
    freezeAuthority: null,
    volume5mUsd: 15_000,
    txCount5m: 35,
    buys5m: 25,
    sells5m: 10,
    spotPriceUsd: 0.05,
    fetchedAt: new Date(nowMs).toISOString(),
  };

  const baseMarketContext: MarketEvaluationContext = {
    spotPriceSol: 0.05,
    lpIntact: true,
    recentBuysCount60s: 10,
    recentSellsCount60s: 5,
    momentum5mBps: 150,
    volumeStalled3m: false,
    currentTimestampMs: nowMs,
  };

  it("admits valid candidates and opens paper positions up to max capacity", () => {
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => nowMs,
    });
    daemon.start();

    // 1st candidate
    const accepted1 = daemon.processScannedPool(validPool, nowMs);
    expect(accepted1).toBe(true);

    // 2nd candidate
    const accepted2 = daemon.processScannedPool(
      {
        ...validPool,
        poolId: "pool-2",
        mintAddress: "TokenMintValid22222222222222222222222222222222",
      },
      nowMs,
    );
    expect(accepted2).toBe(true);

    // 3rd candidate
    const accepted3 = daemon.processScannedPool(
      {
        ...validPool,
        poolId: "pool-3",
        mintAddress: "TokenMintValid33333333333333333333333333333333",
      },
      nowMs,
    );
    expect(accepted3).toBe(true);

    // 4th candidate should be rejected due to maxOpenPositions = 3
    const accepted4 = daemon.processScannedPool(
      {
        ...validPool,
        poolId: "pool-4",
        mintAddress: "TokenMintValid44444444444444444444444444444444",
      },
      nowMs,
    );
    expect(accepted4).toBe(false);

    const snapshot = daemon.getSnapshot();
    expect(snapshot.openPositions.length).toBe(3);
    expect(snapshot.currentPortfolioSol).toBeCloseTo(10.0, 4);
  });

  it("evaluates open positions and closes them on dynamic ratchet trigger", () => {
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => nowMs,
    });
    daemon.start();

    daemon.processScannedPool(validPool, nowMs);
    const snapshotBefore = daemon.getSnapshot();
    expect(snapshotBefore.openPositions.length).toBe(1);

    const pos = snapshotBefore.openPositions[0]!;

    // Peak at +25% (0.05 * 1.25 = 0.0625)
    daemon.tickPosition(
      pos.positionId,
      {
        ...baseMarketContext,
        spotPriceSol: 0.0625,
      },
      nowMs,
    );

    // Retracement to +18% (0.05 * 1.18 = 0.059) <= +20% locked floor
    const exitResult = daemon.tickPosition(
      pos.positionId,
      {
        ...baseMarketContext,
        spotPriceSol: 0.059,
      },
      nowMs,
    );

    expect(exitResult?.action).toBe("SELL_ALL");
    expect(exitResult?.reasonCode).toBe("RATCHET_TIER_1_TRIGGERED");

    const snapshotAfter = daemon.getSnapshot();
    expect(snapshotAfter.openPositions.length).toBe(0);
    expect(snapshotAfter.closedTrades.length).toBe(1);
    expect(snapshotAfter.closedTrades[0]?.realizedPnlSol).toBeGreaterThan(0.15); // +18% gain
  });

  it("halts immediately on clock drift violation", () => {
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => nowMs,
    });
    daemon.start();
    daemon.processScannedPool(validPool, nowMs);

    const pos = daemon.getSnapshot().openPositions[0]!;

    // Market context is 10 seconds ahead of daemon clock (> 5s maxClockDriftMs)
    expect(() => {
      daemon.tickPosition(
        pos.positionId,
        {
          ...baseMarketContext,
          currentTimestampMs: nowMs + 10_000, // 10s difference
        },
        nowMs,
      );
    }).toThrow(/Clock drift violation/);

    const snapshot = daemon.getSnapshot();
    expect(snapshot.status).toBe("HALTED");
    expect(snapshot.haltReason).toBe("CLOCK_DRIFT_EXCEEDED");
  });

  it("halts when portfolio drawdown circuit breaker is breached", () => {
    const daemon = new PaperTradingDaemon({
      config: {
        ...baseConfig,
        initialPortfolioSol: 2.0,
        positionSizeSol: 1.0,
        maxPortfolioDrawdownBps: -500, // -5.0% (-0.10 SOL on 2.0 SOL portfolio)
      },
      clock: () => nowMs,
    });
    daemon.start();

    daemon.processScannedPool(validPool, nowMs);
    const pos = daemon.getSnapshot().openPositions[0]!;

    // Spot price drops by -12% on 1 SOL position (a loss of -0.12 SOL, which is -6.0% of 2.0 SOL portfolio)
    daemon.tickPosition(
      pos.positionId,
      {
        ...baseMarketContext,
        spotPriceSol: 0.044, // -12% = -1200 bps
        currentTimestampMs: nowMs,
      },
      nowMs,
    );

    const snapshot = daemon.getSnapshot();
    expect(snapshot.status).toBe("HALTED");
    expect(snapshot.haltReason).toBe("PORTFOLIO_DRAWDOWN_BREACHED");
  });

  it("handles pause and resume lifecycle transitions correctly", () => {
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => nowMs,
    });
    daemon.start();
    expect(daemon.getSnapshot().status).toBe("RUNNING");

    daemon.pause();
    expect(daemon.getSnapshot().status).toBe("PAUSED");

    // Rejected while paused
    const admitted = daemon.processScannedPool(validPool, nowMs);
    expect(admitted).toBe(false);

    daemon.resume();
    expect(daemon.getSnapshot().status).toBe("RUNNING");

    // Admitted after resume
    const admittedAfterResume = daemon.processScannedPool(validPool, nowMs);
    expect(admittedAfterResume).toBe(true);
  });

  it("handles startExiting graceful wind-down and transitions to COMPLETED when positions clear", () => {
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => nowMs,
    });
    daemon.start();

    daemon.processScannedPool(validPool, nowMs);
    expect(daemon.getSnapshot().openPositions.length).toBe(1);

    daemon.startExiting();
    expect(daemon.getSnapshot().status).toBe("EXITING");

    // New pools must be rejected in EXITING mode
    const acceptedInExiting = daemon.processScannedPool(
      { ...validPool, poolId: "pool-during-exiting" },
      nowMs,
    );
    expect(acceptedInExiting).toBe(false);

    // Close remaining position
    const pos = daemon.getSnapshot().openPositions[0]!;
    daemon.tickPosition(
      pos.positionId,
      {
        ...baseMarketContext,
        spotPriceSol: 0.043, // Stop out
      },
      nowMs,
    );

    // All positions cleared -> status transitions to COMPLETED
    const finalSnapshot = daemon.getSnapshot();
    expect(finalSnapshot.status).toBe("COMPLETED");
    expect(finalSnapshot.openPositions.length).toBe(0);
  });

  it("supports manual operator exit for an open position", () => {
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => nowMs,
    });
    daemon.start();

    daemon.processScannedPool(validPool, nowMs);
    const pos = daemon.getSnapshot().openPositions[0]!;

    const closed = daemon.manualExit(pos.positionId, 0.06, nowMs);
    expect(closed).toBeDefined();
    expect(closed?.exitReason).toBe("MANUAL_OPERATOR_EXIT");
    expect(closed?.realizedPnlSol).toBeCloseTo(0.2, 4); // (0.06 - 0.05)/0.05 * 1.0 SOL = +0.2 SOL

    const snapshot = daemon.getSnapshot();
    expect(snapshot.openPositions.length).toBe(0);
    expect(snapshot.closedTrades.length).toBe(1);
  });

  it("enforces single position per mint constraint", () => {
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => nowMs,
    });
    daemon.start();

    // 1st entry for mint
    const accepted1 = daemon.processScannedPool(validPool, nowMs);
    expect(accepted1).toBe(true);

    // 2nd entry for same mint with different poolId must be rejected
    const accepted2 = daemon.processScannedPool(
      { ...validPool, poolId: "pool-duplicate-mint" },
      nowMs,
    );
    expect(accepted2).toBe(false);

    const snapshot = daemon.getSnapshot();
    expect(snapshot.openPositions.length).toBe(1);
  });

  it("enforces anti-rebuy cooldown after token exit", () => {
    const cooldownMs = 15 * 60 * 1000; // 15m
    const daemon = new PaperTradingDaemon({
      config: { ...baseConfig, antiRebuyCooldownMs: cooldownMs },
      clock: () => nowMs,
    });
    daemon.start();

    daemon.processScannedPool(validPool, nowMs);
    const pos = daemon.getSnapshot().openPositions[0]!;

    // Exit position at nowMs
    daemon.manualExit(pos.positionId, 0.05, nowMs);
    expect(daemon.getSnapshot().openPositions.length).toBe(0);

    // Immediate rebuy at nowMs + 10s must be rejected due to cooldown
    const rebuyTooSoon = daemon.processScannedPool(validPool, nowMs + 10_000);
    expect(rebuyTooSoon).toBe(false);

    // Rebuy after cooldown elapsed (nowMs + 16m) must be admitted
    const reopenMs = nowMs + cooldownMs + 1000;
    const reopenSec = Math.floor(reopenMs / 1000);
    const validPoolAfterCooldown = {
      ...validPool,
      openTimeSec: reopenSec - 500, // Keep maturity age within 300s-900s window
    };
    const rebuyAfterCooldown = daemon.processScannedPool(validPoolAfterCooldown, reopenMs);
    expect(rebuyAfterCooldown).toBe(true);
    expect(daemon.getSnapshot().openPositions.length).toBe(1);
  });

  it("handles uninterrupted research mode without halting process on drawdown", () => {
    const daemon = new PaperTradingDaemon({
      config: { ...baseConfig, uninterruptedResearchMode: true },
      clock: () => nowMs,
    });
    daemon.start();

    daemon.processScannedPool(validPool, nowMs);
    const pos = daemon.getSnapshot().openPositions[0]!;

    // Catastrophic crash causing > 5% portfolio drawdown
    daemon.tickPosition(
      pos.positionId,
      {
        ...baseMarketContext,
        spotPriceSol: 0.01, // -80% drop on 1 SOL = -0.8 SOL loss (-8% portfolio drawdown)
      },
      nowMs,
    );

    const snapshot = daemon.getSnapshot();
    // Status remains RUNNING in uninterrupted research mode
    expect(snapshot.status).toBe("RUNNING");
    expect(snapshot.haltReason).toBe("PORTFOLIO_DRAWDOWN_BREACHED");
  });
});
