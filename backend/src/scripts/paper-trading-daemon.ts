import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

// Automatically load .env file from workspace root or cwd if available
try {
  const rootEnv = path.resolve(process.cwd(), ".env");
  const parentEnv = path.resolve(process.cwd(), "..", ".env");
  if (existsSync(rootEnv)) {
    process.loadEnvFile(rootEnv);
  } else if (existsSync(parentEnv)) {
    process.loadEnvFile(parentEnv);
  }
} catch {
  // Ignore if already loaded or unavailable
}
import { PaperTradingDaemon, type PaperTradingDaemonConfig } from "../paper/PaperTradingDaemon.js";
import { CandidateStreamEngine } from "../candidate-scanner/CandidateStreamEngine.js";
import { CANDIDATE_SCANNER_DEFAULTS } from "../candidate-scanner/CandidateScannerConfig.js";
import { CandidateWatchlistService } from "../candidate-scanner/CandidateWatchlistService.js";
import {
  BuyGateTriggerService,
  type ArmedPullbackState,
} from "../candidate-scanner/BuyGateTriggerService.js";
import { CounterfactualOpportunityTracker } from "../candidate-scanner/CounterfactualOpportunityTracker.js";
import type { ScannedPoolRecord } from "../candidate-scanner/CandidateScannerTypes.js";
import {
  type MarketEvaluationContext,
  type CohortTier,
  MICRO_CAP_DYNAMIC_RATCHET_CONFIG,
  ESTABLISHED_DYNAMIC_RATCHET_CONFIG,
} from "../exits/DynamicRatchetTypes.js";
import { nowMs } from "../db/utils/timestamps.js";
import { BACKFILLED_PAST_SESSIONS, type HistoricalSessionSummary } from "@nexustrade/shared";
import { BirdeyeDiscoveryService } from "../discovery/BirdeyeDiscoveryService.js";
import { BirdeyeBudgetTracker } from "../services/BirdeyeBudgetTracker.js";

interface VirtualWalletState {
  walletAddress: string;
  currentBalanceSol: number;
  initialBalanceSol: number;
  totalSessionsCompleted: number;
  allTimeRealizedPnlSol: number;
  lastUpdatedMs: number;
}

const DEFAULT_VIRTUAL_WALLET: VirtualWalletState = {
  walletAddress: "SimulatedVirtualWallet111111111111111111111111",
  currentBalanceSol: 10.0,
  initialBalanceSol: 10.0,
  totalSessionsCompleted: 0,
  allTimeRealizedPnlSol: 0.0,
  lastUpdatedMs: Date.now(),
};

function resolveVirtualWalletFile(): string {
  const candidates = [
    path.resolve(process.cwd(), ".tmp/virtual-wallet.json"),
    path.resolve(process.cwd(), "backend/.tmp/virtual-wallet.json"),
    path.resolve(process.cwd(), "../.tmp/virtual-wallet.json"),
    path.resolve(process.cwd(), "../backend/.tmp/virtual-wallet.json"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  if (existsSync(path.resolve(process.cwd(), "backend/.tmp"))) {
    return path.resolve(process.cwd(), "backend/.tmp/virtual-wallet.json");
  }
  return path.resolve(process.cwd(), ".tmp/virtual-wallet.json");
}

function loadVirtualWallet(): VirtualWalletState {
  const filePath = resolveVirtualWalletFile();
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.currentBalanceSol === "number" &&
        !Number.isNaN(parsed.currentBalanceSol)
      ) {
        return {
          walletAddress: parsed.walletAddress || DEFAULT_VIRTUAL_WALLET.walletAddress,
          currentBalanceSol: parsed.currentBalanceSol,
          initialBalanceSol: parsed.initialBalanceSol ?? 10.0,
          totalSessionsCompleted: parsed.totalSessionsCompleted ?? 0,
          allTimeRealizedPnlSol: parsed.allTimeRealizedPnlSol ?? 0.0,
          lastUpdatedMs: parsed.lastUpdatedMs ?? Date.now(),
        };
      }
    } catch {
      // Fallback
    }
  }
  return { ...DEFAULT_VIRTUAL_WALLET, lastUpdatedMs: Date.now() };
}

function saveVirtualWallet(wallet: VirtualWalletState): void {
  const targetDirs = [
    path.resolve(process.cwd(), ".tmp"),
    path.resolve(process.cwd(), "backend/.tmp"),
    path.resolve(process.cwd(), "../.tmp"),
    path.resolve(process.cwd(), "../backend/.tmp"),
  ];
  let written = false;
  for (const dir of targetDirs) {
    if (existsSync(dir)) {
      try {
        writeFileSync(
          path.join(dir, "virtual-wallet.json"),
          JSON.stringify(wallet, null, 2),
          "utf8",
        );
        written = true;
      } catch {
        // Ignore
      }
    }
  }
  if (!written) {
    const defaultDir = path.resolve(process.cwd(), ".tmp");
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(
      path.join(defaultDir, "virtual-wallet.json"),
      JSON.stringify(wallet, null, 2),
      "utf8",
    );
  }
}

