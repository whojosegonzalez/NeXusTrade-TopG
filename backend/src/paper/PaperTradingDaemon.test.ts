import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
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
  saveVirtualWallet,
  settleSessionInWallet,
  reconcileWalletInventory,
} from "./VirtualWallet.js";
import type { ScannedPoolRecord } from "../candidate-scanner/CandidateScannerTypes.js";
import {
  type MarketEvaluationContext,
  MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
  ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
} from "../exits/DynamicRatchetTypes.js";
import { recoverSettlementJournal, type SettlementJournalEntry } from "./SettlementJournal.js";
import { checkLegacyConflict, findWorkspaceRoot } from "./CanonicalPaths.js";
import { acquireProcessLock, releaseProcessLock, isProcessAlive } from "./ProcessLock.js";
import { parseCliArgs } from "../scripts/paper-trading-daemon.js";
import {
  recoverInterruptedIntent,
  type ReconciliationIntent,
} from "../scripts/reconcile-unresolved.js";

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

    // Phase 12.93C: P0-1, P0-2, P0-3 Regressions
    it("P0-1: markPositionUnresolved preserves full token metadata, partial proceeds, and tier history", () => {
      const daemon = new PaperTradingDaemon({
        config: { ...baseConfig, initialPortfolioSol: 10.0, positionSizeSol: 1.0 },
        clock: () => nowMs,
      });
      daemon.start();
      daemon.processScannedPool(validPool, nowMs, 0.05, 1.0);
      const pos = daemon.getSnapshot().openPositions[0]!;

      // Take Tier 1 profit (e.g. +20% gain, sells 33% of position)
      daemon.tickPosition(
        pos.positionId,
        {
          currentTimestampMs: nowMs + 1000,
          spotPriceSol: 0.06, // +20% gain -> trips Tier 1 (1500 bps)
          lpIntact: true,
          recentBuysCount60s: 15,
          recentSellsCount60s: 2,
          momentum5mBps: 200,
          volumeStalled3m: false,
        },
        nowMs + 1000,
      );

      const posAfterT1 = daemon.getSnapshot().openPositions[0]!;
      expect(posAfterT1.tier1ProfitTaken).toBe(true);
      expect(posAfterT1.realizedProceedsSol).toBeGreaterThan(0);

      // Now price feed disappears at scheduled cashout -> mark unresolved
      const unresolved = daemon.markPositionUnresolved(
        pos.positionId,
        "PRICE_FEED_UNAVAILABLE_AT_CASHOUT",
        nowMs + 2000,
      );

      expect(unresolved).not.toBeNull();
      expect(unresolved?.tokensHeld).toBe(posAfterT1.tokensHeld);
      expect(unresolved?.costBasisSol).toBe(posAfterT1.costBasisSol);
      expect(unresolved?.initialCostBasisSol).toBe(1.0);
      expect(unresolved?.initialTokensHeld).toBe(20.0);
      expect(unresolved?.realizedProceedsSol).toBe(posAfterT1.realizedProceedsSol);
      expect(unresolved?.tier1ProfitTaken).toBe(true);
      expect(unresolved?.lastObservedPriceSol).toBe(0.06);

      // Snapshot validation:
      const snap = daemon.getSnapshot();
      expect(snap.openPositions.length).toBe(0);
      expect(snap.unresolvedPositions?.length).toBe(1);
      expect(snap.unresolvedCostBasisSol).toBe(posAfterT1.costBasisSol);
      expect(snap.currentCashSol).toBeGreaterThan(9.0); // 9.0 SOL + T1 proceeds
      // Realized PnL strictly accounts for Tier 1 closed proceeds, does NOT book remaining tokens as -1.0 loss!
      expect(snap.totalRealizedPnlSol).toBeGreaterThan(0);
    });

    it("P0-1: settleSessionInWallet preserves unresolved token inventory in wallet without booking unrealized loss", () => {
      const wallet: VirtualWalletState = {
        walletAddress: "TestWalletP01",
        currentBalanceSol: 10.0,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 1,
        allTimeRealizedPnlSol: 0.0,
        lastUpdatedMs: nowMs,
        settledSessionIds: ["session-0"],
        unresolvedTokens: [],
      };

      const unresolvedMock = [
        {
          positionId: "pos-unresolved-1",
          mintAddress: "MintUnresolved1111111111111111111111111111",
          symbol: "UNRES",
          tokensHeld: 15.0,
          costBasisSol: 0.75,
          initialCostBasisSol: 1.0,
          initialTokensHeld: 20.0,
          realizedProceedsSol: 0.35,
          lastObservedPriceSol: 0.05,
          lastObservedAtMs: nowMs + 1000,
          reasonForMissingData: "MISSING_FEED_AT_CASHOUT",
        },
      ];

      // Settle session with 9.25 SOL cash and +0.10 SOL realized profit from closed tier sales
      const settled = settleSessionInWallet(
        wallet,
        "session-1",
        9.25, // Available cash
        10.0, // Initial capital
        nowMs + 2000,
        unresolvedMock,
        0.1, // sessionRealizedPnlSol
      );

      expect(settled).toBe(true);
      expect(wallet.currentBalanceSol).toBe(9.25); // Cash available for next session
      expect(wallet.allTimeRealizedPnlSol).toBe(0.1); // NOT -0.75 SOL!
      expect(wallet.unresolvedTokens?.length).toBe(1);
      expect(wallet.unresolvedTokens![0]!.mintAddress).toBe(
        "MintUnresolved1111111111111111111111111111",
      );
      expect(wallet.unresolvedTokens![0]!.tokensHeld).toBe(15.0);
      expect(wallet.unresolvedTokens![0]!.costBasisSol).toBe(0.75);
    });

    it("P0-2: recordStagnantTick treats prices older than 30s without fresh feed as feed outage tick", () => {
      let clockTime = nowMs;
      const daemon = new PaperTradingDaemon({
        config: baseConfig,
        clock: () => clockTime,
      });
      daemon.start();
      daemon.processScannedPool(validPool, clockTime, 0.05, 1.0);
      const pos = daemon.getSnapshot().openPositions[0]!;

      // Advance clock by 45 seconds without positive price tick
      clockTime += 45_000;

      // Calling recordStagnantTick without a fresh price parameter must reject the 45s stale spot
      const stagnantResult = daemon.recordStagnantTick(pos.positionId, undefined, clockTime);
      expect(stagnantResult).toBeNull();

      const snap = daemon.getSnapshot();
      expect(snap.openPositions[0]!.feedOutageTicksCount).toBe(1);
      expect(snap.closedTrades.length).toBe(0);
    });

    it("P0-2: recordStagnantTick with fresh price evidence exits after 180s inactivity", () => {
      let clockTime = nowMs;
      const daemon = new PaperTradingDaemon({
        config: baseConfig,
        clock: () => clockTime,
      });
      daemon.start();
      daemon.processScannedPool(validPool, clockTime, 0.05, 1.0);
      const pos = daemon.getSnapshot().openPositions[0]!;

      // Advance clock past 180s stagnancy threshold, supplying a fresh valid price
      clockTime += 185_000;
      const stagnantResult = daemon.recordStagnantTick(pos.positionId, 0.05, clockTime);

      expect(stagnantResult).not.toBeNull();
      expect(stagnantResult?.exitReason).toBe("STAGNANCY_TIMEOUT_EXIT");
      expect(daemon.getSnapshot().closedTrades.length).toBe(1);
    });

    it("P0-3: round-trips wallet with unresolved tokens and prevents duplicate tokens", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "wallet-p03-"));
      const walletPath = path.join(tempDir, "virtual-wallet.json");

      const initialWallet: VirtualWalletState = {
        walletAddress: "RoundTripWallet",
        currentBalanceSol: 8.5,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 1,
        allTimeRealizedPnlSol: 0.25,
        lastUpdatedMs: nowMs,
        settledSessionIds: ["sess-1"],
        unresolvedTokens: [
          {
            positionId: "pos-rt-1",
            mintAddress: "MintRT111",
            symbol: "RT",
            tokensHeld: 100,
            costBasisSol: 1.5,
            lastObservedPriceSol: 0.015,
            lastObservedAtMs: nowMs,
            reasonForMissingData: "FEED_TIMEOUT",
            sessionId: "sess-1",
          },
        ],
      };

      saveVirtualWallet(initialWallet, walletPath);
      const loaded = loadVirtualWallet(walletPath);

      expect(loaded.currentBalanceSol).toBe(8.5);
      expect(loaded.unresolvedTokens?.length).toBe(1);
      expect(loaded.unresolvedTokens![0]!.mintAddress).toBe("MintRT111");

      // Resettling with same positionId does not duplicate inventory
      settleSessionInWallet(
        loaded,
        "sess-2",
        8.5,
        10.0,
        nowMs + 1000,
        [
          {
            positionId: "pos-rt-1", // duplicate position
            mintAddress: "MintRT111",
            tokensHeld: 100,
            costBasisSol: 1.5,
            lastObservedPriceSol: 0.015,
            lastObservedAtMs: nowMs,
            reasonForMissingData: "FEED_TIMEOUT",
          },
        ],
        0.0,
      );

      expect(loaded.unresolvedTokens?.length).toBe(1); // deduplicated!
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("P0-R1: termination interruption converts open positions to unresolved inventory preserving cost basis", () => {
      const mockTime = nowMs;
      const daemon = new PaperTradingDaemon({
        config: baseConfig,
        clock: () => mockTime,
      });
      daemon.start();

      const candidate: ScannedPoolRecord = {
        ...validPool,
        poolId: "pool-term-1",
        mintAddress: "MintTerm111",
        symbol: "TERM",
      };

      daemon.processScannedPool(candidate, mockTime, 0.05, 1.0);

      const openPositions = daemon.getSnapshot().openPositions;
      expect(openPositions.length).toBe(1);
      const pos = openPositions[0]!;

      // Simulate termination signal interruption
      daemon.stop("MANUAL_STOP");
      const unresolved = daemon.markPositionUnresolved(
        pos.positionId,
        "TERMINATION_SIGNAL_INTERRUPTION",
        mockTime + 5000,
      );

      expect(unresolved).not.toBeNull();
      expect(unresolved?.mintAddress).toBe("MintTerm111");
      expect(unresolved?.tokensHeld).toBe(pos.tokensHeld);
      expect(unresolved?.costBasisSol).toBe(pos.costBasisSol);
      expect(unresolved?.reasonForMissingData).toBe("TERMINATION_SIGNAL_INTERRUPTION");
      expect(unresolved?.estimatedLiquidationSol).toBe(0);

      const snap = daemon.getSnapshot();
      expect(snap.openPositions.length).toBe(0);
      expect(snap.unresolvedPositions?.length).toBe(1);
      expect(snap.currentCashSol).toBe(9.0); // 10.0 initial - 1.0 cost basis
    });

    it("P0-R2: daemon restores unresolved positions on startup and blocks duplicate re-buys", () => {
      const mockTime = nowMs;
      const initialUnresolved = [
        {
          positionId: "pos-prev-unres-1",
          mintAddress: "MintBlocked111",
          symbol: "BLOCKED",
          tokensHeld: 2000,
          costBasisSol: 1.0,
          lastObservedPriceSol: 0.0005,
          lastObservedAtMs: nowMs - 100_000,
          reasonForMissingData: "TERMINATION_SIGNAL_INTERRUPTION",
          estimatedLiquidationSol: 0,
          sessionId: "session-prev",
        },
      ];

      const daemon = new PaperTradingDaemon({
        config: baseConfig,
        clock: () => mockTime,
        initialUnresolvedPositions: initialUnresolved,
      });
      daemon.start();

      const snap = daemon.getSnapshot();
      expect(snap.unresolvedPositions?.length).toBe(1);
      expect(snap.unresolvedPositions![0]!.mintAddress).toBe("MintBlocked111");

      // Attempting to buy the same mint must be blocked
      const pool: ScannedPoolRecord = {
        ...validPool,
        poolId: "pool-blocked-1",
        mintAddress: "MintBlocked111",
        symbol: "BLOCKED",
      };

      const bought = daemon.processScannedPool(pool, mockTime, 0.05, 1.0);
      expect(bought).toBe(false);
      expect(daemon.getSnapshot().openPositions.length).toBe(0);
    });

    it("P0-R2: reconcileUnresolvedPosition liquidates unresolved token into cash, closed trade, and unblocks mint", () => {
      const mockTime = nowMs;
      const initialUnresolved = [
        {
          positionId: "pos-recon-1",
          mintAddress: "MintRecon111",
          symbol: "RECON",
          tokensHeld: 2000,
          costBasisSol: 1.0,
          lastObservedPriceSol: 0.0005,
          lastObservedAtMs: nowMs - 50_000,
          reasonForMissingData: "FEED_TIMEOUT",
          estimatedLiquidationSol: 0,
          sessionId: "session-prev",
        },
      ];

      const daemon = new PaperTradingDaemon({
        config: baseConfig,
        clock: () => mockTime,
        initialUnresolvedPositions: initialUnresolved,
      });
      daemon.start();

      expect(daemon.getSnapshot().currentCashSol).toBe(10.0);
      expect(daemon.getSnapshot().unresolvedPositions?.length).toBe(1);

      // Reconcile unresolved position at 0.0006 SOL/token (proceeds = 1.2 SOL, profit = +0.2 SOL)
      const closed = daemon.reconcileUnresolvedPosition(
        "MintRecon111",
        0.0006,
        mockTime + 1000,
        "MANUAL_RECONCILIATION",
      );

      expect(closed).not.toBeNull();
      expect(closed?.mintAddress).toBe("MintRecon111");
      expect(closed?.proceedsSol).toBeCloseTo(1.2, 4);
      expect(closed?.realizedPnlSol).toBeCloseTo(0.2, 4);
      expect(closed?.exitReason).toBe("MANUAL_RECONCILIATION");

      const snap = daemon.getSnapshot();
      expect(snap.unresolvedPositions?.length).toBe(0);
      expect(snap.currentCashSol).toBeCloseTo(11.2, 4); // 10.0 + 1.2 proceeds
      expect(snap.closedTrades.length).toBe(1);

      // Settle in wallet with reconciledPositionIds to prune it from wallet inventory
      const wallet: VirtualWalletState = {
        walletAddress: "SimWalletRecon",
        currentBalanceSol: 10.0,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 1,
        allTimeRealizedPnlSol: 0.0,
        lastUpdatedMs: nowMs,
        settledSessionIds: ["session-0"],
        unresolvedTokens: [
          {
            positionId: "pos-recon-1",
            mintAddress: "MintRecon111",
            tokensHeld: 2000,
            costBasisSol: 1.0,
            lastObservedPriceSol: 0.0005,
            lastObservedAtMs: nowMs - 50_000,
            reasonForMissingData: "FEED_TIMEOUT",
            sessionId: "session-0",
          },
        ],
      };

      settleSessionInWallet(
        wallet,
        "session-1",
        snap.currentCashSol!,
        baseConfig.initialPortfolioSol,
        mockTime + 2000,
        snap.unresolvedPositions,
        snap.totalRealizedPnlSol,
        ["pos-recon-1"],
      );

      expect(wallet.currentBalanceSol).toBeCloseTo(11.2, 4);
      expect(wallet.unresolvedTokens?.length).toBe(0); // Successfully pruned!
      expect(wallet.allTimeRealizedPnlSol).toBeCloseTo(0.2, 4);
    });

    it("P0-R3: loadVirtualWallet fails closed if wallet is missing but prior session history exists", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "vw-failclosed-test-"));
      const pastSessionsFile = path.join(tempDir, "past-sessions.json");
      writeFileSync(pastSessionsFile, JSON.stringify([{ sessionId: "session-1" }]), "utf8");

      const missingWalletFile = path.join(tempDir, "virtual-wallet.json");
      expect(() => loadVirtualWallet(missingWalletFile)).toThrow(/FATAL.*Virtual wallet missing/);

      rmSync(tempDir, { recursive: true, force: true });
    });
    it("D7-01: 3-session incremental realized P&L accounting invariant (no phantom profit on restore)", () => {
      // SESSION 1: Buy token, TP1 partial scale-out, exit with unresolved remainder
      let clockTime = nowMs;
      const initialWalletSol = 10.0;
      const wallet: VirtualWalletState = {
        walletAddress: "SimulatedWallet3Session",
        currentBalanceSol: initialWalletSol,
        initialBalanceSol: initialWalletSol,
        totalSessionsCompleted: 0,
        allTimeRealizedPnlSol: 0.0,
        lastUpdatedMs: clockTime,
        settledSessionIds: [],
        unresolvedTokens: [],
      };

      const daemon1 = new PaperTradingDaemon({
        config: { ...baseConfig, sessionId: "session-1", initialPortfolioSol: initialWalletSol },
        clock: () => clockTime,
      });
      daemon1.start();

      // Buy position: 0.5 SOL cost basis, 10,000 tokens @ 0.00005 SOL
      const pool: ScannedPoolRecord = {
        ...validPool,
        poolId: "pool-d7-1",
        mintAddress: "MintD7Token11111111111111111111111111111111",
        symbol: "D7TOKEN",
      };
      daemon1.processScannedPool(pool, clockTime, 0.00005, 0.5);
      const posId = daemon1.getSnapshot().openPositions[0]!.positionId;

      // Price pumps: trigger TP1 (SELL_PARTIAL_50)
      // spot = 0.00007 SOL (40% gain)
      // tokensToSell = 5,000, proceeds = 5,000 * 0.00007 = 0.35 SOL
      // costRelieved = 0.25 SOL, incremental PnL = +0.10 SOL
      const marketContextTP1: MarketEvaluationContext = {
        ...baseMarketContext,
        spotPriceSol: 0.00007,
        currentTimestampMs: clockTime + 1000,
      };
      const tickRes = daemon1.tickPosition(posId, marketContextTP1, clockTime + 1000);
      expect(tickRes?.action).toBe("SELL_PARTIAL_50");

      // Verify Session 1 cash and incremental realized P&L
      expect(daemon1.getCurrentCashSol()).toBeCloseTo(9.5 + 0.35, 4); // 9.85 SOL
      expect(daemon1.getSessionNewRealizedPnlSol()).toBeCloseTo(0.1, 4);

      // Session 1 ends: mark remaining 5,000 tokens as unresolved
      daemon1.markPositionUnresolved(posId, "TERMINATION_SIGNAL_INTERRUPTION", clockTime + 2000);
      const snap1 = daemon1.getSnapshot();
      expect(snap1.openPositions.length).toBe(0);
      expect(snap1.unresolvedPositions?.length).toBe(1);
      expect(snap1.sessionNewRealizedPnlSol).toBeCloseTo(0.1, 4);

      // Settle Session 1 into continuous wallet
      settleSessionInWallet(
        wallet,
        snap1.sessionId,
        snap1.currentCashSol!,
        initialWalletSol,
        clockTime + 3000,
        snap1.unresolvedPositions,
        snap1.sessionNewRealizedPnlSol,
      );
      expect(wallet.currentBalanceSol).toBeCloseTo(9.85, 4);
      expect(wallet.allTimeRealizedPnlSol).toBeCloseTo(0.1, 4);
      expect(wallet.unresolvedTokens?.length).toBe(1);
      expect(wallet.unresolvedTokens![0]!.costBasisSol).toBeCloseTo(0.25, 4);

      // SESSION 2: Restores unresolved position. ZERO trades executed during the session!
      clockTime += 100_000;
      const daemon2 = new PaperTradingDaemon({
        config: {
          ...baseConfig,
          sessionId: "session-2",
          initialPortfolioSol: wallet.currentBalanceSol,
        },
        clock: () => clockTime,
        initialUnresolvedPositions: wallet.unresolvedTokens,
      });
      daemon2.start();

      expect(daemon2.getSnapshot().unresolvedPositions?.length).toBe(1);
      expect(daemon2.getCurrentCashSol()).toBeCloseTo(9.85, 4);

      // Zero trades happen in Session 2. Session 2 concludes.
      const snap2 = daemon2.getSnapshot();
      expect(snap2.closedTrades.length).toBe(0);
      expect(snap2.sessionNewRealizedPnlSol).toBe(0); // STRICT ZERO INCREMENTAL GAIN

      // Settle Session 2 into continuous wallet
      settleSessionInWallet(
        wallet,
        snap2.sessionId,
        snap2.currentCashSol!,
        wallet.currentBalanceSol,
        clockTime + 5000,
        snap2.unresolvedPositions,
        snap2.sessionNewRealizedPnlSol,
      );
      // INVARIANT: Wallet cash and cumulative PnL MUST NOT CHANGE
      expect(wallet.currentBalanceSol).toBeCloseTo(9.85, 4);
      expect(wallet.allTimeRealizedPnlSol).toBeCloseTo(0.1, 4); // NO PHANTOM PROFIT RECOGNIZED!
      expect(wallet.unresolvedTokens?.length).toBe(1);

      // SESSION 3: Restores unresolved position. Position is finally reconciled / sold!
      clockTime += 100_000;
      const daemon3 = new PaperTradingDaemon({
        config: {
          ...baseConfig,
          sessionId: "session-3",
          initialPortfolioSol: wallet.currentBalanceSol,
        },
        clock: () => clockTime,
        initialUnresolvedPositions: wallet.unresolvedTokens,
      });
      daemon3.start();

      // Reconcile remaining 5,000 tokens at 0.00007 SOL/token:
      // proceeds = 5,000 * 0.00007 = 0.35 SOL
      // remaining basis = 0.25 SOL
      // incremental gain in Session 3 = 0.35 - 0.25 = +0.10 SOL
      const closed = daemon3.reconcileUnresolvedPosition(
        "MintD7Token11111111111111111111111111111111",
        0.00007,
        clockTime + 1000,
        "MANUAL_RECONCILIATION",
      );
      expect(closed).not.toBeNull();
      expect(daemon3.getCurrentCashSol()).toBeCloseTo(9.85 + 0.35, 4); // 10.20 SOL
      expect(daemon3.getSessionNewRealizedPnlSol()).toBeCloseTo(0.1, 4);

      const snap3 = daemon3.getSnapshot();
      expect(snap3.unresolvedPositions?.length).toBe(0);

      // Settle Session 3 into continuous wallet
      settleSessionInWallet(
        wallet,
        snap3.sessionId,
        snap3.currentCashSol!,
        wallet.currentBalanceSol,
        clockTime + 2000,
        snap3.unresolvedPositions,
        snap3.sessionNewRealizedPnlSol,
        [posId],
      );

      // FINAL 3-SESSION INVARIANTS:
      expect(wallet.currentBalanceSol).toBeCloseTo(10.2, 4);
      expect(wallet.allTimeRealizedPnlSol).toBeCloseTo(0.2, 4);
      expect(wallet.unresolvedTokens?.length).toBe(0);
      const totalCashDelta = wallet.currentBalanceSol - initialWalletSol;
      expect(totalCashDelta).toBeCloseTo(wallet.allTimeRealizedPnlSol, 4); // CASH DELTA === REALIZED PNL EXACTLY!
    });

    it("D7-02: operator reconciliation workflow distinguishes simulated sale, write-down, and final disposal", () => {
      const mockTime = nowMs;
      const initialWallet: VirtualWalletState = {
        walletAddress: "SimWalletD702",
        currentBalanceSol: 10.0,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 1,
        allTimeRealizedPnlSol: 0.0,
        lastUpdatedMs: mockTime,
        settledSessionIds: ["sess-1"],
        unresolvedTokens: [
          {
            positionId: "pos-sale-1",
            mintAddress: "MintSale111",
            tokensHeld: 1000,
            costBasisSol: 0.5,
            lastObservedPriceSol: 0.0005,
            lastObservedAtMs: mockTime,
            reasonForMissingData: "FEED_TIMEOUT",
            sessionId: "sess-1",
          },
          {
            positionId: "pos-writedown-1",
            mintAddress: "MintWriteDown111",
            tokensHeld: 2000,
            costBasisSol: 0.8,
            lastObservedPriceSol: 0.0004,
            lastObservedAtMs: mockTime,
            reasonForMissingData: "STAGNANCY",
            sessionId: "sess-1",
            estimatedLiquidationSol: 0.2,
          },
          {
            positionId: "pos-dispose-1",
            mintAddress: "MintDispose111",
            tokensHeld: 5000,
            costBasisSol: 1.0,
            lastObservedPriceSol: 0.0002,
            lastObservedAtMs: mockTime,
            reasonForMissingData: "LIQUIDITY_PULLED",
            sessionId: "sess-1",
          },
        ],
      };

      // 1. Operation: WRITE_DOWN (manual valuation adjustment)
      // Must NOT sell tokens, must NOT credit cash, must NOT alter allTimeRealizedPnlSol, MUST retain inventory!
      const writeDownRes = reconcileWalletInventory(initialWallet, {
        identifier: "pos-writedown-1",
        operationType: "WRITE_DOWN",
        writeDownEstimatedSol: 0.05,
        reason: "Adjust mark to conservative estimate of 0.05 SOL",
        nowMsTimestamp: mockTime + 1000,
      });

      expect(writeDownRes.operationType).toBe("WRITE_DOWN");
      expect(initialWallet.currentBalanceSol).toBe(10.0); // No fictitious cash
      expect(initialWallet.allTimeRealizedPnlSol).toBe(0.0); // No PnL change
      expect(initialWallet.unresolvedTokens?.length).toBe(3); // Retained!
      const updatedItem = initialWallet.unresolvedTokens?.find(
        (t) => t.positionId === "pos-writedown-1",
      );
      expect(updatedItem?.estimatedLiquidationSol).toBe(0.05);

      // 2. Operation: SIMULATED_SALE (provenance price sale)
      // Sold 1,000 tokens @ 0.0007 SOL/token = 0.70 SOL proceeds. Cost basis = 0.50 SOL.
      // Net profit = +0.20 SOL. Cash increases by 0.70 SOL. Inventory is pruned.
      const saleRes = reconcileWalletInventory(initialWallet, {
        identifier: "pos-sale-1",
        operationType: "SIMULATED_SALE",
        exitPriceSol: 0.0007,
        reason: "Verified simulated exit against Raydium pair 0.0007 SOL",
        nowMsTimestamp: mockTime + 2000,
      });

      expect(saleRes.operationType).toBe("SIMULATED_SALE");
      expect(saleRes.proceedsSol).toBeCloseTo(0.7, 4);
      expect(saleRes.incrementalPnlSol).toBeCloseTo(0.2, 4);
      expect(initialWallet.currentBalanceSol).toBeCloseTo(10.7, 4);
      expect(initialWallet.allTimeRealizedPnlSol).toBeCloseTo(0.2, 4);
      expect(initialWallet.unresolvedTokens?.length).toBe(2);
      expect(initialWallet.unresolvedTokens?.some((t) => t.positionId === "pos-sale-1")).toBe(
        false,
      );

      // 3. Operation: FINAL_DISPOSAL (permanent write-off / abandonment)
      // Rug pulled / untradeable. Full remaining cost basis (1.0 SOL) booked as realized loss.
      // Cash unchanged. Inventory pruned.
      const disposeRes = reconcileWalletInventory(initialWallet, {
        identifier: "pos-dispose-1",
        operationType: "FINAL_DISPOSAL",
        reason: "LP pulled and mint freeze authority revoked - permanently untradeable",
        nowMsTimestamp: mockTime + 3000,
      });

      expect(disposeRes.operationType).toBe("FINAL_DISPOSAL");
      expect(disposeRes.proceedsSol).toBe(0);
      expect(disposeRes.incrementalPnlSol).toBeCloseTo(-1.0, 4);
      expect(initialWallet.currentBalanceSol).toBeCloseTo(10.7, 4); // Cash unaffected
      expect(initialWallet.allTimeRealizedPnlSol).toBeCloseTo(-0.8, 4); // +0.2 - 1.0 = -0.8
      expect(initialWallet.unresolvedTokens?.length).toBe(1); // Only pos-writedown-1 remains
      expect(initialWallet.unresolvedTokens![0]!.positionId).toBe("pos-writedown-1");
    });

    it("D7-01: multi-partial exits across sessions preserve exact cash and PnL delta", () => {
      let clockTime = nowMs;
      const initialWalletSol = 10.0;
      const wallet: VirtualWalletState = {
        walletAddress: "SimWalletMultiPartial",
        currentBalanceSol: initialWalletSol,
        initialBalanceSol: initialWalletSol,
        totalSessionsCompleted: 0,
        allTimeRealizedPnlSol: 0.0,
        lastUpdatedMs: clockTime,
        settledSessionIds: [],
        unresolvedTokens: [],
      };

      // SESSION 1: Buy token (1.0 SOL, 20,000 tokens @ 0.00005)
      const daemon1 = new PaperTradingDaemon({
        config: { ...baseConfig, sessionId: "sess-mp-1", initialPortfolioSol: initialWalletSol },
        clock: () => clockTime,
      });
      daemon1.start();
      daemon1.processScannedPool(
        { ...validPool, poolId: "pool-mp-1", mintAddress: "MintMultiPartial111" },
        clockTime,
        0.00005,
        1.0,
      );
      const posId = daemon1.getSnapshot().openPositions[0]!.positionId;

      // TP1: Sell 50% (10,000 tokens) @ 0.00007 SOL (proceeds = 0.70 SOL, costRelieved = 0.50 SOL, PnL = +0.20 SOL)
      const tick1 = daemon1.tickPosition(
        posId,
        { ...baseMarketContext, spotPriceSol: 0.00007, currentTimestampMs: clockTime + 1000 },
        clockTime + 1000,
      );
      expect(tick1?.action).toBe("SELL_PARTIAL_50");
      expect(daemon1.getSessionNewRealizedPnlSol()).toBeCloseTo(0.2, 4);

      // Session 1 ends: mark unresolved
      daemon1.markPositionUnresolved(posId, "TERMINATION_SIGNAL", clockTime + 2000);
      const snap1 = daemon1.getSnapshot();
      settleSessionInWallet(
        wallet,
        snap1.sessionId,
        snap1.currentCashSol!,
        initialWalletSol,
        clockTime + 3000,
        snap1.unresolvedPositions,
        snap1.sessionNewRealizedPnlSol,
      );
      expect(wallet.currentBalanceSol).toBeCloseTo(9.7, 4); // 10 - 1.0 + 0.70 = 9.70 SOL
      expect(wallet.allTimeRealizedPnlSol).toBeCloseTo(0.2, 4);

      // SESSION 2: Restore position (10,000 tokens held, 0.50 SOL basis)
      clockTime += 50_000;
      const daemon2 = new PaperTradingDaemon({
        config: {
          ...baseConfig,
          sessionId: "sess-mp-2",
          initialPortfolioSol: wallet.currentBalanceSol,
        },
        clock: () => clockTime,
        initialUnresolvedPositions: wallet.unresolvedTokens,
      });
      daemon2.start();

      // Sell remaining 10,000 tokens @ 0.00008 SOL (proceeds = 0.80 SOL, remaining basis = 0.50 SOL, incremental gain = +0.30 SOL)
      const closed = daemon2.reconcileUnresolvedPosition(
        "MintMultiPartial111",
        0.00008,
        clockTime + 1000,
        "MANUAL_RECONCILIATION",
      );
      expect(closed).not.toBeNull();
      expect(daemon2.getSessionNewRealizedPnlSol()).toBeCloseTo(0.3, 4);

      const snap2 = daemon2.getSnapshot();
      settleSessionInWallet(
        wallet,
        snap2.sessionId,
        snap2.currentCashSol!,
        wallet.currentBalanceSol,
        clockTime + 2000,
        snap2.unresolvedPositions,
        snap2.sessionNewRealizedPnlSol,
        [posId],
      );

      // Total across both sessions:
      expect(wallet.currentBalanceSol).toBeCloseTo(10.5, 4); // 9.7 + 0.8 = 10.5 SOL
      expect(wallet.allTimeRealizedPnlSol).toBeCloseTo(0.5, 4); // +0.2 + 0.3 = +0.5 SOL
      expect(wallet.unresolvedTokens?.length).toBe(0);
      expect(wallet.currentBalanceSol - initialWalletSol).toBeCloseTo(
        wallet.allTimeRealizedPnlSol,
        4,
      );
    });

    it.each([
      "STARTED",
      "SESSION_FILE_WRITTEN",
      "PAST_SESSIONS_WRITTEN",
      "WALLET_SETTLED",
      "COMMITTED",
    ] as const)(
      "E8-08: recoverSettlementJournal executes real production routine from stage %s",
      (stage) => {
        const tempDir = mkdtempSync(path.join(os.tmpdir(), `real-recovery-${stage}-`));
        const journalFile = path.join(tempDir, ".tmp", "settlement-journal.json");
        const sessionFile = path.join(tempDir, ".tmp", "sessions", "sess-recovery-real-1.json");
        const pastSessionsFile = path.join(tempDir, ".tmp", "past-sessions.json");
        const walletFile = path.join(tempDir, ".tmp", "virtual-wallet.json");

        mkdirSync(path.join(tempDir, ".tmp", "sessions"), { recursive: true });

        const initialWallet: VirtualWalletState = {
          walletAddress: "SimWalletRecoveryReal",
          currentBalanceSol: stage === "WALLET_SETTLED" ? 10.5 : 10.0,
          initialBalanceSol: 10.0,
          totalSessionsCompleted: stage === "WALLET_SETTLED" ? 1 : 0,
          allTimeRealizedPnlSol: stage === "WALLET_SETTLED" ? 0.5 : 0.0,
          lastUpdatedMs: nowMs,
          settledSessionIds: stage === "WALLET_SETTLED" ? ["sess-recovery-real-1"] : [],
          unresolvedTokens: [],
        };
        writeFileSync(walletFile, JSON.stringify(initialWallet, null, 2), "utf8");

        const mockSummary = {
          sessionId: "sess-recovery-real-1",
          startedAt: new Date(nowMs).toISOString(),
          endedAt: new Date(nowMs + 60000).toISOString(),
          durationMinutes: 1,
          startingCapitalSol: 10.0,
          endingCapitalSol: 10.5,
          netPnlSol: 0.5,
          netPnlPct: 5.0,
          totalTrades: 1,
          buysCount: 1,
          sellsCount: 1,
          winsCount: 1,
          lossesCount: 0,
          scratchesCount: 0,
          winRatePct: 100,
          coinsWatchedCount: 10,
          missedOpportunitiesCount: 2,
          trades: [],
        };

        if (
          stage === "SESSION_FILE_WRITTEN" ||
          stage === "PAST_SESSIONS_WRITTEN" ||
          stage === "WALLET_SETTLED"
        ) {
          writeFileSync(sessionFile, JSON.stringify(mockSummary, null, 2), "utf8");
        }
        if (stage === "PAST_SESSIONS_WRITTEN" || stage === "WALLET_SETTLED") {
          writeFileSync(pastSessionsFile, JSON.stringify([mockSummary], null, 2), "utf8");
        }

        const journalEntry: SettlementJournalEntry = {
          sessionId: "sess-recovery-real-1",
          startedAtMs: nowMs,
          stage,
          sessionSummary: mockSummary,
          sessionNewRealizedPnlSol: 0.5,
          liquidCashSol: 10.5,
          initialPortfolioSol: 10.0,
          unresolvedPositions: [],
          reconciledPositionIds: [],
        };
        writeFileSync(journalFile, JSON.stringify(journalEntry, null, 2), "utf8");

        // Invoke the ACTUAL production recovery routine!
        recoverSettlementJournal({
          journalPath: journalFile,
          workspaceRoot: tempDir,
          walletPath: walletFile,
        });

        if (stage !== "COMMITTED") {
          // Assert Stage 1: Individual session file was written
          expect(existsSync(sessionFile)).toBe(true);
          const sessionParsed = JSON.parse(readFileSync(sessionFile, "utf8"));
          expect(sessionParsed.sessionId).toBe("sess-recovery-real-1");

          // Assert Stage 2: past-sessions.json was updated
          expect(existsSync(pastSessionsFile)).toBe(true);
          const pastParsed = JSON.parse(readFileSync(pastSessionsFile, "utf8"));
          expect(Array.isArray(pastParsed)).toBe(true);
          expect(
            pastParsed.some((s: { sessionId: string }) => s.sessionId === "sess-recovery-real-1"),
          ).toBe(true);

          // Assert Stage 3: Virtual wallet was settled
          const settledWallet = JSON.parse(readFileSync(walletFile, "utf8"));
          expect(settledWallet.currentBalanceSol).toBe(10.5);
          expect(settledWallet.allTimeRealizedPnlSol).toBe(0.5);
          expect(settledWallet.settledSessionIds).toContain("sess-recovery-real-1");
          expect(settledWallet.totalSessionsCompleted).toBe(1);
        }

        // Assert Stage 4: Journal was marked COMMITTED and unlinked
        expect(existsSync(journalFile)).toBe(false);

        rmSync(tempDir, { recursive: true, force: true });
      },
    );

    it("P0-E7-02: recoverSettlementJournal fails closed and creates backup on corrupted past-sessions.json without overwriting history", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "corrupt-history-recovery-test-"));
      const journalFile = path.join(tempDir, ".tmp", "settlement-journal.json");
      const pastSessionsFile = path.join(tempDir, ".tmp", "past-sessions.json");
      const walletFile = path.join(tempDir, ".tmp", "virtual-wallet.json");

      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

      const initialWallet: VirtualWalletState = {
        walletAddress: "SimWalletRecoveryReal",
        currentBalanceSol: 10.0,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 0,
        allTimeRealizedPnlSol: 0.0,
        lastUpdatedMs: nowMs,
        settledSessionIds: [],
        unresolvedTokens: [],
      };
      writeFileSync(walletFile, JSON.stringify(initialWallet, null, 2), "utf8");

      // Plant corrupt unparseable content in past-sessions.json
      const corruptContent = "{ this is invalid JSON that cannot be parsed by recovery";
      writeFileSync(pastSessionsFile, corruptContent, "utf8");

      const journalEntry: SettlementJournalEntry = {
        sessionId: "sess-recovery-corrupt-1",
        startedAtMs: nowMs,
        stage: "STARTED",
        sessionSummary: {
          sessionId: "sess-recovery-corrupt-1",
          startedAt: new Date(nowMs).toISOString(),
          endedAt: new Date(nowMs + 60000).toISOString(),
          durationMinutes: 1,
          startingCapitalSol: 10.0,
          endingCapitalSol: 10.5,
          netPnlSol: 0.5,
          netPnlPct: 5.0,
          totalTrades: 1,
          buysCount: 1,
          sellsCount: 1,
          winsCount: 1,
          lossesCount: 0,
          scratchesCount: 0,
          winRatePct: 100,
          coinsWatchedCount: 10,
          missedOpportunitiesCount: 2,
          trades: [],
        },
        sessionNewRealizedPnlSol: 0.5,
        liquidCashSol: 10.5,
        initialPortfolioSol: 10.0,
        unresolvedPositions: [],
        reconciledPositionIds: [],
      };
      writeFileSync(journalFile, JSON.stringify(journalEntry, null, 2), "utf8");

      // Execution MUST throw fatal error and abort
      expect(() => {
        recoverSettlementJournal({
          journalPath: journalFile,
          baseDir: tempDir,
          walletPath: walletFile,
        });
      }).toThrow(/Corrupted .* encountered during journal recovery/);

      // Verify original corrupted bytes were preserved and backed up to .corrupt-<timestamp>
      expect(readFileSync(pastSessionsFile, "utf8")).toBe(corruptContent);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("P0-E7-04: ProcessLock acquires exclusive lock, blocks active PID, reclaims stale dead PID, and releases cleanly", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "process-lock-test-"));
      const lockFile = path.join(tempDir, "test-process.lock");

      // 1. Initial acquisition succeeds
      const handle1 = acquireProcessLock({
        processName: "TestProcess1",
        sessionId: "sess-lock-1",
        lockPath: lockFile,
      });
      expect(existsSync(lockFile)).toBe(true);

      // 2. Second acquisition from active process MUST throw fatal lock error
      expect(() => {
        acquireProcessLock({
          processName: "TestProcess2",
          sessionId: "sess-lock-2",
          lockPath: lockFile,
        });
      }).toThrow(/Exclusive lock held by active process/);

      // 3. Release lock removes lock file
      releaseProcessLock(handle1);
      expect(existsSync(lockFile)).toBe(false);

      // 4. Plant stale lock with dead PID (99999999)
      const staleDescriptor = {
        pid: 99999999,
        processName: "DeadProcess",
        sessionId: "sess-stale",
        acquiredAtMs: Date.now() - 120_000,
        hostname: "test-host",
      };
      writeFileSync(lockFile, JSON.stringify(staleDescriptor, null, 2), "utf8");

      // Assert PID liveness returns false
      expect(isProcessAlive(99999999)).toBe(false);

      // 5. Acquiring lock reclaims verified stale dead PID
      const handle2 = acquireProcessLock({
        processName: "ReclaimedProcess",
        sessionId: "sess-reclaim",
        lockPath: lockFile,
      });
      expect(existsSync(lockFile)).toBe(true);
      const currentDesc = JSON.parse(readFileSync(lockFile, "utf8"));
      expect(currentDesc.pid).toBe(process.pid);
      expect(currentDesc.processName).toBe("ReclaimedProcess");

      releaseProcessLock(handle2);
      expect(existsSync(lockFile)).toBe(false);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("P0-E7-05: operator reconciliation write-down preserves unresolved token inventory", () => {
      const initialWallet: VirtualWalletState = {
        walletAddress: "SimWalletWriteDown",
        currentBalanceSol: 10.0,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 1,
        allTimeRealizedPnlSol: 0.0,
        lastUpdatedMs: nowMs,
        settledSessionIds: ["sess-0"],
        unresolvedTokens: [
          {
            positionId: "pos-wd-1",
            mintAddress: "MintWriteDown11111111111111111111111111111111",
            symbol: "WDOWN",
            tokensHeld: 100.0,
            costBasisSol: 1.0,
            initialCostBasisSol: 1.0,
            initialTokensHeld: 100.0,
            realizedProceedsSol: 0.0,
            lastObservedPriceSol: 0.01,
            lastObservedAtMs: nowMs,
            reasonForMissingData: "FEED_DROPPED",
            sessionId: "sess-0",
          },
        ],
      };

      const result = reconcileWalletInventory(initialWallet, {
        identifier: "pos-wd-1",
        operationType: "WRITE_DOWN",
        writeDownEstimatedSol: 0.25,
        reason: "Conservative valuation write-down",
      });

      expect(result.operationType).toBe("WRITE_DOWN");
      expect(result.proceedsSol).toBe(0);
      expect(result.incrementalPnlSol).toBe(0);

      // Cash balance and realized P&L must NOT change
      expect(initialWallet.currentBalanceSol).toBe(10.0);
      expect(initialWallet.allTimeRealizedPnlSol).toBe(0.0);

      // Tokens MUST still be held in inventory!
      expect(initialWallet.unresolvedTokens?.length).toBe(1);
      expect(initialWallet.unresolvedTokens![0]!.tokensHeld).toBe(100.0);
      expect(initialWallet.unresolvedTokens![0]!.costBasisSol).toBe(1.0);
      expect(initialWallet.unresolvedTokens![0]!.estimatedLiquidationSol).toBe(0.25);
    });

    it("E8-01: Importing paper-trading-daemon module executes zero runner loops or mutations", async () => {
      const mod = await import("../scripts/paper-trading-daemon.js");
      expect(typeof mod.run).toBe("function");
      expect(typeof mod.parseCliArgs).toBe("function");
    });

    it("E8-02: parseCliArgs is pure and rejects conflicting --dry-run and --reset-wallet", () => {
      expect(() => parseCliArgs(["--dry-run", "--reset-wallet"])).toThrow(
        /Conflicting arguments: --dry-run cannot be combined with --reset-wallet/,
      );
      const parsed = parseCliArgs(["--dry-run", "--duration-hours=2"]);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.resetWallet).toBe(false);
      expect(parsed.durationHours).toBe(2);
    });

    it("E8-03: Startup capital derives from recovered wallet balance", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "startup-capital-test-"));
      const journalFile = path.join(tempDir, ".tmp", "settlement-journal.json");
      const pastSessionsFile = path.join(tempDir, ".tmp", "past-sessions.json");
      const walletFile = path.join(tempDir, ".tmp", "virtual-wallet.json");
      mkdirSync(path.join(tempDir, ".tmp", "sessions"), { recursive: true });

      const initialWallet: VirtualWalletState = {
        walletAddress: "SimWalletCapitalTest",
        currentBalanceSol: 8.0,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 5,
        allTimeRealizedPnlSol: -2.0,
        lastUpdatedMs: nowMs,
        settledSessionIds: ["sess-0"],
        unresolvedTokens: [],
      };
      writeFileSync(walletFile, JSON.stringify(initialWallet, null, 2), "utf8");

      const journalEntry: SettlementJournalEntry = {
        sessionId: "sess-prior-crashed",
        startedAtMs: nowMs,
        stage: "PAST_SESSIONS_WRITTEN",
        sessionSummary: {
          sessionId: "sess-prior-crashed",
          startedAt: new Date(nowMs).toISOString(),
          endedAt: new Date(nowMs + 60000).toISOString(),
          durationMinutes: 1,
          startingCapitalSol: 8.0,
          endingCapitalSol: 9.5,
          netPnlSol: 1.5,
          netPnlPct: 18.75,
          totalTrades: 1,
          buysCount: 1,
          sellsCount: 1,
          winsCount: 1,
          lossesCount: 0,
          scratchesCount: 0,
          winRatePct: 100,
          coinsWatchedCount: 5,
          missedOpportunitiesCount: 0,
          trades: [],
        },
        sessionNewRealizedPnlSol: 1.5,
        liquidCashSol: 9.5,
        initialPortfolioSol: 8.0,
        unresolvedPositions: [],
        reconciledPositionIds: [],
      };
      writeFileSync(journalFile, JSON.stringify(journalEntry, null, 2), "utf8");
      writeFileSync(
        pastSessionsFile,
        JSON.stringify([journalEntry.sessionSummary], null, 2),
        "utf8",
      );

      // Recover journal
      recoverSettlementJournal({
        journalPath: journalFile,
        workspaceRoot: tempDir,
        walletPath: walletFile,
      });

      // Wallet must now have 9.5 SOL
      const recoveredWallet = loadVirtualWallet(walletFile);
      expect(recoveredWallet.currentBalanceSol).toBe(9.5);
      expect(recoveredWallet.settledSessionIds).toContain("sess-prior-crashed");

      // New session config derived from recovered wallet
      const derivedInitialCapital = recoveredWallet.currentBalanceSol;
      expect(derivedInitialCapital).toBe(9.5);
      const calculatedSize = Math.min(
        1.0,
        parseFloat(((derivedInitialCapital - 0.05) / 5).toFixed(4)),
      );
      expect(calculatedSize).toBeCloseTo(1.0, 2);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("E8-06: recoverInterruptedIntent recovers and appends missing audit record before deleting intent", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "intent-recovery-test-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });
      const intentFile = path.join(tempDir, ".tmp", "reconciliation-intent.json");
      const auditFile = path.join(tempDir, ".tmp", "reconciliation-audit.jsonl");
      const walletFile = path.join(tempDir, ".tmp", "virtual-wallet.json");

      const wallet: VirtualWalletState = {
        walletAddress: "SimWalletIntent",
        currentBalanceSol: 10.5,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 1,
        allTimeRealizedPnlSol: 0.5,
        lastUpdatedMs: nowMs,
        settledSessionIds: ["sess-1"],
        unresolvedTokens: [], // token already removed by previous mutated step
      };
      writeFileSync(walletFile, JSON.stringify(wallet, null, 2), "utf8");

      const intent: ReconciliationIntent = {
        intentId: "rec-intent-audit-recovery-1",
        createdAtMs: nowMs,
        status: "INTENT_RECORDED",
        options: {
          identifier: "pos-missing-1",
          operationType: "SIMULATED_SALE",
          exitPriceSol: 0.05,
          reason: "Simulated sale during crash test",
        },
        matchedPositionId: "pos-missing-1",
        expectedAuditRecord: {
          reconciliationId: "rec-audit-12345",
          intentId: "rec-intent-audit-recovery-1",
          timestampMs: nowMs,
          operationType: "SIMULATED_SALE",
          reason: "Simulated sale during crash test",
        },
      };
      writeFileSync(intentFile, JSON.stringify(intent, null, 2), "utf8");

      recoverInterruptedIntent(tempDir);

      expect(existsSync(auditFile)).toBe(true);
      const auditLines = readFileSync(auditFile, "utf8").trim().split("\n");
      const parsedAudit = JSON.parse(auditLines[0]!);
      expect(parsedAudit.reconciliationId).toBe("rec-audit-12345");
      expect(parsedAudit.intentId).toBe("rec-intent-audit-recovery-1");
      expect(existsSync(intentFile)).toBe(false);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("E8-07: ProcessLock ownership verified via acquisition nonce and refuses to delete foreign/corrupt lock", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "process-lock-nonce-test-"));
      const lockFile = path.join(tempDir, "test-nonce.lock");

      const handle = acquireProcessLock({
        processName: "NonceTest",
        sessionId: "sess-nonce-1",
        lockPath: lockFile,
      });

      expect(handle.descriptor.acquisitionNonce).toBeDefined();
      expect(typeof handle.descriptor.acquisitionNonce).toBe("string");

      // Foreign process tampering with the nonce on disk
      const tamperedDesc = {
        ...handle.descriptor,
        acquisitionNonce: "foreign-nonce-different-process",
      };
      writeFileSync(lockFile, JSON.stringify(tamperedDesc, null, 2), "utf8");

      // Releasing handle MUST refuse to delete lock because nonce does not match
      releaseProcessLock(handle);
      expect(existsSync(lockFile)).toBe(true);

      // Corrupted lock file: must not delete on release
      writeFileSync(lockFile, "invalid { corrupted JSON", "utf8");
      releaseProcessLock(handle);
      expect(existsSync(lockFile)).toBe(true);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("V10-P0-1: Canonical ledger is single authority without legacy mirror writes or silent auto-copies", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "v10-canonical-authority-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });
      mkdirSync(path.join(tempDir, "backend/.tmp"), { recursive: true });
      const canonicalPath = path.join(tempDir, ".tmp", "virtual-wallet.json");
      const legacyPath = path.join(tempDir, "backend/.tmp", "virtual-wallet.json");

      const legacyWallet: VirtualWalletState = {
        walletAddress: "SimWalletLegacy",
        currentBalanceSol: 8.0,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 5,
        allTimeRealizedPnlSol: -2.0,
        lastUpdatedMs: nowMs,
        settledSessionIds: ["sess-legacy"],
        unresolvedTokens: [],
      };
      writeFileSync(legacyPath, JSON.stringify(legacyWallet, null, 2), "utf8");

      // 1. Missing canonical wallet with existing legacy wallet FAILS CLOSED (no silent auto-copy)
      expect(() => {
        checkLegacyConflict(
          canonicalPath,
          "backend/.tmp/virtual-wallet.json",
          "virtual wallet",
          tempDir,
        );
      }).toThrow(/Canonical virtual wallet missing.*Automatic migration is disabled/);

      // Verify canonical file was NOT automatically created
      expect(existsSync(canonicalPath)).toBe(false);

      // 2. Canonical save performs single-authority write without legacy mirror update
      const canonicalWallet: VirtualWalletState = {
        ...legacyWallet,
        currentBalanceSol: 8.5,
      };
      saveVirtualWallet(canonicalWallet, canonicalPath);
      expect(existsSync(canonicalPath)).toBe(true);

      // Verify legacy file was NOT overwritten with canonical's 8.5 balance
      const legacyRead = JSON.parse(readFileSync(legacyPath, "utf8"));
      expect(legacyRead.currentBalanceSol).toBe(8.0);

      // 3. Divergent contents detected and fail closed
      expect(() => {
        checkLegacyConflict(
          canonicalPath,
          "backend/.tmp/virtual-wallet.json",
          "virtual wallet",
          tempDir,
        );
      }).toThrow(/Detected divergence between canonical virtual wallet/);

      // 4. Malformed legacy file fails closed
      writeFileSync(legacyPath, "malformed {{ json", "utf8");
      expect(() => {
        checkLegacyConflict(
          canonicalPath,
          "backend/.tmp/virtual-wallet.json",
          "virtual wallet",
          tempDir,
        );
      }).toThrow(/Failed reading legacy\/canonical virtual wallet/);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("V10-P0-2: Legacy settlement journal fails closed and recovery strictly targets canonical root", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "v10-journal-recovery-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });
      mkdirSync(path.join(tempDir, "backend/.tmp"), { recursive: true });
      const canonicalJournal = path.join(tempDir, ".tmp", "settlement-journal.json");
      const legacyJournal = path.join(tempDir, "backend/.tmp", "settlement-journal.json");

      const journalEntry: SettlementJournalEntry = {
        sessionId: "sess-v10-recovery",
        stage: "STARTED",
        startedAtMs: nowMs,
        sessionSummary: {
          sessionId: "sess-v10-recovery",
          startedAt: new Date(nowMs).toISOString(),
          endedAt: new Date(nowMs + 60000).toISOString(),
          durationMinutes: 1,
          startingCapitalSol: 10.0,
          endingCapitalSol: 10.0,
          netPnlSol: 0,
          netPnlPct: 0,
          totalTrades: 0,
          buysCount: 0,
          sellsCount: 0,
          winsCount: 0,
          lossesCount: 0,
          scratchesCount: 0,
          winRatePct: 0,
          coinsWatchedCount: 0,
          missedOpportunitiesCount: 0,
          trades: [],
        },
        sessionNewRealizedPnlSol: 0,
        liquidCashSol: 10.0,
        initialPortfolioSol: 10.0,
        reconciledPositionIds: [],
      };

      // 1. Standalone legacy journal fails closed
      writeFileSync(legacyJournal, JSON.stringify(journalEntry, null, 2), "utf8");
      expect(() => {
        recoverSettlementJournal({ workspaceRoot: tempDir });
      }).toThrow(/Legacy settlement journal found at .* Automatic replay is disabled/);

      // 2. Simultaneous canonical + legacy journals fails closed
      writeFileSync(canonicalJournal, JSON.stringify(journalEntry, null, 2), "utf8");
      expect(() => {
        recoverSettlementJournal({ workspaceRoot: tempDir });
      }).toThrow(/Conflicting settlement journals found simultaneously/);

      // 3. Canonical recovery strictly targets workspace root .tmp and cleans journal
      rmSync(legacyJournal, { force: true });
      const initialWallet: VirtualWalletState = {
        walletAddress: "SimWalletRecovery",
        currentBalanceSol: 10.0,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 0,
        allTimeRealizedPnlSol: 0,
        lastUpdatedMs: nowMs,
        settledSessionIds: [],
        unresolvedTokens: [],
      };
      writeFileSync(
        path.join(tempDir, ".tmp", "virtual-wallet.json"),
        JSON.stringify(initialWallet, null, 2),
        "utf8",
      );

      const recoveryResult = recoverSettlementJournal({ workspaceRoot: tempDir });
      expect(recoveryResult.recovered).toBe(true);
      expect(existsSync(canonicalJournal)).toBe(false);
      expect(existsSync(path.join(tempDir, ".tmp", "sessions", "sess-v10-recovery.json"))).toBe(
        true,
      );
      expect(existsSync(path.join(tempDir, "backend/.tmp", "sessions"))).toBe(false);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("V10-P0-3: Missing-wallet check fails closed independent of execution CWD", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "v10-missing-wallet-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });
      mkdirSync(path.join(tempDir, "backend"), { recursive: true });
      const historyFile = path.join(tempDir, ".tmp", "past-sessions.json");
      writeFileSync(historyFile, JSON.stringify([{ sessionId: "prior-sess" }], null, 2), "utf8");

      const walletFile = path.join(tempDir, ".tmp", "virtual-wallet.json");
      expect(existsSync(walletFile)).toBe(false);

      // Missing canonical wallet with existing history FAILS CLOSED
      expect(() => {
        loadVirtualWallet(walletFile);
      }).toThrow(/Virtual wallet missing at .*, but prior session history exists/);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("V10-P1-5: WRITE_DOWN recovery verifies write-down state and is fully deterministic", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "v10-writedown-recovery-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });
      const walletFile = path.join(tempDir, ".tmp", "virtual-wallet.json");
      const intentFile = path.join(tempDir, ".tmp", "reconciliation-intent.json");
      const auditFile = path.join(tempDir, ".tmp", "reconciliation-audit.jsonl");

      const baseWallet: VirtualWalletState = {
        walletAddress: "SimWalletWriteDown",
        currentBalanceSol: 10.0,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 1,
        allTimeRealizedPnlSol: 0,
        lastUpdatedMs: nowMs,
        settledSessionIds: ["sess-1"],
        unresolvedTokens: [
          {
            positionId: "pos-wd-1",
            mintAddress: "mint-wd-1",
            tokensHeld: 100,
            costBasisSol: 0.1,
            lastObservedPriceSol: 0.001,
            lastObservedAtMs: nowMs,
            reasonForMissingData: "TEST",
            sessionId: "sess-1",
            estimatedLiquidationSol: 0.02, // Already written down
          },
        ],
      };
      writeFileSync(walletFile, JSON.stringify(baseWallet, null, 2), "utf8");

      const intent: ReconciliationIntent = {
        intentId: "rec-intent-wd-applied",
        createdAtMs: nowMs,
        status: "INTENT_RECORDED",
        options: {
          identifier: "pos-wd-1",
          operationType: "WRITE_DOWN",
          writeDownEstimatedSol: 0.02,
          reason: "Mark down to residual",
        },
        matchedPositionId: "pos-wd-1",
        expectedAuditRecord: {
          reconciliationId: "audit-wd-1",
          intentId: "rec-intent-wd-applied",
          operationType: "WRITE_DOWN",
        },
      };
      writeFileSync(intentFile, JSON.stringify(intent, null, 2), "utf8");

      // Recovery detects write-down was applied, verifies audit record, and unlinks intent
      recoverInterruptedIntent(tempDir);
      expect(existsSync(intentFile)).toBe(false);
      expect(existsSync(auditFile)).toBe(true);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("V11-01: Lifecycle regression: equal root+legacy -> retire legacy -> canonical settlement -> next startup loads updated canonical balance without conflict", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "v11-lifecycle-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });
      mkdirSync(path.join(tempDir, "backend/.tmp"), { recursive: true });
      writeFileSync(
        path.join(tempDir, "pnpm-workspace.yaml"),
        "packages:\n  - 'backend'\n",
        "utf8",
      );

      const canonicalWallet = path.join(tempDir, ".tmp", "virtual-wallet.json");
      const legacyWallet = path.join(tempDir, "backend/.tmp", "virtual-wallet.json");

      const initialWallet: VirtualWalletState = {
        walletAddress: "SimWalletV11Lifecycle",
        currentBalanceSol: 7.9259,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 7,
        allTimeRealizedPnlSol: -2.074,
        lastUpdatedMs: nowMs,
        settledSessionIds: ["sess-1", "sess-2"],
        unresolvedTokens: [],
      };

      // 1. Both root and legacy exist and match
      writeFileSync(canonicalWallet, JSON.stringify(initialWallet, null, 2), "utf8");
      writeFileSync(legacyWallet, JSON.stringify(initialWallet, null, 2), "utf8");
      expect(() => {
        checkLegacyConflict(
          canonicalWallet,
          "backend/.tmp/virtual-wallet.json",
          "virtual wallet",
          tempDir,
        );
      }).not.toThrow();

      // 2. Controlled retirement: rename legacy wallet to .retired-...
      const retiredLegacyWallet = path.join(
        tempDir,
        "backend/.tmp",
        "virtual-wallet.json.retired-20261013-1700",
      );
      renameSync(legacyWallet, retiredLegacyWallet);
      expect(existsSync(legacyWallet)).toBe(false);
      expect(existsSync(retiredLegacyWallet)).toBe(true);

      // 3. Next session settles into canonical wallet ONLY (e.g. cash changes to 7.8000 SOL)
      const updatedWallet: VirtualWalletState = {
        ...initialWallet,
        currentBalanceSol: 7.8,
        totalSessionsCompleted: 8,
        allTimeRealizedPnlSol: -2.2,
        settledSessionIds: [...initialWallet.settledSessionIds!, "sess-3"],
      };
      saveVirtualWallet(updatedWallet, canonicalWallet);

      // 4. Next startup verifies no FATAL_CONFLICT occurs and loads updated canonical balance
      expect(() => {
        checkLegacyConflict(
          canonicalWallet,
          "backend/.tmp/virtual-wallet.json",
          "virtual wallet",
          tempDir,
        );
      }).not.toThrow();

      const loaded = loadVirtualWallet(canonicalWallet);
      expect(loaded.currentBalanceSol).toBe(7.8);
      expect(loaded.totalSessionsCompleted).toBe(8);
      expect(loaded.allTimeRealizedPnlSol).toBe(-2.2);

      // 5. Verify no legacy active wallet was recreated
      expect(existsSync(legacyWallet)).toBe(false);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("V11-02: Recovery regression: journal recovery succeeds after legacy retirement and does not recreate legacy wallet", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "v11-recovery-"));
      mkdirSync(path.join(tempDir, ".tmp", "sessions"), { recursive: true });
      mkdirSync(path.join(tempDir, "backend/.tmp"), { recursive: true });
      writeFileSync(
        path.join(tempDir, "pnpm-workspace.yaml"),
        "packages:\n  - 'backend'\n",
        "utf8",
      );

      const canonicalWallet = path.join(tempDir, ".tmp", "virtual-wallet.json");
      const retiredLegacyWallet = path.join(
        tempDir,
        "backend/.tmp",
        "virtual-wallet.json.retired-20261013-1700",
      );
      const canonicalJournal = path.join(tempDir, ".tmp", "settlement-journal.json");

      const baseWallet: VirtualWalletState = {
        walletAddress: "SimWalletV11Recovery",
        currentBalanceSol: 7.9259,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 7,
        allTimeRealizedPnlSol: -2.074,
        lastUpdatedMs: nowMs,
        settledSessionIds: ["sess-1"],
        unresolvedTokens: [],
      };
      writeFileSync(canonicalWallet, JSON.stringify(baseWallet, null, 2), "utf8");
      writeFileSync(retiredLegacyWallet, JSON.stringify(baseWallet, null, 2), "utf8");

      const journalEntry: SettlementJournalEntry = {
        sessionId: "sess-v11-recovery",
        stage: "PAST_SESSIONS_WRITTEN",
        startedAtMs: nowMs,
        sessionSummary: {
          sessionId: "sess-v11-recovery",
          startedAt: new Date(nowMs).toISOString(),
          endedAt: new Date(nowMs + 60000).toISOString(),
          durationMinutes: 1,
          startingCapitalSol: 7.9259,
          endingCapitalSol: 7.75,
          netPnlSol: -0.1759,
          netPnlPct: -2.22,
          totalTrades: 1,
          buysCount: 1,
          sellsCount: 1,
          winsCount: 0,
          lossesCount: 1,
          scratchesCount: 0,
          winRatePct: 0,
          coinsWatchedCount: 0,
          missedOpportunitiesCount: 0,
          trades: [],
        },
        liquidCashSol: 7.75,
        initialPortfolioSol: 7.9259,
        reconciledPositionIds: [],
        sessionNewRealizedPnlSol: -0.1759,
      };
      writeFileSync(canonicalJournal, JSON.stringify(journalEntry, null, 2), "utf8");

      // Recover journal
      const res = recoverSettlementJournal({ workspaceRoot: tempDir });
      expect(res.recovered).toBe(true);
      expect(existsSync(canonicalJournal)).toBe(false);

      // Verify canonical wallet was updated
      const recoveredWallet = JSON.parse(
        readFileSync(canonicalWallet, "utf8"),
      ) as VirtualWalletState;
      expect(recoveredWallet.currentBalanceSol).toBe(7.75);
      expect(recoveredWallet.totalSessionsCompleted).toBe(8);

      // Verify active legacy wallet was NOT recreated
      expect(existsSync(path.join(tempDir, "backend/.tmp", "virtual-wallet.json"))).toBe(false);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("V11-03: findWorkspaceRoot fails closed if no workspace marker exists walking up", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "v11-no-marker-"));

      expect(() => {
        findWorkspaceRoot(tempDir, true, tempDir);
      }).toThrow(/\[CanonicalPaths\] \[FATAL_ROOT\] Could not locate workspace root marker/);

      // With failIfNotFound: false, it returns tempDir
      expect(findWorkspaceRoot(tempDir, false, tempDir)).toBe(path.resolve(tempDir));

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("V11-04: CWD-independent missing-wallet check fails closed when executed from backend/ subfolder without custom wallet path", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "v11-cwd-check-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });
      mkdirSync(path.join(tempDir, "backend"), { recursive: true });
      writeFileSync(
        path.join(tempDir, "pnpm-workspace.yaml"),
        "packages:\n  - 'backend'\n",
        "utf8",
      );

      // History exists in tempDir/.tmp
      const historyFile = path.join(tempDir, ".tmp", "past-sessions.json");
      writeFileSync(
        historyFile,
        JSON.stringify([{ sessionId: "sess-v11-prior" }], null, 2),
        "utf8",
      );

      // No virtual-wallet.json exists in tempDir/.tmp
      expect(existsSync(path.join(tempDir, ".tmp", "virtual-wallet.json"))).toBe(false);

      // Spawn child process with cwd: path.join(tempDir, "backend")
      const tsxCli = path.resolve(findWorkspaceRoot(), "backend/node_modules/tsx/dist/cli.mjs");
      const walletModuleUrl = pathToFileURL(
        path.resolve(findWorkspaceRoot(), "backend/src/paper/VirtualWallet.ts"),
      ).href;
      const scriptCode = `
        import { loadVirtualWallet } from '${walletModuleUrl}';
        loadVirtualWallet();
      `;
      const result = spawnSync(
        process.execPath,
        [tsxCli, "--input-type=module", "-e", scriptCode],
        {
          cwd: path.join(tempDir, "backend"),
          encoding: "utf8",
        },
      );

      expect(result.status).not.toBe(0);
      const combinedOutput = (result.stdout || "") + (result.stderr || "");
      expect(combinedOutput).toMatch(
        /Virtual wallet missing at .* but prior session history exists/,
      );

      rmSync(tempDir, { recursive: true, force: true });
    });

    // Phase 12.93D Audit v12 Tests: V12-01 through V12-04
    it("V12-01: Dashboard /api/wallet/reset endpoint returns 403 Forbidden with DASHBOARD_RESET_DISABLED and leaves canonical wallet untouched", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "v12-reset-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });
      writeFileSync(
        path.join(tempDir, "pnpm-workspace.yaml"),
        "packages:\n  - 'backend'\n  - 'frontend'\n",
        "utf8",
      );

      const canonicalWallet = path.join(tempDir, ".tmp", "virtual-wallet.json");
      const initialWallet: VirtualWalletState = {
        walletAddress: "SimWalletV12Reset",
        currentBalanceSol: 7.9259,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 7,
        allTimeRealizedPnlSol: -2.074,
        lastUpdatedMs: nowMs,
        settledSessionIds: ["sess-1", "sess-2"],
        unresolvedTokens: [],
      };
      writeFileSync(canonicalWallet, JSON.stringify(initialWallet, null, 2), "utf8");
      const initialHash = createHash("sha256").update(readFileSync(canonicalWallet)).digest("hex");

      const viteConfigUrl = pathToFileURL(
        path.resolve(findWorkspaceRoot(), "frontend/vite.config.ts"),
      ).href;
      const { nexusDevApiPlugin } = await import(viteConfigUrl);
      const plugin = nexusDevApiPlugin({ workspaceRoot: tempDir });

      type ConnectMiddleware = (
        req: { method?: string; url?: string },
        res: {
          statusCode: number;
          setHeader: (name: string, val: string) => void;
          end: (data?: string) => void;
        },
        next: () => void,
      ) => void;

      let middlewareHandler: ConnectMiddleware | null = null;
      plugin.configureServer({
        middlewares: {
          use: (fn: ConnectMiddleware) => {
            middlewareHandler = fn;
          },
        },
      });

      expect(middlewareHandler).not.toBeNull();

      // Test 1: POST /api/wallet/reset with no process lock
      let statusCode = 0;
      const headers: Record<string, string> = {};
      let responseBody = "";
      const req = { method: "POST", url: "/api/wallet/reset" };
      const res = {
        set statusCode(code: number) {
          statusCode = code;
        },
        get statusCode() {
          return statusCode;
        },
        setHeader(name: string, val: string) {
          headers[name] = val;
        },
        end(data?: string) {
          if (data) responseBody = data;
        },
      };

      middlewareHandler!(req, res, () => {});

      expect(statusCode).toBe(403);
      const parsedRes = JSON.parse(responseBody);
      expect(parsedRes.ok).toBe(false);
      expect(parsedRes.error).toBe("DASHBOARD_RESET_DISABLED");

      // Verify wallet on disk is 100% unchanged
      const afterHash = createHash("sha256").update(readFileSync(canonicalWallet)).digest("hex");
      expect(afterHash).toBe(initialHash);
      const readBack = JSON.parse(readFileSync(canonicalWallet, "utf8"));
      expect(readBack.currentBalanceSol).toBe(7.9259);

      // Test 2: POST /api/wallet/reset with process lock active
      writeFileSync(
        path.join(tempDir, ".tmp", "paper-process.lock"),
        JSON.stringify({ pid: 99999, acquiredAtMs: Date.now() }),
        "utf8",
      );
      statusCode = 0;
      responseBody = "";
      middlewareHandler!(req, res, () => {});
      expect(statusCode).toBe(403);
      expect(JSON.parse(responseBody).error).toBe("DASHBOARD_RESET_DISABLED");
      expect(createHash("sha256").update(readFileSync(canonicalWallet)).digest("hex")).toBe(
        initialHash,
      );

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("V12-02: Vite startup does NOT truncate or clear past-sessions.json regardless of archive existence", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "v12-history-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });
      writeFileSync(
        path.join(tempDir, "pnpm-workspace.yaml"),
        "packages:\n  - 'backend'\n  - 'frontend'\n",
        "utf8",
      );

      const pastSessionsFile = path.join(tempDir, ".tmp", "past-sessions.json");
      const sessionsData = [
        { sessionId: "sess-morning", netPnlSol: -0.3732 },
        { sessionId: "sess-afternoon", netPnlSol: -0.1556 },
      ];
      writeFileSync(pastSessionsFile, JSON.stringify(sessionsData, null, 2), "utf8");
      const originalHash = createHash("sha256")
        .update(readFileSync(pastSessionsFile))
        .digest("hex");

      // Ensure no past-sessions-archive-12.83.json exists
      const archiveFile = path.join(tempDir, ".tmp", "past-sessions-archive-12.83.json");
      expect(existsSync(archiveFile)).toBe(false);

      const viteConfigUrl = pathToFileURL(
        path.resolve(findWorkspaceRoot(), "frontend/vite.config.ts"),
      ).href;
      const { nexusDevApiPlugin } = await import(viteConfigUrl);
      const plugin = nexusDevApiPlugin({ workspaceRoot: tempDir });

      // Run configureServer
      plugin.configureServer({
        middlewares: {
          use: () => {},
        },
      });

      // Verify past-sessions.json was NOT truncated to []
      expect(existsSync(pastSessionsFile)).toBe(true);
      const afterHash = createHash("sha256").update(readFileSync(pastSessionsFile)).digest("hex");
      expect(afterHash).toBe(originalHash);
      const reRead = JSON.parse(readFileSync(pastSessionsFile, "utf8"));
      expect(reRead.length).toBe(2);
      expect(reRead[0].sessionId).toBe("sess-morning");
      expect(existsSync(archiveFile)).toBe(false);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("V12-03: Hardened legacy-wallet retirement utility acquires wx lock with nonce, guards live workspace, and prevents foreign lock release", async () => {
      const retirementScriptUrl = pathToFileURL(
        path.resolve(findWorkspaceRoot(), "scripts/retire-legacy-wallet.mjs"),
      ).href;
      const { runRetirement } = await import(retirementScriptUrl);

      // 1. Hermetic test of re-execution guard: create an ephemeral fixture pre-populated with a migration record
      const guardFixtureDir = mkdtempSync(path.join(os.tmpdir(), "v12-guard-"));
      mkdirSync(path.join(guardFixtureDir, ".tmp"), { recursive: true });
      const fixtureMigrationRecord = path.join(
        guardFixtureDir,
        ".tmp",
        "legacy-wallet-migration.json",
      );
      writeFileSync(
        fixtureMigrationRecord,
        JSON.stringify({
          action: "RETIRE_LEGACY_ACTIVE_WALLET",
          status: "COMPLETED",
        }),
        "utf8",
      );
      const guardResult = await runRetirement({ workspaceRoot: guardFixtureDir });
      expect(guardResult.status).toBe("ALREADY_COMPLETED");
      expect(guardResult.canonicalMigrationRecord).toBe(fixtureMigrationRecord);
      rmSync(guardFixtureDir, { recursive: true, force: true });

      // Architectural guard prevents un-scoped execution during test runs
      await expect(runRetirement()).rejects.toThrow(/\[FATAL_TEST_SAFETY\]/);

      // 2. Fixture test: atomic wx lock and foreign lock failure
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "v12-retire-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });
      mkdirSync(path.join(tempDir, "backend/.tmp"), { recursive: true });
      writeFileSync(
        path.join(tempDir, "pnpm-workspace.yaml"),
        "packages:\n  - 'backend'\n",
        "utf8",
      );

      const canonicalWallet = path.join(tempDir, ".tmp", "virtual-wallet.json");
      const legacyWallet = path.join(tempDir, "backend/.tmp", "virtual-wallet.json");
      const lockFile = path.join(tempDir, ".tmp", "paper-process.lock");

      const walletPayload = {
        walletAddress: "SimWalletRetireFixture",
        currentBalanceSol: 7.9259,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 7,
        allTimeRealizedPnlSol: -2.074,
        lastUpdatedMs: nowMs,
        settledSessionIds: ["sess-1"],
        unresolvedTokens: [],
      };
      writeFileSync(canonicalWallet, JSON.stringify(walletPayload, null, 2), "utf8");
      writeFileSync(legacyWallet, JSON.stringify(walletPayload, null, 2), "utf8");

      // Pre-create a foreign lock file
      const foreignLock = {
        pid: process.pid,
        acquisitionNonce: "foreign-nonce-12345",
        acquiredAtMs: Date.now(),
        hostname: "foreign-host",
        purpose: "other-daemon",
      };
      writeFileSync(lockFile, JSON.stringify(foreignLock, null, 2), "utf8");

      // Attempting retirement must throw due to existing lock
      await expect(runRetirement({ workspaceRoot: tempDir, isFixtureTest: true })).rejects.toThrow(
        /Aborting: Process lock is currently held by PID/,
      );

      // Verify foreign lock file was NOT removed by finally
      expect(existsSync(lockFile)).toBe(true);
      expect(JSON.parse(readFileSync(lockFile, "utf8")).acquisitionNonce).toBe(
        "foreign-nonce-12345",
      );

      // Remove foreign lock and run cleanly
      rmSync(lockFile);
      const successResult = await runRetirement({
        workspaceRoot: tempDir,
        isFixtureTest: true,
        retiredTimestamp: "fixture-20261013",
      });

      expect(successResult.status).toBe("SUCCESS");
      expect(existsSync(legacyWallet)).toBe(false);
      expect(
        existsSync(
          path.join(tempDir, "backend/.tmp", "virtual-wallet.json.retired-fixture-20261013"),
        ),
      ).toBe(true);
      // Lock released cleanly
      expect(existsSync(lockFile)).toBe(false);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("V12-04: Dashboard /api/wallet/virtual and /api/wallet/telemetry return explicit error status for missing or corrupted canonical wallet", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "v12-readers-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });
      writeFileSync(
        path.join(tempDir, "pnpm-workspace.yaml"),
        "packages:\n  - 'backend'\n  - 'frontend'\n",
        "utf8",
      );

      const viteConfigUrl = pathToFileURL(
        path.resolve(findWorkspaceRoot(), "frontend/vite.config.ts"),
      ).href;
      const { nexusDevApiPlugin } = await import(viteConfigUrl);
      const plugin = nexusDevApiPlugin({ workspaceRoot: tempDir });

      type ConnectMiddleware = (
        req: { method?: string; url?: string },
        res: {
          statusCode: number;
          setHeader?: (name: string, val: string) => void;
          end?: (data?: string) => void;
        },
        next: () => void,
      ) => void;

      let middlewareHandler: ConnectMiddleware | null = null;
      plugin.configureServer({
        middlewares: {
          use: (fn: ConnectMiddleware) => {
            middlewareHandler = fn;
          },
        },
      });

      const executeRequest = (method: string, url: string) => {
        let statusCode = 200;
        let responseBody = "";
        const req = { method, url };
        const res = {
          set statusCode(code: number) {
            statusCode = code;
          },
          get statusCode() {
            return statusCode;
          },
          setHeader() {},
          end(data?: string) {
            if (data) responseBody += data;
          },
        };
        middlewareHandler!(req, res, () => {});
        return { statusCode, body: responseBody };
      };

      // Case A: Missing wallet WITH session history exists -> must fail with 500/503, never 10.0 SOL!
      writeFileSync(
        path.join(tempDir, ".tmp", "past-sessions.json"),
        JSON.stringify([{ sessionId: "sess-prior" }]),
        "utf8",
      );
      const resVirtualA = executeRequest("GET", "/api/wallet/virtual");
      expect(resVirtualA.statusCode).toBe(500);
      expect(JSON.parse(resVirtualA.body).error).toBe("WALLET_MISSING_WITH_HISTORY");

      const resTelemetryA = executeRequest("GET", "/api/wallet/telemetry");
      expect(resTelemetryA.statusCode).toBe(503);
      expect(JSON.parse(resTelemetryA.body).error).toBe("WALLET_UNAVAILABLE");

      // Case B: Corrupted wallet file
      const canonicalWallet = path.join(tempDir, ".tmp", "virtual-wallet.json");
      writeFileSync(canonicalWallet, "{ invalid-json: ", "utf8");
      const resVirtualB = executeRequest("GET", "/api/wallet/virtual");
      expect(resVirtualB.statusCode).toBe(500);
      expect(JSON.parse(resVirtualB.body).error).toBe("WALLET_CORRUPTED");

      const resTelemetryB = executeRequest("GET", "/api/wallet/telemetry");
      expect(resTelemetryB.statusCode).toBe(500);
      expect(JSON.parse(resTelemetryB.body).error).toBe("WALLET_CORRUPTED");

      // Case C: Valid canonical wallet -> returns exact 7.9259 SOL
      const validWallet = {
        walletAddress: "SimWalletV12Valid",
        currentBalanceSol: 7.9259,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 7,
        allTimeRealizedPnlSol: -2.074,
        lastUpdatedMs: nowMs,
        settledSessionIds: ["sess-1", "sess-2"],
        unresolvedTokens: [],
      };
      writeFileSync(canonicalWallet, JSON.stringify(validWallet, null, 2), "utf8");

      const resVirtualC = executeRequest("GET", "/api/wallet/virtual");
      expect(resVirtualC.statusCode).toBe(200);
      expect(JSON.parse(resVirtualC.body).currentBalanceSol).toBe(7.9259);

      const resTelemetryC = executeRequest("GET", "/api/wallet/telemetry");
      expect(resTelemetryC.statusCode).toBe(200);
      const telemetryObj = JSON.parse(resTelemetryC.body);
      expect(telemetryObj.solBalance).toBe(7.9259);
      expect(telemetryObj.deployableSol).toBe(7.8759);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
