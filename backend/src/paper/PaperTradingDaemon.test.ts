import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PaperTradingDaemon,
  type PaperTradingDaemonConfig,
  type TradingScheduleConfig,
  parseScheduleString,
  isWithinTradingSchedule,
} from "./PaperTradingDaemon.js";
import {
  type VirtualWalletState,
  loadVirtualWallet,
  settleSessionInWallet,
} from "./VirtualWallet.js";
import type { ScannedPoolRecord } from "../candidate-scanner/CandidateScannerTypes.js";
import {
  type MarketEvaluationContext,
  MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
  ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
} from "../exits/DynamicRatchetTypes.js";

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
    expect(snapshot.maxOpenPositions).toBe(3);
    expect(snapshot.currentPortfolioSol).toBeCloseTo(10.0, 4);
  });

  it("supports positionSizeSolOverride for dynamic capital-based sizing", () => {
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => nowMs,
    });
    daemon.start();

    // Pass custom position size override of 0.45 SOL
    const accepted = daemon.processScannedPool(validPool, nowMs, 0.05, 0.45);
    expect(accepted).toBe(true);

    const snapshot = daemon.getSnapshot();
    expect(snapshot.openPositions.length).toBe(1);
    expect(snapshot.openPositions[0]?.costBasisSol).toBeCloseTo(0.45, 4);
    // 0.45 SOL / 0.05 entry price = 9.0 tokens
    expect(snapshot.openPositions[0]?.tokensHeld).toBeCloseTo(9.0, 4);
  });

  it("evaluates open positions, executes milestone partial sales, and closes on dynamic ratchet trigger", () => {
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => nowMs,
    });
    daemon.start();

    daemon.processScannedPool(validPool, nowMs);
    const snapshotBefore = daemon.getSnapshot();
    expect(snapshotBefore.openPositions.length).toBe(1);

    const pos = snapshotBefore.openPositions[0]!;
    const initialTokens = pos.tokensHeld;

    // Peak at +25% (0.05 * 1.25 = 0.0625) -> triggers SELL_PARTIAL_50
    const partialResult = daemon.tickPosition(
      pos.positionId,
      {
        ...baseMarketContext,
        spotPriceSol: 0.0625,
      },
      nowMs,
    );

    expect(partialResult?.action).toBe("SELL_PARTIAL_50");
    expect(partialResult?.reasonCode).toBe("RATCHET_TIER_1_TRIGGERED");

    // Position remains open with 50% tokens and cost basis
    const snapshotMid = daemon.getSnapshot();
    expect(snapshotMid.openPositions.length).toBe(1);
    expect(snapshotMid.openPositions[0]?.tokensHeld).toBeCloseTo(initialTokens * 0.5, 4);
    expect(snapshotMid.openPositions[0]?.costBasisSol).toBeCloseTo(0.5, 4);

    // Retracement to -1% (0.05 * 0.99 = 0.0495) <= breakeven +0% locked floor
    const exitResult = daemon.tickPosition(
      pos.positionId,
      {
        ...baseMarketContext,
        spotPriceSol: 0.0495,
      },
      nowMs,
    );

    expect(exitResult?.action).toBe("SELL_ALL");
    expect(exitResult?.reasonCode).toBe("RATCHET_TIER_1_BREACH");

    const snapshotAfter = daemon.getSnapshot();
    expect(snapshotAfter.openPositions.length).toBe(0);
    expect(snapshotAfter.closedTrades.length).toBe(1);
    // Realized PnL: 50% sold at +25% (0.625 SOL) + 50% sold at -1% (0.495 SOL) = 1.120 SOL total proceeds - 1.0 SOL basis = +0.120 SOL (+12%)
    expect(snapshotAfter.closedTrades[0]?.realizedPnlSol).toBeCloseTo(0.12, 4);
    expect(snapshotAfter.closedTrades[0]?.costBasisSol).toBeCloseTo(1.0, 4);
    expect(snapshotAfter.closedTrades[0]?.proceedsSol).toBeCloseTo(1.12, 4);
  });

  it("reconciles snapshot realized and unrealized P/L with portfolio balance during partial scaling", () => {
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => nowMs,
    });
    daemon.start();

    // Open position: 1.0 SOL at 0.05 SOL/token = 20 tokens
    daemon.processScannedPool(validPool, nowMs);
    const snapInitial = daemon.getSnapshot();
    expect(snapInitial.currentPortfolioSol).toBeCloseTo(10.0, 4);
    expect(snapInitial.totalRealizedPnlSol).toBeCloseTo(0.0, 4);
    expect(snapInitial.totalUnrealizedPnlSol).toBeCloseTo(0.0, 4);

    const pos = snapInitial.openPositions[0]!;

    // Peak at +25% (spotPriceSol = 0.0625) -> triggers SELL_PARTIAL_50
    // Sells 10 tokens (50%) for 10 * 0.0625 = 0.625 SOL proceeds
    // Basis of sold portion = 0.50 SOL -> Realized P/L on active position = +0.125 SOL
    // Remaining 10 tokens at 0.0625 = 0.625 SOL market value vs 0.50 basis -> Unrealized P/L = +0.125 SOL
    // Cash = 9.0 + 0.625 = 9.625 SOL
    // Total portfolio = 9.625 + 0.625 = 10.250 SOL
    daemon.tickPosition(
      pos.positionId,
      {
        ...baseMarketContext,
        spotPriceSol: 0.0625,
      },
      nowMs,
    );

    const snapMid = daemon.getSnapshot();
    expect(snapMid.openPositions.length).toBe(1);
    expect(snapMid.closedTrades.length).toBe(0);

    // Verify partial realized gain is counted in snapshot
    expect(snapMid.totalRealizedPnlSol).toBeCloseTo(0.125, 4);
    expect(snapMid.totalUnrealizedPnlSol).toBeCloseTo(0.125, 4);
    expect(snapMid.currentPortfolioSol).toBeCloseTo(10.25, 4);

    // Invariant: totalRealizedPnlSol + totalUnrealizedPnlSol === currentPortfolioSol - initialPortfolioSol
    const totalPnl = snapMid.totalRealizedPnlSol + snapMid.totalUnrealizedPnlSol;
    const portfolioDelta = snapMid.currentPortfolioSol - snapMid.initialPortfolioSol;
    expect(totalPnl).toBeCloseTo(portfolioDelta, 4);
    expect(totalPnl).toBeCloseTo(0.25, 4);
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

  it("supports custom exitReason (e.g. SESSION_DURATION_CASHOUT) in manualExit", () => {
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => nowMs,
    });
    daemon.start();

    daemon.processScannedPool(validPool, nowMs);
    const pos = daemon.getSnapshot().openPositions[0]!;

    const closed = daemon.manualExit(pos.positionId, 0.055, nowMs, "SESSION_DURATION_CASHOUT");
    expect(closed).toBeDefined();
    expect(closed?.exitReason).toBe("SESSION_DURATION_CASHOUT");
    expect(closed?.realizedPnlSol).toBeCloseTo(0.1, 4);

    const snapshot = daemon.getSnapshot();
    expect(snapshot.openPositions.length).toBe(0);
    expect(snapshot.closedTrades[0]?.exitReason).toBe("SESSION_DURATION_CASHOUT");
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

  it("forces stagnancy exit when a position has no activity for 3 minutes (180,000ms)", () => {
    let currentClockMs = nowMs;
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => currentClockMs,
    });
    daemon.start();

    daemon.processScannedPool(validPool, currentClockMs);
    const pos = daemon.getSnapshot().openPositions[0]!;

    // 2 minutes pass with stagnant ticks (no price change, zero transactions)
    currentClockMs += 120_000;
    const midResult = daemon.tickPosition(
      pos.positionId,
      {
        ...baseMarketContext,
        spotPriceSol: 0.05, // Same price
        recentBuysCount60s: 0,
        recentSellsCount60s: 0,
        volumeStalled3m: true,
        currentTimestampMs: currentClockMs,
      },
      currentClockMs,
    );
    expect(midResult?.action).toBe("HOLD");
    expect(daemon.getSnapshot().openPositions.length).toBe(1);

    // 3 minutes total elapsed (180,000ms since opened/last activity)
    currentClockMs += 60_000;
    const stagnancyResult = daemon.tickPosition(
      pos.positionId,
      {
        ...baseMarketContext,
        spotPriceSol: 0.05,
        recentBuysCount60s: 0,
        recentSellsCount60s: 0,
        volumeStalled3m: true,
        currentTimestampMs: currentClockMs,
      },
      currentClockMs,
    );

    expect(stagnancyResult?.action).toBe("SELL_ALL");
    expect(stagnancyResult?.reasonCode).toBe("STAGNANCY_TIMEOUT_EXIT");

    const snapshot = daemon.getSnapshot();
    expect(snapshot.openPositions.length).toBe(0);
    expect(snapshot.closedTrades.length).toBe(1);
    expect(snapshot.closedTrades[0]?.exitReason).toBe("STAGNANCY_TIMEOUT_EXIT");
  });

  it("forces stagnancy exit via recordStagnantTick when valid spot price is flat for 3 minutes", () => {
    let currentClockMs = nowMs;
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => currentClockMs,
    });
    daemon.start();

    daemon.processScannedPool(validPool, currentClockMs);
    const pos = daemon.getSnapshot().openPositions[0]!;

    // Market remains flat for 2 minutes with valid spot price
    currentClockMs += 120_000;
    const closed1 = daemon.recordStagnantTick(pos.positionId, pos.spotPriceSol, currentClockMs);
    expect(closed1).toBeNull();
    expect(daemon.getSnapshot().openPositions.length).toBe(1);

    // Market remains flat for 3 minutes (>= 180,000ms) with valid spot price
    currentClockMs += 60_000;
    const closed2 = daemon.recordStagnantTick(pos.positionId, pos.spotPriceSol, currentClockMs);
    expect(closed2).toBeDefined();
    expect(closed2?.exitReason).toBe("STAGNANCY_TIMEOUT_EXIT");

    const snapshot = daemon.getSnapshot();
    expect(snapshot.openPositions.length).toBe(0);
    expect(snapshot.closedTrades.length).toBe(1);
  });

  it("delegates to recordFeedOutageTick without liquidating when spot price is invalid (P0-B)", () => {
    let currentClockMs = nowMs;
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => currentClockMs,
    });
    daemon.start();

    daemon.processScannedPool(validPool, currentClockMs);
    const pos = daemon.getSnapshot().openPositions[0]!;

    // Outage occurs for 4 minutes (> 180,000ms)
    currentClockMs += 240_000;
    const closedOutage = daemon.recordStagnantTick(pos.positionId, 0, currentClockMs);
    expect(closedOutage).toBeNull();
    expect(pos.feedOutageTicksCount).toBe(1);
    expect(daemon.getSnapshot().openPositions.length).toBe(1);
  });

  it("rejects non-positive entry price", () => {
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => nowMs,
    });
    daemon.start();

    const rejectedZero = daemon.processScannedPool({ ...validPool, spotPriceUsd: 0 }, nowMs, 0);
    expect(rejectedZero).toBe(false);

    const rejectedNegative = daemon.processScannedPool(validPool, nowMs, -0.05);
    expect(rejectedNegative).toBe(false);
  });

  it("admits pools older than 15 minutes when bypassScannerEvaluation is true and attaches cohort ratchet config", () => {
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => nowMs,
    });
    daemon.start();

    // Pool launched 2 hours ago (7200s ago)
    const oldPool: ScannedPoolRecord = {
      ...validPool,
      poolId: "pool-old-runner",
      mintAddress: "TokenMintOldRunner11111111111111111111111111",
      openTimeSec: nowSec - 7200,
    };

    // Without bypass, it fails scanner evaluation because age > 900s
    const rejectedWithoutBypass = daemon.processScannedPool(oldPool, nowMs);
    expect(rejectedWithoutBypass).toBe(false);

    // With bypass, it admits the pool and stores cohort & ratchetConfig
    const acceptedWithBypass = daemon.processScannedPool(oldPool, nowMs, 0.05, 0.8, {
      bypassScannerEvaluation: true,
      cohort: "ESTABLISHED",
      ratchetConfig: ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
    });
    expect(acceptedWithBypass).toBe(true);

    const snapshot = daemon.getSnapshot();
    expect(snapshot.openPositions.length).toBe(1);
    const pos = snapshot.openPositions[0]!;
    expect(pos.cohort).toBe("ESTABLISHED");
    expect(pos.ratchetConfig).toEqual(ESTABLISHED_DYNAMIC_RATCHET_CONFIG);
  });

  it("evaluates position against custom cohort ratchetConfig in tickPosition", () => {
    const daemon = new PaperTradingDaemon({
      config: baseConfig,
      clock: () => nowMs,
    });
    daemon.start();

    // Micro-cap with MICRO_CAP_DYNAMIC_RATCHET_CONFIG (+10% Armed Breakeven, +20% Tier 1)
    daemon.processScannedPool(validPool, nowMs, 0.05, 0.25, {
      bypassScannerEvaluation: true,
      cohort: "MICRO_CAP",
      ratchetConfig: MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
    });

    const pos = daemon.getSnapshot().openPositions[0]!;

    // Spot price increases +10.0% (from 0.05 to 0.055) -> arms breakeven, holds
    const armResult = daemon.tickPosition(
      pos.positionId,
      {
        ...baseMarketContext,
        spotPriceSol: 0.055, // +10%
        currentTimestampMs: nowMs + 500,
      },
      nowMs + 500,
    );
    expect(armResult?.action).toBe("HOLD");

    // Spot price increases +20.0% (from 0.05 to 0.060)
    // Micro-cap config triggers Tier 1 (SELL_PARTIAL_50) at +20%
    const result = daemon.tickPosition(
      pos.positionId,
      {
        ...baseMarketContext,
        spotPriceSol: 0.06, // +20%
        currentTimestampMs: nowMs + 1000,
      },
      nowMs + 1000,
    );

    expect(result?.action).toBe("SELL_PARTIAL_50");
    expect(result?.reasonCode).toBe("RATCHET_TIER_1_TRIGGERED");
  });

  describe("SubPhase12_83: Scale-In Pyramiding & VWAP Exit Prices", () => {
    it("scaleInPosition correctly updates tokens, blended entry price, cost basis, and ratchet state", () => {
      const daemon = new PaperTradingDaemon({
        config: baseConfig,
        clock: () => nowMs,
      });
      daemon.start();

      // 1. Initial 0.25 SOL probe at 0.05 SOL/token -> 5 tokens
      daemon.processScannedPool(validPool, nowMs, 0.05, 0.25, {
        bypassScannerEvaluation: true,
        cohort: "MICRO_CAP",
      });

      const pos = daemon.getSnapshot().openPositions[0]!;
      expect(pos.tokensHeld).toBeCloseTo(5, 4);
      expect(pos.costBasisSol).toBeCloseTo(0.25, 4);
      expect(pos.entryPriceSol).toBeCloseTo(0.05, 4);
      expect(pos.pyramided).toBeUndefined();
      expect(daemon.getCurrentCashSol()).toBeCloseTo(9.75, 4);

      // 2. Token runs to 0.055 SOL (+10% gain) -> Execute Scale-In (+0.25 SOL)
      const spotPriceSol = 0.055;
      const addOnSol = 0.25;
      const updated = daemon.scaleInPosition(pos.positionId, addOnSol, spotPriceSol, nowMs + 1000);

      expect(updated).not.toBeNull();
      // Additional tokens = 0.25 / 0.055 = 4.54545 tokens
      // Total tokens = 5 + 4.54545 = 9.54545 tokens
      expect(updated?.tokensHeld).toBeCloseTo(9.54545, 4);
      expect(updated?.costBasisSol).toBeCloseTo(0.5, 4);
      // Blended entry price = 0.50 / 9.54545 = 0.05238 SOL
      expect(updated?.entryPriceSol).toBeCloseTo(0.05238, 4);
      expect(updated?.pyramided).toBe(true);
      expect(updated?.scaleInCount).toBe(1);
      expect(daemon.getCurrentCashSol()).toBeCloseTo(9.5, 4);
      expect(updated?.ratchetState.armedBreakeven).toBe(true);
      expect(updated?.ratchetState.currentStopFloorBps).toBeGreaterThanOrEqual(0);
    });

    it("calculates accurate volume-weighted average price (VWAP) exitPriceSol across multi-tier exits", () => {
      const daemon = new PaperTradingDaemon({
        config: baseConfig,
        clock: () => nowMs,
      });
      daemon.start();

      // Open position: 1.0 SOL at 0.05 SOL = 20 tokens
      daemon.processScannedPool(validPool, nowMs, 0.05, 1.0);
      const pos = daemon.getSnapshot().openPositions[0]!;

      // 1. Partial sell 50% (10 tokens) at +20% (0.060 SOL) -> proceeds = 0.60 SOL
      daemon.tickPosition(
        pos.positionId,
        {
          ...baseMarketContext,
          spotPriceSol: 0.06,
        },
        nowMs + 1000,
      );

      // 2. Final sell remaining 50% (10 tokens) at +10% (0.055 SOL) -> proceeds = 0.55 SOL
      daemon.tickPosition(
        pos.positionId,
        {
          ...baseMarketContext,
          spotPriceSol: 0.055,
        },
        nowMs + 2000,
      );

      const snapshot = daemon.getSnapshot();
      expect(snapshot.closedTrades.length).toBe(1);
      const trade = snapshot.closedTrades[0]!;
      // Total proceeds = 0.60 + 0.55 = 1.15 SOL
      // Total tokens = 20 tokens
      // VWAP exit price = 1.15 / 20 = 0.0575 SOL (reflecting true +15% net trade gain)
      expect(trade.proceedsSol).toBeCloseTo(1.15, 4);
      expect(trade.exitPriceSol).toBeCloseTo(0.0575, 4);
      expect(trade.realizedPnlSol).toBeCloseTo(0.15, 4);
      expect(trade.realizedPnlBps).toBe(1500);
    });
  });

  describe("SubPhase12_88: Daemon Idle Heartbeat and Telemetry Duration", () => {
    it("updates lastTickAtMs via heartbeat and accurately computes durationMinutes in getHistoricalSummary for zero-trade sessions", () => {
      const startTimeMs = 1_700_000_000_000;
      const daemon = new PaperTradingDaemon({
        config: baseConfig,
        clock: () => startTimeMs,
      });
      daemon.start();

      expect(daemon.getSnapshot().lastTickAtMs).toBe(startTimeMs);

      // Session runs for 4 hours (240 minutes) without any opened trades
      const fourHoursLaterMs = startTimeMs + 240 * 60_000;
      daemon.heartbeat(fourHoursLaterMs);

      expect(daemon.getSnapshot().lastTickAtMs).toBe(fourHoursLaterMs);

      daemon.stop("DURATION_ELAPSED");
      const summary = daemon.getHistoricalSummary();

      expect(summary.durationMinutes).toBe(240);
      expect(summary.totalTrades).toBe(0);
      expect(summary.endedAt).toBe(new Date(fourHoursLaterMs).toISOString());
    });
  });

  describe("SubPhase12_90: Chrono-Regime Gating and Schedule Parser", () => {
    it("parses valid schedule strings into TradingScheduleConfig with accurate minutes and timezones", () => {
      const pdtSchedule = parseScheduleString("07:00-17:30:PDT");
      expect(pdtSchedule).toBeDefined();
      expect(pdtSchedule?.startMinutes).toBe(420); // 7 * 60
      expect(pdtSchedule?.endMinutes).toBe(1050); // 17 * 60 + 30
      expect(pdtSchedule?.timeZone).toBe("America/Los_Angeles");
      expect(pdtSchedule?.rawString).toBe("07:00-17:30:PDT");

      const defaultTzSchedule = parseScheduleString("07:00-17:30");
      expect(defaultTzSchedule).toBeDefined();
      expect(defaultTzSchedule?.startMinutes).toBe(420);
      expect(defaultTzSchedule?.endMinutes).toBe(1050);
      expect(defaultTzSchedule?.timeZone).toBe("America/Los_Angeles");

      const edtSchedule = parseScheduleString("09:30-16:00:EDT");
      expect(edtSchedule).toBeDefined();
      expect(edtSchedule?.startMinutes).toBe(570); // 9 * 60 + 30
      expect(edtSchedule?.endMinutes).toBe(960); // 16 * 60
      expect(edtSchedule?.timeZone).toBe("America/New_York");

      const utcSchedule = parseScheduleString("00:00-12:00:UTC");
      expect(utcSchedule).toBeDefined();
      expect(utcSchedule?.startMinutes).toBe(0);
      expect(utcSchedule?.endMinutes).toBe(720);
      expect(utcSchedule?.timeZone).toBe("UTC");
    });

    it("rejects invalid schedule formats or out of bounds values", () => {
      expect(parseScheduleString("invalid")).toBeUndefined();
      expect(parseScheduleString("25:00-17:00:PDT")).toBeUndefined();
      expect(parseScheduleString("07:65-17:00:PDT")).toBeUndefined();
      expect(parseScheduleString("07:00-24:00:PDT")).toBeUndefined();
    });

    it("evaluates isWithinTradingSchedule accurately across active and standby windows", () => {
      const schedule: TradingScheduleConfig = {
        startMinutes: 420, // 07:00
        endMinutes: 1050, // 17:30
        timeZone: "America/Los_Angeles",
        rawString: "07:00-17:30:PDT",
      };

      // 2026-10-06 08:30:00 PDT -> UTC: 15:30:00 (1050min in UTC, 510min in LA)
      const insideTimeMs = new Date("2026-10-06T15:30:00Z").getTime();
      const insideCheck = isWithinTradingSchedule(insideTimeMs, schedule);
      expect(insideCheck.isWithin).toBe(true);
      expect(insideCheck.currentMinutes).toBe(510); // 8:30 AM LA
      expect(insideCheck.minutesUntilNext).toBe(0);

      // 2026-10-06 06:30:00 PDT -> UTC: 13:30:00 (390min in LA, before 420 start)
      const beforeTimeMs = new Date("2026-10-06T13:30:00Z").getTime();
      const beforeCheck = isWithinTradingSchedule(beforeTimeMs, schedule);
      expect(beforeCheck.isWithin).toBe(false);
      expect(beforeCheck.currentMinutes).toBe(390); // 6:30 AM LA
      expect(beforeCheck.minutesUntilNext).toBe(30); // 30 minutes until 7:00 AM

      // 2026-10-06 18:30:00 PDT -> UTC: 2026-10-07T01:30:00Z (1110min in LA, after 1050 end)
      const afterTimeMs = new Date("2026-10-07T01:30:00Z").getTime();
      const afterCheck = isWithinTradingSchedule(afterTimeMs, schedule);
      expect(afterCheck.isWithin).toBe(false);
      expect(afterCheck.currentMinutes).toBe(1110); // 6:30 PM LA
      // 1440 - 1110 + 420 = 750 minutes (12.5 hours) until 7:00 AM tomorrow
      expect(afterCheck.minutesUntilNext).toBe(750);
    });

    it("supports overnight trading schedules across midnight", () => {
      const overnightSchedule: TradingScheduleConfig = {
        startMinutes: 1320, // 22:00
        endMinutes: 240, // 04:00
        timeZone: "America/Los_Angeles",
        rawString: "22:00-04:00:PDT",
      };

      // 23:00 LA -> inside
      const lateNightMs = new Date("2026-10-07T06:00:00Z").getTime(); // 23:00 PDT
      expect(isWithinTradingSchedule(lateNightMs, overnightSchedule).isWithin).toBe(true);

      // 02:00 LA -> inside
      const earlyMorningMs = new Date("2026-10-07T09:00:00Z").getTime(); // 02:00 PDT
      expect(isWithinTradingSchedule(earlyMorningMs, overnightSchedule).isWithin).toBe(true);

      // 12:00 LA -> outside
      const middayMs = new Date("2026-10-07T19:00:00Z").getTime(); // 12:00 PDT
      expect(isWithinTradingSchedule(middayMs, overnightSchedule).isWithin).toBe(false);
    });
  });

  describe("SubPhase12_90: Staged Established Sizing and Pyramiding Scale-In", () => {
    it("handles 0.50 SOL probe entry and scales in +0.50 SOL upon breakout confirmation", () => {
      const daemon = new PaperTradingDaemon({
        config: {
          ...baseConfig,
          positionSizeSol: 0.5,
          initialPortfolioSol: 10.0,
        },
        clock: () => nowMs,
      });
      daemon.start();

      // 1. Enter Established position with 0.50 SOL probe
      const entered = daemon.processScannedPool(validPool, nowMs, 0.05, 0.5, {
        bypassScannerEvaluation: true,
        cohort: "ESTABLISHED",
        ratchetConfig: ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
      });
      expect(entered).toBe(true);

      const openPos = daemon.getSnapshot().openPositions[0]!;
      expect(openPos.costBasisSol).toBe(0.5);
      expect(openPos.tokensHeld).toBe(10); // 0.5 SOL / 0.05 = 10 tokens
      expect(openPos.entryPriceSol).toBe(0.05);
      expect(openPos.pyramided).toBeUndefined();
      expect(daemon.getCurrentCashSol()).toBe(9.5);

      // 2. Token surges +8% to 0.054 SOL (meets >= +7% breakout threshold)
      const scaled = daemon.scaleInPosition(openPos.positionId, 0.5, 0.054, nowMs + 10_000);
      expect(scaled).toBeDefined();
      expect(scaled?.costBasisSol).toBe(1.0); // 0.5 + 0.5 = 1.0 SOL total
      expect(scaled?.pyramided).toBe(true);
      expect(scaled?.scaleInCount).toBe(1);
      expect(daemon.getCurrentCashSol()).toBe(9.0);

      // Tokens added: 0.5 / 0.054 = 9.259259 tokens -> total tokens: 19.259259
      // Blended entry: 1.0 / 19.259259 = 0.051923 SOL
      expect(scaled?.tokensHeld).toBeCloseTo(19.259, 2);
      expect(scaled?.entryPriceSol).toBeCloseTo(0.0519, 3);
      // Floor locked to breakeven (>= 0 bps)
      expect(scaled?.ratchetState.currentStopFloorBps).toBeGreaterThanOrEqual(0);
      expect(scaled?.ratchetState.armedBreakeven).toBe(true);
    });
  });

  describe("Phase 12.93B Post-Audit P0 Regression Test Suite", () => {
    // P0-A: Missing prices and unresolved exposure
    it("P0-A: marks position as UNRESOLVED with zero proceeds and zero wallet credit on invalid/missing price", () => {
      const daemon = new PaperTradingDaemon({ config: baseConfig, clock: () => nowMs });
      daemon.start();
      daemon.processScannedPool(validPool, nowMs, 0.05, 1.0);
      const pos = daemon.getSnapshot().openPositions[0]!;
      const cashBefore = daemon.getCurrentCashSol(); // 9.0 SOL

      // Missing/invalid price (0 SOL) at exit
      const exitResult = daemon.manualExit(
        pos.positionId,
        0,
        nowMs + 1000,
        "SESSION_DURATION_CASHOUT",
      );
      expect(exitResult).toBeNull();

      const snapshot = daemon.getSnapshot();
      expect(snapshot.openPositions.length).toBe(0);
      expect(snapshot.closedTrades.length).toBe(0);
      expect(snapshot.unresolvedPositions?.length).toBe(1);
      const unresolved = snapshot.unresolvedPositions![0]!;
      expect(unresolved.positionId).toBe(pos.positionId);
      expect(unresolved.costBasisSol).toBe(1.0);
      expect(unresolved.estimatedLiquidationSol).toBe(0);
      expect(unresolved.reasonForMissingData).toContain("INVALID_EXIT_PRICE_0");

      // Virtual wallet cash is NOT credited!
      expect(daemon.getCurrentCashSol()).toBe(cashBefore);
    });

    // P0-B: Missing prices vs market stagnation
    it("P0-B: does not trigger stagnancy timeout exit during price feed outage lasting > 180s", () => {
      let currentClock = nowMs;
      const daemon = new PaperTradingDaemon({ config: baseConfig, clock: () => currentClock });
      daemon.start();
      daemon.processScannedPool(validPool, currentClock, 0.05, 1.0);
      const pos = daemon.getSnapshot().openPositions[0]!;

      // Price feed outage for 200s (exceeding 180s timeout)
      currentClock += 200_000;
      daemon.recordFeedOutageTick(pos.positionId, currentClock);
      const tickResult = daemon.tickPosition(
        pos.positionId,
        {
          currentTimestampMs: currentClock,
          spotPriceSol: 0, // feed outage
          lpIntact: true,
          recentBuysCount60s: 0,
          recentSellsCount60s: 0,
          momentum5mBps: 0,
          volumeStalled3m: false,
        },
        currentClock,
      );

      expect(tickResult).toBeNull();
      const snap = daemon.getSnapshot();
      expect(snap.openPositions.length).toBe(1);
      expect(snap.openPositions[0]!.feedOutageTicksCount).toBeGreaterThan(0);
      expect(snap.closedTrades.length).toBe(0);
    });

    // P0-C: Wallet persistence, corruption safety, and duplicate settlement
    it("P0-C: fails closed on corrupted wallet JSON and preserves corrupt backup", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "wallet-test-corrupt-"));
      const walletPath = path.join(tempDir, "virtual-wallet.json");
      writeFileSync(walletPath, "{ corrupt json syntax ...", "utf8");

      expect(() => loadVirtualWallet(walletPath)).toThrow(
        "[PaperDaemon] [FATAL] Virtual wallet corrupted or invalid",
      );
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("P0-C: migrates valid legacy wallet without settledSessionIds safely", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "wallet-test-legacy-"));
      const walletPath = path.join(tempDir, "virtual-wallet.json");
      const legacyWallet = {
        walletAddress: "LegacyWallet11111111111111111111111111111",
        currentBalanceSol: 12.5,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 2,
        allTimeRealizedPnlSol: 2.5,
        lastUpdatedMs: 1_000_000,
      };
      writeFileSync(walletPath, JSON.stringify(legacyWallet), "utf8");

      const loaded = loadVirtualWallet(walletPath);
      expect(loaded.currentBalanceSol).toBe(12.5);
      expect(loaded.allTimeRealizedPnlSol).toBe(2.5);
      expect(loaded.totalSessionsCompleted).toBe(2);
      expect(loaded.settledSessionIds).toEqual([]);
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("P0-C: enforces idempotent settlement: duplicate session settlement is a no-op", () => {
      const wallet: VirtualWalletState = {
        walletAddress: "TestWallet111",
        currentBalanceSol: 10.0,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 0,
        allTimeRealizedPnlSol: 0.0,
        lastUpdatedMs: nowMs,
        settledSessionIds: [],
      };

      const firstSettled = settleSessionInWallet(
        wallet,
        "session-test-01",
        11.2,
        10.0,
        nowMs + 1000,
      );
      expect(firstSettled).toBe(true);
      expect(wallet.currentBalanceSol).toBe(11.2);
      expect(wallet.allTimeRealizedPnlSol).toBe(1.2);
      expect(wallet.totalSessionsCompleted).toBe(1);
      expect(wallet.settledSessionIds).toEqual(["session-test-01"]);

      // Re-settling same session ID must be rejected without mutating state
      const secondSettled = settleSessionInWallet(
        wallet,
        "session-test-01",
        15.0,
        10.0,
        nowMs + 2000,
      );
      expect(secondSettled).toBe(false);
      expect(wallet.currentBalanceSol).toBe(11.2);
      expect(wallet.allTimeRealizedPnlSol).toBe(1.2);
      expect(wallet.totalSessionsCompleted).toBe(1);
    });

    // P0-E: Absolute protective stop and peak preservation on scale-in
    it("P0-E: preserves historicalPeakPriceSol across scale-in", () => {
      const daemon = new PaperTradingDaemon({ config: baseConfig, clock: () => nowMs });
      daemon.start();
      daemon.processScannedPool(validPool, nowMs, 0.05, 0.5, {
        bypassScannerEvaluation: true,
        cohort: "ESTABLISHED",
        ratchetConfig: ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
      });
      const pos = daemon.getSnapshot().openPositions[0]!;

      // Price surges to 0.0575 SOL (+15%, below +20% Tier 1), then pulls back to 0.055 SOL (+10%)
      daemon.tickPosition(
        pos.positionId,
        {
          currentTimestampMs: nowMs + 1000,
          spotPriceSol: 0.0575,
          lpIntact: true,
          recentBuysCount60s: 20,
          recentSellsCount60s: 5,
          momentum5mBps: 500,
          volumeStalled3m: false,
        },
        nowMs + 1000,
      );

      const scaled = daemon.scaleInPosition(pos.positionId, 0.5, 0.055, nowMs + 2000);
      expect(scaled).toBeDefined();
      expect(scaled?.historicalPeakPriceSol).toBe(0.0575);
    });

    it("P0-E: absolute protective stop in SOL is never lowered after scale-in", () => {
      const daemon = new PaperTradingDaemon({ config: baseConfig, clock: () => nowMs });
      daemon.start();
      daemon.processScannedPool(validPool, nowMs, 0.05, 0.5, {
        bypassScannerEvaluation: true,
        cohort: "ESTABLISHED",
        ratchetConfig: ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
      });
      const pos = daemon.getSnapshot().openPositions[0]!;

      // Simulate a previously locked stop floor at +10% (0.055 SOL absolute stop)
      pos.ratchetState = { ...pos.ratchetState, currentStopFloorBps: 1000 };
      const oldStopPriceSol = 0.05 * 1.1; // 0.055 SOL

      // Spot is 0.060 SOL (+20%), scale in 0.5 SOL
      const scaled = daemon.scaleInPosition(pos.positionId, 0.5, 0.06, nowMs + 1000);
      expect(scaled).toBeDefined();

      const blendedEntry = scaled!.entryPriceSol;
      const newStopFloorBps = scaled!.ratchetState.currentStopFloorBps;
      const newStopPriceSol = blendedEntry * (1 + newStopFloorBps / 10_000);

      // New absolute stop price in SOL must NOT be lower than old stop price (0.055 SOL)
      expect(newStopPriceSol).toBeGreaterThanOrEqual(oldStopPriceSol - 1e-9);
    });

    it("P0-E: rejects scale-in if spot price is <= target stop price", () => {
      const daemon = new PaperTradingDaemon({ config: baseConfig, clock: () => nowMs });
      daemon.start();
      daemon.processScannedPool(validPool, nowMs, 0.05, 0.5, {
        bypassScannerEvaluation: true,
        cohort: "ESTABLISHED",
        ratchetConfig: ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
      });
      const pos = daemon.getSnapshot().openPositions[0]!;

      // If stop floor was locked at +10% (0.055 SOL) and spot is 0.054 SOL (below target stop)
      pos.ratchetState = { ...pos.ratchetState, currentStopFloorBps: 1000 };
      const rejected = daemon.scaleInPosition(pos.positionId, 0.5, 0.054, nowMs + 1000);
      expect(rejected).toBeNull();
    });

    it("P0-E: rejects scale-in after Tier 1 taken or while paused/exiting", () => {
      const daemon = new PaperTradingDaemon({ config: baseConfig, clock: () => nowMs });
      daemon.start();
      daemon.processScannedPool(validPool, nowMs, 0.05, 0.5, {
        bypassScannerEvaluation: true,
        cohort: "ESTABLISHED",
        ratchetConfig: ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
      });
      const pos = daemon.getSnapshot().openPositions[0]!;

      // 1. After Tier 1 taken
      pos.tier1ProfitTaken = true;
      expect(daemon.scaleInPosition(pos.positionId, 0.5, 0.06, nowMs + 1000)).toBeNull();
      pos.tier1ProfitTaken = false;

      // 2. While paused
      daemon.pause();
      expect(daemon.scaleInPosition(pos.positionId, 0.5, 0.06, nowMs + 1000)).toBeNull();
      daemon.resume();

      // 3. While exiting
      daemon.startExiting();
      expect(daemon.scaleInPosition(pos.positionId, 0.5, 0.06, nowMs + 1000)).toBeNull();
    });

    // P0-F: Cohort-calibrated unconditional pre-breakeven stops
    it("P0-F: Established cohort cuts unconditionally at -10% pre-breakeven threshold regardless of buyers", () => {
      const daemon = new PaperTradingDaemon({ config: baseConfig, clock: () => nowMs });
      daemon.start();
      daemon.processScannedPool(validPool, nowMs, 0.05, 1.0, {
        bypassScannerEvaluation: true,
        cohort: "ESTABLISHED",
        ratchetConfig: ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
      });
      const pos = daemon.getSnapshot().openPositions[0]!;

      // Drops to 0.0449 SOL (-10.2% pnl), with strong buyer flow (50 buys vs 10 sells)
      const exitResult = daemon.tickPosition(
        pos.positionId,
        {
          currentTimestampMs: nowMs + 1000,
          spotPriceSol: 0.0449,
          lpIntact: true,
          recentBuysCount60s: 50,
          recentSellsCount60s: 10,
          momentum5mBps: -400,
          volumeStalled3m: false,
        },
        nowMs + 1000,
      );

      expect(exitResult?.action).toBe("SELL_ALL");
      expect(exitResult?.reasonCode).toBe("UNCONFIRMED_PRE_BREAKEVEN_CUT");
    });

    it("P0-F: Micro-Cap cohort cuts unconditionally at -12% pre-breakeven threshold regardless of buyers", () => {
      const daemon = new PaperTradingDaemon({ config: baseConfig, clock: () => nowMs });
      daemon.start();
      daemon.processScannedPool(validPool, nowMs, 0.05, 1.0, {
        bypassScannerEvaluation: true,
        cohort: "MICRO_CAP",
        ratchetConfig: MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
      });
      const pos = daemon.getSnapshot().openPositions[0]!;

      // Drops to 0.0439 SOL (-12.2% pnl), with strong buyer flow (50 buys vs 10 sells)
      const exitResult = daemon.tickPosition(
        pos.positionId,
        {
          currentTimestampMs: nowMs + 1000,
          spotPriceSol: 0.0439,
          lpIntact: true,
          recentBuysCount60s: 50,
          recentSellsCount60s: 10,
          momentum5mBps: -500,
          volumeStalled3m: false,
        },
        nowMs + 1000,
      );

      expect(exitResult?.action).toBe("SELL_ALL");
      expect(exitResult?.reasonCode).toBe("UNCONFIRMED_PRE_BREAKEVEN_CUT");
    });

    // P0-G: Portfolio drawdown validation and negative basis-point semantics
    it("P0-G: validates drawdown threshold: normalizes positive to negative and rejects zero/invalid values", () => {
      // Positive bps input -> normalized to negative
      const daemonPos = new PaperTradingDaemon({
        config: { ...baseConfig, maxPortfolioDrawdownBps: 750 },
      });
      expect(daemonPos.getSnapshot().status).toBe("IDLE");

      // Zero bps -> throws
      expect(
        () =>
          new PaperTradingDaemon({
            config: { ...baseConfig, maxPortfolioDrawdownBps: 0 },
          }),
      ).toThrow("[INVALID_CONFIG]");

      // Out of bounds -> throws
      expect(
        () =>
          new PaperTradingDaemon({
            config: { ...baseConfig, maxPortfolioDrawdownBps: 15000 },
          }),
      ).toThrow("[INVALID_CONFIG]");
    });

    it("P0-G: transitions to EXITING on drawdown breach with open positions, freezing admissions", () => {
      const daemon = new PaperTradingDaemon({
        config: {
          ...baseConfig,
          initialPortfolioSol: 1.0,
          positionSizeSol: 1.0,
          maxPortfolioDrawdownBps: -500, // -5.0% = -0.05 SOL loss
        },
        clock: () => nowMs,
      });
      daemon.start();
      daemon.processScannedPool(validPool, nowMs, 0.05, 1.0);
      const pos = daemon.getSnapshot().openPositions[0]!;

      // Position drops to 0.047 SOL (-6.0% pnl)
      // At -6.0%, it enters drawdown grace (does not close yet, holds in grace)
      // But portfolio is at 0.94 SOL (-6.0% drawdown <= -5.0% threshold)
      const tickResult = daemon.tickPosition(
        pos.positionId,
        {
          currentTimestampMs: nowMs + 1000,
          spotPriceSol: 0.047,
          lpIntact: true,
          recentBuysCount60s: 10,
          recentSellsCount60s: 5,
          momentum5mBps: -100,
          volumeStalled3m: false,
        },
        nowMs + 1000,
      );

      expect(tickResult?.action).toBe("HOLD");
      const snapshot = daemon.getSnapshot();
      expect(snapshot.haltReason).toBe("PORTFOLIO_DRAWDOWN_BREACHED");
      // Status is EXITING because open positions exist, allowing active exit management
      expect(snapshot.status).toBe("EXITING");
      expect(snapshot.openPositions.length).toBe(1);

      // New admissions rejected while EXITING
      expect(
        daemon.processScannedPool(
          {
            ...validPool,
            poolId: "pool-2",
            mintAddress: "Mint2222222222222222222222222222222222222222",
          },
          nowMs + 2000,
        ),
      ).toBe(false);

      // Once open position exits, daemon transitions to HALTED
      daemon.manualExit(pos.positionId, 0.047, nowMs + 3000, "MANUAL_OPERATOR_EXIT");
      const finalSnap = daemon.getSnapshot();
      expect(finalSnap.openPositions.length).toBe(0);
      expect(finalSnap.status).toBe("HALTED");
    });
  });
});