function parseCliArgs(): PaperTradingDaemonConfig {
  const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      "session-id": { type: "string" },
      "duration-hours": { type: "string" },
      "max-positions": { type: "string" },
      "max-open-positions": { type: "string" },
      "position-size-sol": { type: "string" },
      "max-drawdown-bps": { type: "string" },
      "cooldown-min": { type: "string" },
      "uninterrupted-research": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "initial-sol": { type: "string" },
    },
    strict: false,
  });

  const rawDuration = values["duration-hours"];
  const durationHours = typeof rawDuration === "string" ? parseFloat(rawDuration) : 4;

  const rawMaxPos = values["max-positions"] ?? values["max-open-positions"];
  const maxOpenPositions =
    typeof rawMaxPos === "string" ? Math.min(10, Math.max(1, parseInt(rawMaxPos, 10))) : 5;

  const rawInitial = values["initial-sol"];
  let initialPortfolioSol = 10.0;
  if (typeof rawInitial === "string" && !Number.isNaN(parseFloat(rawInitial))) {
    initialPortfolioSol = parseFloat(rawInitial);
  } else {
    const vWallet = loadVirtualWallet();
    initialPortfolioSol = vWallet.currentBalanceSol;
  }

  const gasReserveSol = 0.05;
  const calculatedBalancedSize = Math.min(
    1.0,
    parseFloat(((initialPortfolioSol - gasReserveSol) / maxOpenPositions).toFixed(4)),
  );

  const rawSize = values["position-size-sol"];
  const positionSizeSol =
    typeof rawSize === "string" ? parseFloat(rawSize) : calculatedBalancedSize;

  const rawDrawdown = values["max-drawdown-bps"];
  const maxPortfolioDrawdownBps =
    typeof rawDrawdown === "string" ? parseInt(rawDrawdown, 10) : -500; // -5.0%

  const rawCooldown = values["cooldown-min"];
  const cooldownMin = typeof rawCooldown === "string" ? parseFloat(rawCooldown) : 30;
  const antiRebuyCooldownMs = cooldownMin * 60 * 1000;

  const uninterruptedResearchMode = values["uninterrupted-research"] === true;
  const dryRun = values["dry-run"] === true;

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T.]/g, "")
    .slice(0, 14);
  const rawSessionId = values["session-id"];
  const sessionId = typeof rawSessionId === "string" ? rawSessionId : `session-paper-${timestamp}`;

  return {
    sessionId,
    durationHours,
    maxOpenPositions,
    positionSizeSol,
    initialPortfolioSol,
    maxPortfolioDrawdownBps,
    maxConsecutiveErrors: 3,
    maxClockDriftMs: 5000,
    pollIntervalMs: 2000,
    dryRun,
    antiRebuyCooldownMs,
    uninterruptedResearchMode,
  };
}

interface DexScreenerSpotInfo {
  readonly spotPriceSol: number;
  readonly spotPriceUsd: number;
  readonly liquiditySol: number;
  readonly buyVolume5mSol: number;
  readonly sellVolume5mSol: number;
  readonly recentBuys60s: number;
  readonly recentSells60s: number;
  readonly recentTransactionsCount: number;
  readonly momentum5mBps: number;
  readonly priceChange1hPct: number;
}

async function fetchDexScreenerSpotInfo(mintAddress: string): Promise<DexScreenerSpotInfo | null> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mintAddress)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      pairs?: Array<{
        quoteToken?: { symbol?: string; address?: string };
        priceNative?: string;
        priceUsd?: string;
        liquidity?: { usd?: number; quote?: number };
        volume?: { m5?: number };
        txns?: { m5?: { buys?: number; sells?: number } };
        priceChange?: { m5?: number; h1?: number };
      }>;
    };
    const pairs = body.pairs ?? [];
    if (pairs.length === 0) return null;

    const WSOL_MINT = "So11111111111111111111111111111111111111112";
    const validSolPairs = pairs.filter((p) => {
      const quoteAddr = p.quoteToken?.address;
      const quoteSym = p.quoteToken?.symbol?.toUpperCase();
      return quoteAddr === WSOL_MINT || quoteSym === "SOL" || quoteSym === "WSOL";
    });

    if (validSolPairs.length === 0) return null;

    // Sort by highest USD liquidity to guarantee canonical pool
    validSolPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const solPair = validSolPairs[0];
    if (!solPair?.priceNative) return null;

    const spotPriceSol = parseFloat(solPair.priceNative);
    if (!Number.isFinite(spotPriceSol) || spotPriceSol <= 0) return null;

    const spotPriceUsd = solPair.priceUsd ? parseFloat(solPair.priceUsd) : 0;
    const liquiditySol =
      solPair.liquidity?.quote ?? (solPair.liquidity?.usd ? solPair.liquidity.usd / 140 : 100);
    const m5Vol = solPair.volume?.m5 ?? 0;
    const buyVolSol = (m5Vol / 140) * 0.6;
    const sellVolSol = (m5Vol / 140) * 0.4;
    const buys5m = solPair.txns?.m5?.buys ?? 15;
    const sells5m = solPair.txns?.m5?.sells ?? 10;
    const recentBuys60s = Math.max(1, Math.round(buys5m / 5));
    const recentSells60s = Math.max(1, Math.round(sells5m / 5));
    const momentum5mBps = solPair.priceChange?.m5 ? Math.round(solPair.priceChange.m5 * 100) : 0;
    const priceChange1hPct =
      solPair.priceChange?.h1 !== undefined && Number.isFinite(solPair.priceChange.h1)
        ? solPair.priceChange.h1
        : 0;

    return {
      spotPriceSol,
      spotPriceUsd,
      liquiditySol,
      buyVolume5mSol: buyVolSol,
      sellVolume5mSol: sellVolSol,
      recentBuys60s,
      recentSells60s,
      recentTransactionsCount: buys5m + sells5m,
      momentum5mBps,
      priceChange1hPct,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function run(): Promise<void> {
  const config = parseCliArgs();
  console.log(`[PaperDaemon] Starting Paper Trading Daemon Session: ${config.sessionId}`);
  console.log(
    `[PaperDaemon] Config: Duration=${config.durationHours}h, MaxPositions=${config.maxOpenPositions}, Size=${config.positionSizeSol} SOL`,
  );
  console.log(
    `[PaperDaemon] Protective Guardrails: MaxDrawdown=${config.maxPortfolioDrawdownBps} bps, AntiRebuyCooldown=${((config.antiRebuyCooldownMs ?? 0) / 60000).toFixed(0)}m, UninterruptedResearch=${config.uninterruptedResearchMode ? "ENABLED" : "DISABLED"}`,
  );

  const daemon = new PaperTradingDaemon({ config });
  daemon.start();

  const streamEngine = new CandidateStreamEngine({
    config: config.scannerConfig ?? CANDIDATE_SCANNER_DEFAULTS,
  });

  const watchlistService = new CandidateWatchlistService({
    maxWatchlistSize: 25,
    minLiquidityUsd: 2500,
    minLpBurnPct: 90.0,
    minTxCount5m: 10,
    maxWatchlistAgeSec: 1200,
  });

  const buyGateService = new BuyGateTriggerService();
  const tracker = new CounterfactualOpportunityTracker();

  const birdeyeBudgetTracker = new BirdeyeBudgetTracker();
  const birdeyeDiscovery = new BirdeyeDiscoveryService({
    budgetTracker: birdeyeBudgetTracker,
  });

  try {
    const probeResult = await birdeyeDiscovery.probeSmartMoney();
    if (probeResult.supported) {
      console.log("[PaperDaemon] Birdeye Smart Money endpoint verified and enabled.");
    } else {
      console.log(
        `[PaperDaemon] Birdeye Smart Money endpoint disabled (HTTP ${probeResult.status}). Using Trending & DEX discovery.`,
      );
    }
  } catch (probeErr) {
    console.warn("[PaperDaemon] Failed to probe Smart Money:", probeErr);
  }

  interface ActivityLogRecord {
    timestamp: number;
    type: "INFO" | "BUY" | "SELL" | "RATCHET" | "ALERT" | "CONTROL";
    message: string;
    symbol?: string;
    mintAddress?: string;
  }
  const activityLogs: ActivityLogRecord[] = [];
  const addActivityLog = (
    type: "INFO" | "BUY" | "SELL" | "RATCHET" | "ALERT" | "CONTROL",
    message: string,
    mintAddress?: string,
    symbol?: string,
  ) => {
    activityLogs.unshift({
      timestamp: nowMs(),
      type,
      message,
      ...(symbol ? { symbol } : {}),
      ...(mintAddress ? { mintAddress } : {}),
    });
    if (activityLogs.length > 50) {
      activityLogs.pop();
    }
  };

  const startMs = nowMs();
  const maxDurationMs = config.durationHours * 3600 * 1000;
  let lastScanMs = 0;
  let lastWatchlistRefreshMs = 0;
  let lastHeartbeatMs = 0;
  let lastPersistMs = 0;
  let lastRadarSampleMs = 0;
  const scanIntervalMs = 5000;
  const SESSION_START_WARMUP_MS = 60_000;
  const armedPullbackCandidates = new Map<string, ArmedPullbackState>();

  const persistState = () => {
    const snap = daemon.getSnapshot();
    const fullState = {
      ...snap,
      durationHours: config.durationHours,
      lastTickAtMs: nowMs(),
      watchlist: watchlistService.getItems(),
      recentActivityLogs: activityLogs,
    };
    try {
      if (!existsSync(".tmp")) mkdirSync(".tmp", { recursive: true });
      writeFileSync(".tmp/paper-session-active.json", JSON.stringify(fullState, null, 2), "utf8");
      tracker.saveReportToFile(
        ".tmp/session-paper-observation-report.json",
        config.initialPortfolioSol,
        snap.currentPortfolioSol,
      );
    } catch (err) {
      void err;
    }
  };

  let archived = false;
  const archiveSession = () => {
    if (archived) return;
    archived = true;
    try {
      if (!existsSync(".tmp/sessions")) mkdirSync(".tmp/sessions", { recursive: true });
      const report = tracker.generateReport(
        config.initialPortfolioSol,
        daemon.getSnapshot().currentPortfolioSol,
      );
      const summary = daemon.getHistoricalSummary({
        coinsWatchedCount: report.totalCandidatesObserved,
        missedOpportunitiesCount: report.missedWinnersCount,
      });

      // 1. Write individual session JSON
      writeFileSync(
        `.tmp/sessions/${config.sessionId}.json`,
        JSON.stringify(summary, null, 2),
        "utf8",
      );

      // 2. Read, update, and write past-sessions.json
      let pastSessions: HistoricalSessionSummary[] = [];
      const pastSessionsPath = existsSync(".tmp/past-sessions.json")
        ? ".tmp/past-sessions.json"
        : existsSync("backend/.tmp/past-sessions.json")
          ? "backend/.tmp/past-sessions.json"
          : ".tmp/past-sessions.json";
      if (existsSync(pastSessionsPath)) {
        try {
          const raw = readFileSync(pastSessionsPath, "utf8");
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            pastSessions = parsed;
          }
        } catch {
          pastSessions = [...BACKFILLED_PAST_SESSIONS];
        }
      } else {
        pastSessions = [...BACKFILLED_PAST_SESSIONS];
      }

      const existingIdx = pastSessions.findIndex((s) => s.sessionId === summary.sessionId);
      if (existingIdx >= 0) {
        pastSessions[existingIdx] = summary;
      } else {
        pastSessions = [summary, ...pastSessions];
      }

      writeFileSync(pastSessionsPath, JSON.stringify(pastSessions, null, 2), "utf8");
      console.log(
        `[PaperDaemon] Archived session summary to .tmp/sessions/${config.sessionId}.json and updated ${pastSessionsPath}`,
      );

      // 3. Update Continuous Virtual Wallet
      const snap = daemon.getSnapshot();
      const currentSol = snap.currentPortfolioSol;
      const netSessionPnlSol = currentSol - config.initialPortfolioSol;
      const wallet = loadVirtualWallet();
      wallet.currentBalanceSol = currentSol;
      wallet.allTimeRealizedPnlSol += netSessionPnlSol;
      wallet.totalSessionsCompleted += 1;
      wallet.lastUpdatedMs = nowMs();
      saveVirtualWallet(wallet);
      console.log(
        `[PaperDaemon] Updated Continuous Virtual Wallet: Balance=${wallet.currentBalanceSol.toFixed(4)} SOL | All-Time PnL=${wallet.allTimeRealizedPnlSol >= 0 ? "+" : ""}${wallet.allTimeRealizedPnlSol.toFixed(4)} SOL | Sessions=${wallet.totalSessionsCompleted}`,
      );
    } catch (archiveErr) {
      console.error("[PaperDaemon] Failed to archive session summary:", archiveErr);
    }
  };

  // Graceful shutdown handlers
  let terminating = false;
  const handleShutdown = () => {
    if (terminating) return;
    terminating = true;
    console.log("\n[PaperDaemon] Termination signal received. Stopping daemon...");
    daemon.stop("MANUAL_STOP");
    const snap = daemon.getSnapshot();
    console.log(
      `[PaperDaemon] Final Equity: ${snap.currentPortfolioSol.toFixed(4)} SOL | Closed Trades: ${snap.closedTrades.length}`,
    );
    persistState();
    archiveSession();
    const report = tracker.generateReport(config.initialPortfolioSol, snap.currentPortfolioSol);
    console.log(
      `[PaperDaemon] Counterfactual Summary: Observed=${report.totalCandidatesObserved}, Executed=${report.executedBuysCount}, MissedWinners=${report.missedWinnersCount}, AvoidedRugs=${report.avoidedRugsCount}`,
    );
    process.exit(0);
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  // In daemon mode, tick and monitor until duration elapsed
  while (!terminating) {
    const currentNow = nowMs();
    const elapsed = currentNow - startMs;
    if (elapsed >= maxDurationMs) {
      console.log(
        `[PaperDaemon] Duration of ${config.durationHours} hours reached. Executing end-of-session cashout...`,
      );
      const openPositions = daemon.getSnapshot().openPositions;
      for (const pos of openPositions) {
        try {
          const exitPrice = pos.spotPriceSol > 0 ? pos.spotPriceSol : pos.entryPriceSol;
          daemon.manualExit(pos.positionId, exitPrice, currentNow, "SESSION_DURATION_CASHOUT");
          const timeStr = new Date(currentNow).toLocaleTimeString();
          addActivityLog(
            "SELL",
            `🔴 ${pos.symbol ?? pos.mintAddress.slice(0, 6)} closed at session cashout at ${timeStr} | Exit: SESSION_DURATION_CASHOUT`,
            pos.mintAddress,
            pos.symbol,
          );
          console.log(
            `[PaperDaemon] [SESSION CASHOUT] Liquidated ${pos.mintAddress} at ${exitPrice} SOL`,
          );
        } catch (cashoutErr) {
          console.error(`[PaperDaemon] Error cashing out ${pos.mintAddress}:`, cashoutErr);
        }
      }
      daemon.stop("DURATION_ELAPSED");
      break;
    }

    const snap = daemon.getSnapshot();
    if (snap.status === "HALTED" && !config.uninterruptedResearchMode) {
      console.error(`[PaperDaemon] Daemon halted due to: ${snap.haltReason}`);
      break;
    }

    // 1. Tick Open Positions with Live DexScreener Prices
    for (const pos of snap.openPositions) {
      try {
        const spotInfo = await fetchDexScreenerSpotInfo(pos.mintAddress);
        if (!spotInfo || !spotInfo.spotPriceSol || spotInfo.spotPriceSol <= 0) {
          const stagnantClosed = daemon.recordStagnantTick(pos.positionId, currentNow);
          if (stagnantClosed) {
            const timeStr = new Date(currentNow).toLocaleTimeString();
            const pnlPct = (stagnantClosed.realizedPnlBps / 100).toFixed(2);
            addActivityLog(
              "SELL",
              `🔴 ${pos.symbol ?? pos.mintAddress.slice(0, 6)} closed at stagnancy timeout at ${timeStr} | Exit: STAGNANCY_TIMEOUT_EXIT | Realized PnL: ${stagnantClosed.realizedPnlSol.toFixed(4)} SOL (${pnlPct}%)`,
              pos.mintAddress,
              pos.symbol,
            );
            console.log(
              `[PaperDaemon] [STAGNANCY TIMEOUT EXIT] ${pos.mintAddress} | Reason: STAGNANCY_TIMEOUT_EXIT | Inactive for >= 5m | Realized PnL: ${pnlPct}%`,
            );
          }
          continue;
        }

        tracker.samplePrice(pos.mintAddress, spotInfo.spotPriceSol, currentNow);

        const marketContext: MarketEvaluationContext = {
          currentTimestampMs: currentNow,
          spotPriceSol: spotInfo.spotPriceSol,
          lpIntact: true,
          recentBuysCount60s: spotInfo.recentBuys60s,
          recentSellsCount60s: spotInfo.recentSells60s,
          momentum5mBps: spotInfo.momentum5mBps,
          volumeStalled3m: false,
        };

        const result = daemon.tickPosition(pos.positionId, marketContext, currentNow);
        if (result?.action === "SELL_ALL") {
          const timeStr = new Date(currentNow).toLocaleTimeString();
          const usdPrice = (
            spotInfo.spotPriceUsd > 0 ? spotInfo.spotPriceUsd : spotInfo.spotPriceSol * 150
          ).toFixed(6);
          const pnlPct = (result.diagnostics.currentPnlBps / 100).toFixed(2);
          const closedTrade = daemon
            .getSnapshot()
            .closedTrades.find((t) => t.positionId === pos.positionId);
          const pnlSol = closedTrade ? closedTrade.realizedPnlSol.toFixed(4) : "0.0000";
          addActivityLog(
            "SELL",
            `🔴 ${pos.symbol ?? pos.mintAddress.slice(0, 6)} closed at $${usdPrice} at ${timeStr} | Exit: ${result.reasonCode} | Realized PnL: ${pnlSol} SOL (${pnlPct}%)`,
            pos.mintAddress,
            pos.symbol,
          );
          console.log(
            `[PaperDaemon] [SELL EXECUTED] ${pos.mintAddress} | Reason: ${result.reasonCode} | Realized PnL: ${pnlPct}%`,
          );
        } else if (result?.action === "SELL_PARTIAL_50") {
          const usdPrice = (
            spotInfo.spotPriceUsd > 0 ? spotInfo.spotPriceUsd : spotInfo.spotPriceSol * 150
          ).toFixed(6);
          addActivityLog(
            "RATCHET",
            `🟡 ${pos.symbol ?? pos.mintAddress.slice(0, 6)} sold 50% at $${usdPrice} (+20% Tier 1) | Floor locked to +10%`,
            pos.mintAddress,
            pos.symbol,
          );
          console.log(
            `[PaperDaemon] [TAKE PROFIT 50%] ${pos.mintAddress} | Reason: ${result.reasonCode} | Milestone +20% reached | Realized PnL: ${(result.diagnostics.currentPnlBps / 100).toFixed(2)}%`,
          );
        } else if (result?.action === "SELL_PARTIAL_25") {
          const usdPrice = (
            spotInfo.spotPriceUsd > 0 ? spotInfo.spotPriceUsd : spotInfo.spotPriceSol * 150
          ).toFixed(6);
          addActivityLog(
            "RATCHET",
            `🟡 ${pos.symbol ?? pos.mintAddress.slice(0, 6)} sold 25% at $${usdPrice} (+48.5% Tier 2) | Floor locked to Trailing Moonbag`,
            pos.mintAddress,
            pos.symbol,
          );
          console.log(
            `[PaperDaemon] [TAKE PROFIT 25%] ${pos.mintAddress} | Reason: ${result.reasonCode} | Milestone +48.5% reached | Realized PnL: ${(result.diagnostics.currentPnlBps / 100).toFixed(2)}%`,
          );
        }

        // Micro-Cap Scale-In Pyramiding:
        // If open position is MICRO_CAP, !pos.pyramided, pos.currentPnlBps >= 1000 (+10% Armed Breakeven),
        // daemon portfolio cash > 0.5 SOL, and spotInfo.recentBuys60s >= 1.5 * spotInfo.recentSells60s:
        if (
          result?.action !== "SELL_ALL" &&
          pos.cohort === "MICRO_CAP" &&
          !pos.pyramided &&
          pos.currentPnlBps >= 1000 &&
          daemon.getCurrentCashSol() > 0.5 &&
          spotInfo.recentBuys60s >= 1.5 * spotInfo.recentSells60s
        ) {
          const scaleInAmountSol = 0.25;
          const updatedPos = daemon.scaleInPosition(
            pos.positionId,
            scaleInAmountSol,
            spotInfo.spotPriceSol,
            currentNow,
          );
          if (updatedPos) {
            console.log(
              `[PaperDaemon] [PYRAMIDING_SCALE_IN] Added +${scaleInAmountSol} SOL to ${pos.symbol ?? pos.mintAddress.slice(0, 6)} at ${spotInfo.spotPriceSol} SOL (Blended Entry: ${updatedPos.entryPriceSol} SOL)`,
            );
            addActivityLog(
              "BUY",
              `🟢 Scaled in +${scaleInAmountSol} SOL to ${pos.symbol ?? pos.mintAddress.slice(0, 6)} at ${spotInfo.spotPriceSol.toFixed(6)} SOL | Blended entry: ${updatedPos.entryPriceSol.toFixed(6)} SOL`,
              pos.mintAddress,
              pos.symbol,
            );
          }
        }
      } catch (tickErr) {
        console.error(`[PaperDaemon] Tick error on ${pos.mintAddress}:`, tickErr);
      }
    }

    // 2. Scan Candidate Pools & Ingest into Stage 1 Watchlist Radar
    if (currentNow - lastScanMs >= scanIntervalMs) {
      lastScanMs = currentNow;
      try {
        const rawPools = await streamEngine.fetchRawPools(25);
        const currentNowSec = Math.floor(currentNow / 1000);

        // A. Ingest into Watchlist Service
        for (const pool of rawPools) {
          const admitted = watchlistService.admitOrUpdate(pool, currentNowSec);
          if (admitted) {
            tracker.recordCandidate(pool, "WATCHLIST_RADAR", pool.spotPriceUsd, currentNow);
          } else {
            tracker.recordCandidate(
              pool,
              "FILTERED_REJECTED",
              pool.spotPriceUsd,
              currentNow,
              "FAILED_BASELINE_SCANNER_PRESCREEN",
            );
          }
        }

        // B. Birdeye Trending Poll (Every 2.5 minutes if budget permits)
        if (birdeyeDiscovery.getBudgetTracker().canPollTrending(currentNow)) {
          try {
            const trendingTokens = await birdeyeDiscovery.fetchTrendingTokens(20, currentNow);
            if (trendingTokens.length > 0) {
              console.log(
                `[PaperDaemon] [Birdeye] Fetched ${trendingTokens.length} trending tokens from Birdeye`,
              );
              for (const token of trendingTokens) {
                if (streamEngine.isMintSeen(token.address)) continue;

                const isThinLiq = !token.liquidity || token.liquidity < 50_000;
                const liquidityUsd = token.liquidity > 0 ? token.liquidity : 40_000;
                const openTimeSec = isThinLiq ? currentNowSec - 300 : currentNowSec - 7200;

                const trendingRecord: ScannedPoolRecord = {
                  poolId: `birdeye-trending-${token.address.slice(0, 8)}`,
                  mintAddress: token.address,
                  symbol: token.symbol,
                  decimals: token.decimals ?? 9,
                  baseMint: token.address,
                  liquidityUsd,
                  marketCapUsd: liquidityUsd > 0 ? liquidityUsd * 4 : 160_000,
                  openTimeSec,
                  lpBurnPct: 100,
                  mintAuthority: null,
                  freezeAuthority: null,
                  volume5mUsd: token.volume24hUSD ? Math.round(token.volume24hUSD / 288) : 10_000,
                  txCount5m: 25,
                  buys5m: 16,
                  sells5m: 9,
                  spotPriceUsd: token.price > 0 ? token.price : 0.05,
                  fetchedAt: new Date(currentNow).toISOString(),
                };

                const admitted = watchlistService.admitOrUpdate(trendingRecord, currentNowSec);
                if (admitted) {
                  streamEngine.markMintSeen(token.address);
                  tracker.recordCandidate(
                    trendingRecord,
                    "WATCHLIST_RADAR",
                    trendingRecord.spotPriceUsd,
                    currentNow,
                  );
                }
              }
            }
          } catch (birdeyeErr) {
            console.error("[PaperDaemon] Error fetching Birdeye trending tokens:", birdeyeErr);
          }
        }

        // B. Prune expired candidates
        watchlistService.pruneExpired(currentNowSec);

        // Prune stale armed pullback candidates (> 90s)
        for (const [mint, state] of armedPullbackCandidates.entries()) {
          if (currentNow - state.armedAtMs > 90_000) {
            armedPullbackCandidates.delete(mint);
          }
        }

        // C. Stage 2 Buy Gate Confirmation
        const watchingCandidates = watchlistService.getActiveWatchingItems();

        // 60-Second Startup Warm-Up Buffer: allow radar and watchlist ingestion/enrichment to warm up
        const warmupRemainingMs = SESSION_START_WARMUP_MS - (currentNow - startMs);
        if (warmupRemainingMs > 0) {
          const remainingSec = Math.ceil(warmupRemainingMs / 1000);
          console.log(
            `[PaperDaemon] [WARMUP] Observing market (warmup buffer active: ${remainingSec}s remaining)...`,
          );
        } else {
          for (const candidate of watchingCandidates) {
            if (daemon.getSnapshot().openPositions.length >= config.maxOpenPositions) break;

            // Require candidate to have been observed on radar for at least 30s
            const discoveredAtMs = new Date(candidate.discoveredAt).getTime();
            const observedDurationMs = Number.isFinite(discoveredAtMs)
              ? currentNow - discoveredAtMs
              : 0;
            const hasSufficientObservation =
              observedDurationMs >= 30_000 || candidate.assetAgeSeconds >= 30;
            if (!hasSufficientObservation) {
              continue;
            }

            const preliminaryGate = buyGateService.evaluateCandidate(candidate);
            if (preliminaryGate.triggered) {
              // Check anti-rebuy cooldown
              const cooldowns = daemon.getExitCooldowns();
              const cooldownUntil = cooldowns.get(candidate.mintAddress);
              if (cooldownUntil && currentNow < cooldownUntil) {
                continue;
              }

              const spotInfo = await fetchDexScreenerSpotInfo(candidate.mintAddress);
              if (!spotInfo || !spotInfo.spotPriceSol || spotInfo.spotPriceSol <= 0) {
                tracker.recordCandidate(
                  candidate,
                  "FILTERED_REJECTED",
                  candidate.liquidityUsd,
                  currentNow,
                  "REJECTED_NO_ACTIVE_DEX_PAIR",
                );
                continue;
              }

              // Fetch RugCheck anti-bundler metrics (bundler ratio, top10 concentration, holder count)
              const rugMetrics = await BuyGateTriggerService.fetchRugCheckMetrics(
                candidate.mintAddress,
              );

              // Evaluate complete market context with 60s flow, momentum & anti-bundler metrics
              const fullGateResult = buyGateService.evaluateCandidate(candidate, {
                recentBuysCount60s: spotInfo.recentBuys60s,
                recentSellsCount60s: spotInfo.recentSells60s,
                momentum1mBps: Math.round(spotInfo.momentum5mBps / 5),
                bundlerPct: rugMetrics?.bundlerPct,
                top10HolderPct: rugMetrics?.top10HolderPct,
                holdersCount: rugMetrics?.holdersCount,
                rugScore: rugMetrics?.rugScore,
                hasDangerRisk: rugMetrics?.hasDangerRisk,
                priceChange1hPct: spotInfo.priceChange1hPct,
              });

              if (!fullGateResult.triggered) {
                if (armedPullbackCandidates.has(candidate.mintAddress)) {
                  armedPullbackCandidates.delete(candidate.mintAddress);
                }
                tracker.recordCandidate(
                  candidate,
                  "FILTERED_REJECTED",
                  spotInfo.spotPriceSol,
                  currentNow,
                  fullGateResult.rejectionReason,
                );
                continue;
              }

              // MANDATORY Liquidity Floor: Must have >= $50,000 liquidity to ever be classified as ESTABLISHED
              const isEstablished =
                candidate.liquidityUsd >= 50000 &&
                (candidate.assetAgeSeconds >= 3600 || candidate.marketCapUsd >= 250000);

              // Retest / Pullback Entry Confirmation for MICRO_CAP
              if (!isEstablished) {
                const armed = armedPullbackCandidates.get(candidate.mintAddress);
                if (!armed) {
                  armedPullbackCandidates.set(candidate.mintAddress, {
                    mintAddress: candidate.mintAddress,
                    armedAtMs: currentNow,
                    peakPriceSol: spotInfo.spotPriceSol,
                    peakPriceUsd: spotInfo.spotPriceUsd,
                    ticksObserved: 1,
                  });
                  console.log(
                    `[PaperDaemon] [ARMED_PULLBACK] Armed ${candidate.symbol} (${candidate.mintAddress}) at peak ${spotInfo.spotPriceSol} SOL ($${spotInfo.spotPriceUsd.toFixed(6)}). Awaiting 10-18% pullback or consolidation...`,
                  );
                  addActivityLog(
                    "INFO",
                    `🎯 Armed ${candidate.symbol} at peak ${spotInfo.spotPriceSol.toFixed(6)} SOL. Awaiting retest/pullback...`,
                    candidate.mintAddress,
                    candidate.symbol,
                  );
                  continue;
                }

                // Candidate already armed: update ticks & peak price
                const newPeakSol = Math.max(armed.peakPriceSol, spotInfo.spotPriceSol);
                const newPeakUsd =
                  spotInfo.spotPriceSol >= armed.peakPriceSol
                    ? spotInfo.spotPriceUsd
                    : armed.peakPriceUsd;
                const updatedArmed: ArmedPullbackState = {
                  ...armed,
                  peakPriceSol: newPeakSol,
                  peakPriceUsd: newPeakUsd,
                  ticksObserved: armed.ticksObserved + 1,
                };
                armedPullbackCandidates.set(candidate.mintAddress, updatedArmed);

                // Rule C: Plunged > 25% below peak (knife avoidance)
                if (spotInfo.spotPriceSol < updatedArmed.peakPriceSol * 0.75) {
                  armedPullbackCandidates.delete(candidate.mintAddress);
                  watchlistService.updateStatus(candidate.poolId, "DROPPED");
                  tracker.recordCandidate(
                    candidate,
                    "FILTERED_REJECTED",
                    spotInfo.spotPriceSol,
                    currentNow,
                    "REJECTED_PULLBACK_CRATERED",
                  );
                  console.log(
                    `[PaperDaemon] [ARMED_PULLBACK_CRATERED] ${candidate.symbol} plunged >25% from peak (${spotInfo.spotPriceSol} < ${(updatedArmed.peakPriceSol * 0.75).toFixed(6)} SOL). Dropping candidate.`,
                  );
                  addActivityLog(
                    "ALERT",
                    `⚠️ ${candidate.symbol} dropped: cratered >25% from peak (${spotInfo.spotPriceSol.toFixed(6)} SOL)`,
                    candidate.mintAddress,
                    candidate.symbol,
                  );
                  continue;
                }

                // Rule D: Expiry after 90 seconds
                if (currentNow - updatedArmed.armedAtMs > 90_000) {
                  armedPullbackCandidates.delete(candidate.mintAddress);
                  watchlistService.updateStatus(candidate.poolId, "DROPPED");
                  tracker.recordCandidate(
                    candidate,
                    "FILTERED_REJECTED",
                    spotInfo.spotPriceSol,
                    currentNow,
                    "REJECTED_PULLBACK_EXPIRED",
                  );
                  console.log(
                    `[PaperDaemon] [ARMED_PULLBACK_EXPIRED] ${candidate.symbol} expired after 90s without entry confirmation. Dropping candidate.`,
                  );
                  continue;
                }

                // Rule A: Retest Pullback Discount (10% to 18% pullback with flow absorption)
                const isPullbackDiscount =
                  spotInfo.spotPriceSol <= updatedArmed.peakPriceSol * 0.9 &&
                  spotInfo.spotPriceSol >= updatedArmed.peakPriceSol * 0.8;
                const hasPullbackFlow = spotInfo.recentBuys60s >= 1.25 * spotInfo.recentSells60s;
                const ruleAConfirmed = isPullbackDiscount && hasPullbackFlow;

                // Rule B: Consolidation Breakout (within 5% of peak for >= 30s or >= 3 ticks with strong flow)
                const isConsolidatingNearPeak =
                  spotInfo.spotPriceSol >= updatedArmed.peakPriceSol * 0.95;
                const hasConsolidationDuration =
                  currentNow - updatedArmed.armedAtMs >= 30_000 || updatedArmed.ticksObserved >= 3;
                const hasConsolidationFlow =
                  spotInfo.recentBuys60s >= 1.5 * spotInfo.recentSells60s;
                const ruleBConfirmed =
                  isConsolidatingNearPeak && hasConsolidationDuration && hasConsolidationFlow;

                if (!ruleAConfirmed && !ruleBConfirmed) {
                  const pullbackPct = (
                    ((spotInfo.spotPriceSol - updatedArmed.peakPriceSol) /
                      updatedArmed.peakPriceSol) *
                    100
                  ).toFixed(1);
                  console.log(
                    `[PaperDaemon] [ARMED_PULLBACK_WAIT] ${candidate.symbol} awaiting trigger | Spot: ${spotInfo.spotPriceSol} SOL (Peak: ${updatedArmed.peakPriceSol} SOL, Pullback: ${pullbackPct}%) | Flow: ${spotInfo.recentBuys60s}B/${spotInfo.recentSells60s}S | Ticks: ${updatedArmed.ticksObserved}`,
                  );
                  continue;
                }

                const confirmReason = ruleAConfirmed
                  ? "RETEST_PULLBACK_DISCOUNT"
                  : "CONSOLIDATION_BREAKOUT";
                console.log(
                  `[PaperDaemon] [ARMED_PULLBACK_CONFIRMED] ${candidate.symbol} entry confirmed via ${confirmReason}! Spot: ${spotInfo.spotPriceSol} SOL (Peak: ${updatedArmed.peakPriceSol} SOL)`,
                );
                armedPullbackCandidates.delete(candidate.mintAddress);
              } else {
                // If established, clear any previous armed state
                if (armedPullbackCandidates.has(candidate.mintAddress)) {
                  armedPullbackCandidates.delete(candidate.mintAddress);
                }
              }

              const entryPriceSol = spotInfo.spotPriceSol;
              let poolRecord: ScannedPoolRecord | undefined = rawPools.find(
                (p) => p.mintAddress === candidate.mintAddress,
              );

              if (!poolRecord) {
                poolRecord = {
                  poolId: candidate.poolId,
                  mintAddress: candidate.mintAddress,
                  symbol: candidate.symbol,
                  decimals: 9,
                  baseMint: candidate.mintAddress,
                  liquidityUsd: candidate.liquidityUsd,
                  marketCapUsd: candidate.marketCapUsd,
                  openTimeSec: Math.floor(currentNow / 1000) - candidate.assetAgeSeconds,
                  lpBurnPct: candidate.lpBurnPct ?? 100,
                  mintAuthority: null,
                  freezeAuthority: null,
                  volume5mUsd: candidate.volume5mUsd,
                  txCount5m: candidate.buys5m + candidate.sells5m,
                  buys5m: candidate.buys5m,
                  sells5m: candidate.sells5m,
                  spotPriceUsd:
                    spotInfo.spotPriceUsd > 0 ? spotInfo.spotPriceUsd : spotInfo.spotPriceSol * 150,
                  fetchedAt: new Date(currentNow).toISOString(),
                };
              }

              const cohort: CohortTier = isEstablished ? "ESTABLISHED" : "MICRO_CAP";
              const ratchetConfig = isEstablished
                ? ESTABLISHED_DYNAMIC_RATCHET_CONFIG
                : MICRO_CAP_DYNAMIC_RATCHET_CONFIG;

              // Sizing: Bump clean established tokens to 1.00 SOL (or config.positionSizeSol).
              // Downsize established tokens with > 60% bundlers or > 30% top-10 holders to 0.50 SOL.
              // Micro-Caps: Probe size 0.25 SOL
              let targetCohortSize = isEstablished
                ? Math.min(1.0, config.positionSizeSol || 1.0)
                : 0.25;
              if (isEstablished) {
                const highBundler =
                  rugMetrics?.bundlerPct !== undefined && rugMetrics.bundlerPct > 0.6;
                const highTop10 =
                  rugMetrics?.top10HolderPct !== undefined && rugMetrics.top10HolderPct > 0.3;
                if (highBundler || highTop10) {
                  targetCohortSize = 0.5;
                  console.log(
                    `[PaperDaemon] [ESTABLISHED_HIGH_RISK] Downsizing ${candidate.symbol} to 0.50 SOL (Bundlers: ${((rugMetrics?.bundlerPct ?? 0) * 100).toFixed(1)}%, Top10: ${((rugMetrics?.top10HolderPct ?? 0) * 100).toFixed(1)}%)`,
                  );
                }
              }

              const currentSnap = daemon.getSnapshot();
              const gasReserveSol = 0.05;
              const dynamicSize = Math.max(
                0.1,
                Math.min(
                  targetCohortSize,
                  parseFloat(
                    (
                      (currentSnap.currentPortfolioSol - gasReserveSol) /
                      config.maxOpenPositions
                    ).toFixed(3),
                  ),
                ),
              );

              const bought = daemon.processScannedPool(
                poolRecord,
                currentNow,
                entryPriceSol,
                dynamicSize,
                {
                  bypassScannerEvaluation: true,
                  cohort,
                  ratchetConfig,
                },
              );
              if (bought) {
                watchlistService.updateStatus(candidate.poolId, "BUY_TRIGGERED");
                tracker.recordExecutedBuy(candidate.mintAddress, entryPriceSol, currentNow);
                const timeStr = new Date(currentNow).toLocaleTimeString();
                const usdStr = (
                  spotInfo.spotPriceUsd > 0 ? spotInfo.spotPriceUsd : entryPriceSol * 150
                ).toFixed(6);
                const solStr = entryPriceSol.toFixed(6);
                addActivityLog(
                  "BUY",
                  `🟢 ${candidate.symbol} bought at $${usdStr} (${solStr} SOL) at ${timeStr} | Size: ${dynamicSize} SOL [${cohort}]`,
                  candidate.mintAddress,
                  candidate.symbol,
                );
                console.log(
                  `[PaperDaemon] [BUY GATE TRIGGERED & BOUGHT] [${cohort}] ${candidate.symbol} (${candidate.mintAddress}) | Entry: ${entryPriceSol} SOL | Cost Basis: ${dynamicSize} SOL`,
                );
              }
            }
          }
        }
      } catch (scanErr) {
        console.error("[PaperDaemon] Scan error:", scanErr);
      }
    }

    // 2b. Dedicated Watchlist Poller by Mint Address (Every 10s)
    if (currentNow - lastWatchlistRefreshMs >= 10000) {
      lastWatchlistRefreshMs = currentNow;
      const itemsToRefresh = watchlistService.getItems();
      for (const item of itemsToRefresh) {
        try {
          const freshRecord = await streamEngine.fetchDexScreenerTokenPair(item.mintAddress);
          if (freshRecord) {
            const currentNowSec = Math.floor(currentNow / 1000);
            watchlistService.admitOrUpdate(freshRecord, currentNowSec);
          }
        } catch {
          // ignore transient refresh errors
        }
      }
    }

    // 3. Counterfactual Price Sampler for Top Candidates across ALL cohorts (Every 15s)
    if (currentNow - lastRadarSampleMs >= 15000) {
      lastRadarSampleMs = currentNow;
      const topCandidates = tracker.getTopCandidatesForSampling(10);
      for (const item of topCandidates) {
        try {
          const spot = await fetchDexScreenerSpotInfo(item.mintAddress);
          if (spot) {
            tracker.samplePrice(item.mintAddress, spot.spotPriceSol, currentNow);
          }
        } catch {
          // ignore transient sampling errors
        }
      }
    }

    // 4. Heartbeat Telemetry Logging (Every 15s)
    if (currentNow - lastHeartbeatMs >= 15000) {
      lastHeartbeatMs = currentNow;
      const currentSnap = daemon.getSnapshot();
      const watchingCount = watchlistService.getActiveWatchingItems().length;
      console.log(
        `[PaperDaemon] [HEARTBEAT] Elapsed: ${((currentNow - startMs) / 60000).toFixed(1)}m | Open: ${currentSnap.openPositions.length}/${config.maxOpenPositions} | Radar: ${watchingCount} watching | Cash: ${currentSnap.currentPortfolioSol.toFixed(4)} SOL | Closed: ${currentSnap.closedTrades.length} | Realized PnL: ${currentSnap.totalRealizedPnlSol >= 0 ? "+" : ""}${currentSnap.totalRealizedPnlSol.toFixed(4)} SOL`,
      );
    }

    // 5. Persist Active Session State to File for Dashboard (Every 3s)
    if (currentNow - lastPersistMs >= 3000) {
      lastPersistMs = currentNow;
      persistState();
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }

  const finalSnap = daemon.getSnapshot();
  console.log(`[PaperDaemon] Session finished with status: ${finalSnap.status}`);
  persistState();
  archiveSession();
  const finalReport = tracker.generateReport(
    config.initialPortfolioSol,
    finalSnap.currentPortfolioSol,
  );
  console.log(
    `[PaperDaemon] Final Report: Observed=${finalReport.totalCandidatesObserved}, Executed=${finalReport.executedBuysCount}, MissedWinners=${finalReport.missedWinnersCount}, AvoidedRugs=${finalReport.avoidedRugsCount}`,
  );
}

void run();
