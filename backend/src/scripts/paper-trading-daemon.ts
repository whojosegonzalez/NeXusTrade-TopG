import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
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
import {
  PaperTradingDaemon,
  type PaperTradingDaemonConfig,
  parseScheduleString,
  isWithinTradingSchedule,
} from "../paper/PaperTradingDaemon.js";
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
import { fileURLToPath } from "node:url";

import {
  loadVirtualWallet,
  saveVirtualWallet,
  settleSessionInWallet,
} from "../paper/VirtualWallet.js";
import { acquireProcessLock, releaseProcessLock } from "../paper/ProcessLock.js";
import {
  writeSettlementJournal,
  updateSettlementJournalStage,
  cleanSettlementJournal,
  recoverSettlementJournal,
  type SettlementJournalEntry,
} from "../paper/SettlementJournal.js";
import {
  getCanonicalActiveSessionPath,
  getCanonicalObservationReportPath,
  getCanonicalPastSessionsPath,
  getCanonicalSessionFilePath,
  getCanonicalSessionsDir,
} from "../paper/CanonicalPaths.js";
import {
  TelemetryStorageManager,
  CandidateDecisionRecorder,
  MarketObservationRecorder,
  StratifiedSamplingController,
  TelemetryRateController,
  TelemetryFollowUpScheduler,
  type MetricProvenance,
} from "../telemetry/index.js";

export interface ParsedDaemonCliArgs {
  sessionId?: string | undefined;
  durationHours: number;
  maxOpenPositions: number;
  positionSizeSolRaw?: number | undefined;
  maxPortfolioDrawdownBps: number;
  antiRebuyCooldownMs: number;
  uninterruptedResearchMode: boolean;
  dryRun: boolean;
  resetWallet: boolean;
  rawInitialSol?: number | undefined;
  tradingSchedule?: ReturnType<typeof parseScheduleString> | undefined;
}

export function parseCliArgs(args: string[] = process.argv.slice(2)): ParsedDaemonCliArgs {
  const rawArgs = args.filter((arg) => arg !== "--");
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      "session-id": { type: "string" },
      "duration-hours": { type: "string" },
      duration: { type: "string" },
      "max-positions": { type: "string" },
      "max-open-positions": { type: "string" },
      "position-size-sol": { type: "string" },
      "max-drawdown-bps": { type: "string" },
      "cooldown-min": { type: "string" },
      "uninterrupted-research": { type: "boolean" },
      uninterrupted: { type: "boolean" },
      "waive-drawdown": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "initial-sol": { type: "string" },
      schedule: { type: "string" },
      "reset-wallet": { type: "boolean" },
    },
    strict: false,
  });

  const dryRun = values["dry-run"] === true;
  const resetWallet = values["reset-wallet"] === true;

  if (dryRun && resetWallet) {
    throw new Error(
      `[PaperDaemon] [INVALID_CONFIG] Conflicting arguments: --dry-run cannot be combined with --reset-wallet.`,
    );
  }

  if (resetWallet) {
    throw new Error(
      `[PaperDaemon] [FATAL_OPERATION_DISABLED] --reset-wallet is permanently disabled to protect continuous wallet balance continuity across generations. Use canonical wallet migration or generation registry procedures.`,
    );
  }

  const rawDuration = values["duration-hours"] ?? values["duration"];
  const durationHours =
    typeof rawDuration === "string" ? parseFloat(rawDuration) : values.schedule ? 24 : 4;

  const rawMaxPos = values["max-positions"] ?? values["max-open-positions"];
  const maxOpenPositions =
    typeof rawMaxPos === "string" ? Math.min(10, Math.max(1, parseInt(rawMaxPos, 10))) : 5;

  let rawInitialSol: number | undefined;
  const rawInitial = values["initial-sol"];
  if (typeof rawInitial === "string") {
    const parsedInitial = parseFloat(rawInitial);
    if (!Number.isFinite(parsedInitial) || parsedInitial <= 0) {
      throw new Error(
        `[PaperDaemon] [INVALID_CONFIG] --initial-sol must be a positive finite number (got "${rawInitial}")`,
      );
    }
    rawInitialSol = parsedInitial;
  }

  const rawSchedule = values.schedule;
  const tradingSchedule =
    typeof rawSchedule === "string" ? parseScheduleString(rawSchedule) : undefined;

  let positionSizeSolRaw: number | undefined;
  const rawSize = values["position-size-sol"];
  if (typeof rawSize === "string") {
    const parsedSize = parseFloat(rawSize);
    if (!Number.isFinite(parsedSize) || parsedSize <= 0) {
      throw new Error(
        `[PaperDaemon] [INVALID_CONFIG] --position-size-sol must be a positive finite number (got "${rawSize}")`,
      );
    }
    positionSizeSolRaw = parsedSize;
  }

  const rawDrawdown = values["max-drawdown-bps"];
  let maxPortfolioDrawdownBps = -500; // -5.0%
  if (typeof rawDrawdown === "string") {
    const parsed = parseInt(rawDrawdown, 10);
    if (!Number.isFinite(parsed) || parsed === 0 || Math.abs(parsed) > 10_000) {
      throw new Error(
        `[PaperDaemon] [INVALID_CONFIG] --max-drawdown-bps must be a non-zero integer between -10000 and 10000 bps (got "${rawDrawdown}")`,
      );
    }
    maxPortfolioDrawdownBps = -Math.abs(parsed);
  }

  const rawCooldown = values["cooldown-min"];
  const cooldownMin = typeof rawCooldown === "string" ? parseFloat(rawCooldown) : 30;
  const antiRebuyCooldownMs = cooldownMin * 60 * 1000;

  const uninterruptedResearchMode =
    values["uninterrupted-research"] === true ||
    values["uninterrupted"] === true ||
    values["waive-drawdown"] === true;

  const rawSessionId = values["session-id"];
  const sessionId = typeof rawSessionId === "string" ? rawSessionId : undefined;

  return {
    sessionId,
    durationHours,
    maxOpenPositions,
    positionSizeSolRaw,
    maxPortfolioDrawdownBps,
    antiRebuyCooldownMs,
    uninterruptedResearchMode,
    dryRun,
    resetWallet,
    rawInitialSol,
    tradingSchedule,
  };
}

interface DexScreenerRawProviderMetrics {
  readonly volume5mUsd: number | null;
  readonly volume1hUsd: number | null;
  readonly buys5m: number | null;
  readonly sells5m: number | null;
  readonly txCount5m: number | null;
  readonly buys1h: number | null;
  readonly sells1h: number | null;
  readonly baseReserve: number | null;
  readonly quoteReserve: number | null;
  readonly liquidityUsd: number | null;
  readonly measurementWindowSec: number;
  readonly derivationStatus: "DIRECT" | "DERIVED_FROM_1H";
}

interface DexScreenerSpotInfo {
  readonly spotPriceSol: number;
  readonly spotPriceUsd: number | null;
  readonly liquiditySol: number | null;
  readonly liquidityUsd: number | null;
  readonly baseReserve: number | null;
  readonly quoteReserve: number | null;
  readonly buyVolume5mSol: number;
  readonly sellVolume5mSol: number;
  readonly recentBuys60s: number;
  readonly recentSells60s: number;
  readonly recentTransactionsCount: number;
  readonly momentum5mBps: number;
  readonly priceChange1hPct: number;
  readonly requestInitiatedMs: number;
  readonly responseReceivedMs: number;
  readonly sourceTimestampMs: number;
  readonly actualResponsePoolId?: string | undefined;
  readonly rawProviderMetrics: DexScreenerRawProviderMetrics;
}

async function fetchDexScreenerSpotInfo(
  mintAddress: string,
  expectedPoolId?: string,
): Promise<DexScreenerSpotInfo | null> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mintAddress)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  const requestInitiatedMs = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal });
    const responseReceivedMs = Date.now();
    if (!res.ok) return null;
    const body = (await res.json()) as {
      pairs?: Array<{
        pairAddress?: string;
        quoteToken?: { symbol?: string; address?: string };
        priceNative?: string;
        priceUsd?: string;
        liquidity?: { usd?: number; quote?: number; base?: number };
        volume?: { m5?: number; h1?: number };
        txns?: {
          m5?: { buys?: number; sells?: number };
          h1?: { buys?: number; sells?: number };
        };
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

    // If expectedPoolId is provided, attempt to locate the exact tracked pool
    let solPair = validSolPairs[0];
    if (expectedPoolId) {
      const normExpected = expectedPoolId.replace(/^dexscreener-/, "");
      const matched = validSolPairs.find(
        (p) => p.pairAddress === normExpected || p.pairAddress === expectedPoolId,
      );
      if (matched) {
        solPair = matched;
      }
    } else {
      // Otherwise sort by highest USD liquidity
      validSolPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      solPair = validSolPairs[0];
    }

    if (!solPair?.priceNative) return null;

    const spotPriceSol = parseFloat(solPair.priceNative);
    if (!Number.isFinite(spotPriceSol) || spotPriceSol <= 0) return null;

    const spotPriceUsd = solPair.priceUsd ? parseFloat(solPair.priceUsd) : null;
    const liquidityUsd = typeof solPair.liquidity?.usd === "number" ? solPair.liquidity.usd : null;
    const baseReserve = typeof solPair.liquidity?.base === "number" ? solPair.liquidity.base : null;
    const quoteReserve =
      typeof solPair.liquidity?.quote === "number" ? solPair.liquidity.quote : null;

    // Raw provider metrics
    const hasM5Txns = solPair.txns?.m5?.buys !== undefined || solPair.txns?.m5?.sells !== undefined;
    const buys5m = solPair.txns?.m5?.buys ?? null;
    const sells5m = solPair.txns?.m5?.sells ?? null;
    const txCount5m = buys5m !== null && sells5m !== null ? buys5m + sells5m : null;
    const volume5mUsd = typeof solPair.volume?.m5 === "number" ? solPair.volume.m5 : null;
    const volume1hUsd = typeof solPair.volume?.h1 === "number" ? solPair.volume.h1 : null;
    const buys1h = solPair.txns?.h1?.buys ?? null;
    const sells1h = solPair.txns?.h1?.sells ?? null;
    const measurementWindowSec = hasM5Txns || volume5mUsd !== null ? 300 : 3600;
    const derivationStatus: "DIRECT" | "DERIVED_FROM_1H" = hasM5Txns ? "DIRECT" : "DERIVED_FROM_1H";

    const rawProviderMetrics: DexScreenerRawProviderMetrics = {
      volume5mUsd,
      volume1hUsd,
      buys5m,
      sells5m,
      txCount5m,
      buys1h,
      sells1h,
      baseReserve,
      quoteReserve,
      liquidityUsd,
      measurementWindowSec,
      derivationStatus,
    };

    // Strategy-internal estimates (preserved strictly for internal trading thresholds):
    const liquiditySol = quoteReserve ?? (liquidityUsd ? liquidityUsd / 140 : 100);
    const m5Vol = volume5mUsd ?? 0;
    const buyVolSol = (m5Vol / 140) * 0.6;
    const sellVolSol = (m5Vol / 140) * 0.4;
    const recentBuys60s = Math.round((buys5m ?? (buys1h ? Math.round(buys1h / 12) : 0)) / 5);
    const recentSells60s = Math.round((sells5m ?? (sells1h ? Math.round(sells1h / 12) : 0)) / 5);
    const momentum5mBps = solPair.priceChange?.m5 ? Math.round(solPair.priceChange.m5 * 100) : 0;
    const priceChange1hPct =
      solPair.priceChange?.h1 !== undefined && Number.isFinite(solPair.priceChange.h1)
        ? solPair.priceChange.h1
        : 0;

    return {
      spotPriceSol,
      spotPriceUsd,
      liquiditySol,
      liquidityUsd,
      baseReserve,
      quoteReserve,
      buyVolume5mSol: buyVolSol,
      sellVolume5mSol: sellVolSol,
      recentBuys60s,
      recentSells60s,
      recentTransactionsCount: (buys5m ?? 0) + (sells5m ?? 0),
      momentum5mBps,
      priceChange1hPct,
      requestInitiatedMs,
      responseReceivedMs,
      sourceTimestampMs: responseReceivedMs,
      actualResponsePoolId: solPair.pairAddress ?? undefined,
      rawProviderMetrics,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export {
  resolveJournalPath,
  recoverSettlementJournal,
  writeSettlementJournal,
  updateSettlementJournalStage,
  cleanSettlementJournal,
  type SettlementJournalEntry,
  type SettlementJournalStage,
  type RecoverJournalOptions,
  type RecoverJournalResult,
} from "../paper/SettlementJournal.js";

export async function run(): Promise<void> {
  const args = parseCliArgs();

  // Section C: Genuinely read-only validation preflight when --dry-run is supplied
  if (args.dryRun) {
    console.log(
      `[PaperDaemon] [DRY_RUN] Read-only dry run mode requested. Validating configurations, budget, wallet, and lock without executing trades or mutating files...`,
    );
    const vWallet = loadVirtualWallet();
    console.log(
      `[PaperDaemon] [DRY_RUN] Authoritative virtual wallet loaded: Balance=${vWallet.currentBalanceSol} SOL, All-Time PnL=${vWallet.allTimeRealizedPnlSol} SOL, CompletedSessions=${vWallet.totalSessionsCompleted}`,
    );
    const testLock = acquireProcessLock({
      processName: "PaperDaemon-DryRun",
      sessionId: args.sessionId ?? "dry-run-check",
    });
    releaseProcessLock(testLock);
    console.log(`[PaperDaemon] [DRY_RUN] Process exclusivity lock check: PASSED`);

    console.log(
      `===============================================================================\n` +
        `                     NEXUSTRADE: DRY RUN PREFLIGHT AUDIT PASSED                \n` +
        `===============================================================================\n` +
        `Mode: READ-ONLY PREFLIGHT (No trading, no mutations)\n` +
        `Session ID: ${args.sessionId ?? "N/A"}\n` +
        `Authoritative Wallet: Balance ${vWallet.currentBalanceSol} SOL (${vWallet.totalSessionsCompleted} completed sessions)\n` +
        `Schedule: ${args.tradingSchedule ? args.tradingSchedule.rawString : "UNSCHEDULED (24h default)"}\n` +
        `Status: VERIFIED. Exiting cleanly with code 0 without modifying ledger or creating session.\n` +
        `===============================================================================`,
    );
    return;
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T.]/g, "")
    .slice(0, 14);
  const sessionId = args.sessionId ?? `session-paper-${timestamp}`;

  // Normal execution: acquire exclusive process lock FIRST (P0-E7-04 & E8-02)
  const processLockHandle = acquireProcessLock({
    processName: "PaperTradingDaemon",
    sessionId,
  });

  try {
    // Destructive wallet reset is permanently disabled to protect canonical wallet lineage (7.9259 SOL)
    if (args.resetWallet) {
      throw new Error(
        `[PaperDaemon] [FATAL_OPERATION_DISABLED] Destructive wallet reset via --reset-wallet is permanently disabled to protect canonical wallet lineage (7.9259 SOL). Generation lifecycle migrations must be orchestrated via explicit generation management tooling.`,
      );
    }

    console.log(`[PaperDaemon] Starting Paper Trading Daemon Session: ${sessionId}`);

    // D7-03 & E8-03: Recover any uncommitted settlement journals before loading wallet capital
    recoverSettlementJournal();

    // E8-03: Load authoritative canonical wallet AFTER journal recovery
    const vWallet = loadVirtualWallet();
    const initialPortfolioSol = args.rawInitialSol ?? vWallet.currentBalanceSol;

    if (vWallet.unresolvedTokens && vWallet.unresolvedTokens.length > 0) {
      console.warn(
        `[PaperDaemon] [UNRESOLVED_INVENTORY] Continuous virtual wallet contains ${vWallet.unresolvedTokens.length} unresolved token holding(s) from prior session(s):`,
      );
      for (const item of vWallet.unresolvedTokens) {
        console.warn(
          `   - Mint: ${item.mintAddress} (${item.symbol ?? "N/A"}) | Tokens: ${item.tokensHeld} | CostBasis: ${item.costBasisSol} SOL | Session: ${item.sessionId} | Reason: ${item.reasonForMissingData}`,
        );
      }
    }

    const gasReserveSol = 0.05;
    const calculatedBalancedSize = Math.min(
      1.0,
      parseFloat(((initialPortfolioSol - gasReserveSol) / args.maxOpenPositions).toFixed(4)),
    );
    const positionSizeSol = args.positionSizeSolRaw ?? calculatedBalancedSize;

    const config: PaperTradingDaemonConfig = {
      sessionId,
      durationHours: args.durationHours,
      maxOpenPositions: args.maxOpenPositions,
      positionSizeSol,
      initialPortfolioSol,
      maxPortfolioDrawdownBps: args.maxPortfolioDrawdownBps,
      maxConsecutiveErrors: 3,
      maxClockDriftMs: 5000,
      pollIntervalMs: 1500,
      dryRun: false,
      antiRebuyCooldownMs: args.antiRebuyCooldownMs,
      uninterruptedResearchMode: args.uninterruptedResearchMode,
      ...(args.tradingSchedule ? { tradingSchedule: args.tradingSchedule } : {}),
    };

    console.log(
      `[PaperDaemon] [STARTUP_CONFIG] Session=${config.sessionId} | InitialPortfolio=${config.initialPortfolioSol.toFixed(4)} SOL | PositionSize=${config.positionSizeSol} SOL | MaxOpenPositions=${config.maxOpenPositions} | MaxDrawdownBps=${config.maxPortfolioDrawdownBps} bps (${(config.maxPortfolioDrawdownBps / 100).toFixed(1)}%) | Uninterrupted=${config.uninterruptedResearchMode ? "ENABLED" : "DISABLED"} | Cooldown=${((config.antiRebuyCooldownMs ?? 0) / 60000).toFixed(0)}m | Schedule=${config.tradingSchedule ? config.tradingSchedule.rawString : "NONE"}`,
    );
    console.log(
      `[PaperDaemon] Config: Duration=${config.durationHours}h, MaxPositions=${config.maxOpenPositions}, Size=${config.positionSizeSol} SOL`,
    );
    console.log(
      `[PaperDaemon] Protective Guardrails: MaxDrawdown=${config.maxPortfolioDrawdownBps} bps, AntiRebuyCooldown=${((config.antiRebuyCooldownMs ?? 0) / 60000).toFixed(0)}m, UninterruptedResearch=${config.uninterruptedResearchMode ? "ENABLED" : "DISABLED"}`,
    );
    if (config.tradingSchedule) {
      console.log(
        `[PaperDaemon] Chrono-Regime Gating: ACTIVE (${config.tradingSchedule.rawString}) [Timezone: ${config.tradingSchedule.timeZone}]`,
      );
    }

    // P0-R4: Startup reconciliation check between past-sessions.json and vWallet.settledSessionIds (E8-04)
    const pastSessionsPath = getCanonicalPastSessionsPath();
    if (existsSync(pastSessionsPath)) {
      try {
        const raw = readFileSync(pastSessionsPath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const pastIds = new Set(parsed.map((s) => s.sessionId));
          const settledIds = new Set(vWallet.settledSessionIds ?? []);
          const missingInWallet = [...pastIds].filter((id) => !settledIds.has(id));
          const missingInArchive = [...settledIds].filter((id) => !pastIds.has(id));
          if (missingInWallet.length > 0 || missingInArchive.length > 0) {
            console.warn(
              `[PaperDaemon] [SESSION_RECONCILIATION_WARNING] Inconsistency detected between past-sessions archive and virtual wallet:`,
            );
            if (missingInWallet.length > 0) {
              console.warn(
                `   - Sessions in past-sessions.json but not in settledSessionIds (${missingInWallet.length}): ${missingInWallet.slice(0, 5).join(", ")}`,
              );
            }
            if (missingInArchive.length > 0) {
              console.warn(
                `   - Sessions in settledSessionIds but not in past-sessions.json (${missingInArchive.length}): ${missingInArchive.slice(0, 5).join(", ")}`,
              );
            }
          }
        }
      } catch (err) {
        console.warn(
          `[PaperDaemon] [SESSION_RECONCILIATION_WARN] Failed to read past-sessions for reconciliation:`,
          err,
        );
      }
    }

    // P0-R2: Initialize daemon with wallet's unresolved inventory and block duplicate buys
    const daemon = new PaperTradingDaemon({
      config,
      initialUnresolvedPositions: vWallet.unresolvedTokens,
      initialBlockedMints: vWallet.unresolvedTokens?.map((t) => t.mintAddress),
    });
    daemon.start();

    const telemetryStorage = new TelemetryStorageManager();
    const telemetryMeta = telemetryStorage.initSessionTelemetry(
      sessionId,
      "gen-01-legacy-baseline",
      vWallet.currentBalanceSol,
    );
    const telemetryDecisions = new CandidateDecisionRecorder(telemetryStorage);
    telemetryDecisions.syncFromStorage(sessionId);
    const telemetryObservations = new MarketObservationRecorder(telemetryStorage);
    const telemetrySampling = new StratifiedSamplingController(telemetryStorage);
    const telemetryRate = new TelemetryRateController();
    const telemetryFollowUp = new TelemetryFollowUpScheduler(
      telemetryStorage,
      telemetryObservations,
      telemetrySampling,
      telemetryRate,
      async (poolId: string, mintAddress: string) => {
        const spot = await fetchDexScreenerSpotInfo(mintAddress, poolId);
        if (!spot) return null;
        return {
          spotPriceUsd: spot.spotPriceUsd,
          spotPriceSol: spot.spotPriceSol,
          liquidityUsd: spot.rawProviderMetrics.liquidityUsd,
          baseReserve: spot.rawProviderMetrics.baseReserve,
          quoteReserve: spot.rawProviderMetrics.quoteReserve,
          txCount: spot.rawProviderMetrics.txCount5m,
          buys: spot.rawProviderMetrics.buys5m,
          sells: spot.rawProviderMetrics.sells5m,
          volumeUsd: spot.rawProviderMetrics.volume5mUsd,
          priceSource: "INDEXED_TICK",
          actualPoolId: spot.actualResponsePoolId,
          measurementWindowSec: spot.rawProviderMetrics.measurementWindowSec,
          timestampMs: spot.sourceTimestampMs,
        };
      },
    );

    const streamEngine = new CandidateStreamEngine({
      config: config.scannerConfig ?? CANDIDATE_SCANNER_DEFAULTS,
      onDecision: (evalResult, pool) => {
        try {
          const nowSec = Math.floor(Date.now() / 1000);
          const currentNow = Date.now();
          const metricProvenance: Record<string, MetricProvenance> = {
            tokenAgeSec: pool.openTimeSec > 0 ? "OBSERVED" : "UNAVAILABLE",
            liquidityUsd: pool.liquidityUsd > 0 ? "OBSERVED" : "UNAVAILABLE",
            marketCapUsd: pool.marketCapUsd > 0 ? "OBSERVED" : "UNAVAILABLE",
            lmcRatio: pool.marketCapUsd > 0 && pool.liquidityUsd > 0 ? "DERIVED" : "UNAVAILABLE",
            lpBurnPct: pool.lpBurnPct !== undefined ? "OBSERVED" : "UNAVAILABLE",
            spotPriceUsd: pool.spotPriceUsd > 0 ? "OBSERVED" : "UNAVAILABLE",
            spotPriceSol:
              pool.spotPriceSol !== undefined && pool.spotPriceSol !== null && pool.spotPriceSol > 0
                ? "OBSERVED"
                : "UNAVAILABLE",
            volume5mUsd: pool.volume5mUsd !== undefined ? "OBSERVED" : "UNAVAILABLE",
            txCount5m: pool.txCount5m !== undefined ? "OBSERVED" : "UNAVAILABLE",
            buys5m: pool.buys5m !== undefined ? "OBSERVED" : "UNAVAILABLE",
            sells5m: pool.sells5m !== undefined ? "OBSERVED" : "UNAVAILABLE",
            ...(pool.metricProvenance ?? {}),
          };
          const metricsSnapshot = {
            tokenAgeSec: pool.openTimeSec > 0 ? Math.max(0, nowSec - pool.openTimeSec) : 0,
            liquidityUsd: pool.liquidityUsd,
            marketCapUsd: pool.marketCapUsd,
            lmcRatio: pool.marketCapUsd > 0 ? pool.liquidityUsd / pool.marketCapUsd : 0,
            lpBurnPct: pool.lpBurnPct,
            spotPriceUsd: pool.spotPriceUsd,
            spotPriceSol: pool.spotPriceSol ?? null,
            volume5mUsd: pool.volume5mUsd,
            txCount5m: pool.txCount5m,
            buys5m: pool.buys5m,
            sells5m: pool.sells5m,
            metricProvenance,
          };
          const filterEvaluations = evalResult.filterEvaluations.map((f) => ({
            filterName: f.filterName,
            passed: f.passed,
            valueObserved: null,
            threshold: null,
            rejectionReason: f.reason,
          }));
          const decRecord = telemetryDecisions.recordDecision({
            sessionId,
            generationId: "gen-01-legacy-baseline",
            mintAddress: pool.mintAddress,
            poolId: pool.poolId,
            symbol: pool.symbol,
            sourceTimestampMs: currentNow,
            ingestionTimestampMs: currentNow,
            poolOpenTimeMs: pool.openTimeSec > 0 ? pool.openTimeSec * 1000 : undefined,
            decisionCohort: evalResult.admitted ? "WATCHLIST_RADAR" : "FILTERED_REJECTED",
            primaryRejectionReason: evalResult.primaryRejectionReason,
            filterEvaluations,
            metricsSnapshot,
            providerIdentity: pool.poolId.startsWith("dexscreener") ? "dexscreener" : "raydium",
          });
          telemetrySampling.evaluateForTracking(decRecord, pool.spotPriceSol ?? null);
        } catch (err) {
          console.warn("[PaperDaemon] Telemetry decision recording error:", err);
        }
      },
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

    const recordTriggerRejection = (
      candidate: {
        poolId: string;
        mintAddress: string;
        symbol: string;
        liquidityUsd: number;
        marketCapUsd: number;
        assetAgeSeconds: number;
        lpBurnPct?: number;
        volume5mUsd?: number;
        buys5m: number;
        sells5m: number;
        lmcRatio: number;
        metricProvenance?: Record<string, MetricProvenance> | undefined;
      },
      reason: string,
      spotSol: number | null,
      spotUsd: number | null,
      liqUsd: number | null,
      recentBuys60s: number | null,
      recentSells60s: number | null,
      filterName: string = "BuyGate",
      currentTimestampMs: number = nowMs(),
      spotInfo?: DexScreenerSpotInfo | null,
    ) => {
      tracker.recordCandidate(
        candidate,
        "FILTERED_REJECTED",
        spotSol ?? 0,
        currentTimestampMs,
        reason,
      );
      try {
        const raw = spotInfo?.rawProviderMetrics;
        const candProv = candidate.metricProvenance ?? {};

        const hasObservedTxCount = raw?.txCount5m !== null && raw?.txCount5m !== undefined;
        const observedTxCount5m = hasObservedTxCount ? raw!.txCount5m : null;
        const provTxCount: MetricProvenance = hasObservedTxCount
          ? "OBSERVED"
          : (candProv.txCount5m ?? "UNAVAILABLE");

        const hasObservedBuys = raw?.buys5m !== null && raw?.buys5m !== undefined;
        const observedBuys5m = hasObservedBuys ? raw!.buys5m : null;
        const provBuys: MetricProvenance = hasObservedBuys
          ? "OBSERVED"
          : (candProv.buys5m ?? "UNAVAILABLE");

        const hasObservedSells = raw?.sells5m !== null && raw?.sells5m !== undefined;
        const observedSells5m = hasObservedSells ? raw!.sells5m : null;
        const provSells: MetricProvenance = hasObservedSells
          ? "OBSERVED"
          : (candProv.sells5m ?? "UNAVAILABLE");

        const hasObservedVolume = raw?.volume5mUsd !== null && raw?.volume5mUsd !== undefined;
        const observedVolume5mUsd = hasObservedVolume
          ? raw!.volume5mUsd
          : (candidate.volume5mUsd ?? null);
        const provVolume: MetricProvenance = hasObservedVolume
          ? "OBSERVED"
          : (candProv.volume5mUsd ??
            (candidate.volume5mUsd !== undefined ? "DERIVED" : "UNAVAILABLE"));

        const hasObservedLiq = raw?.liquidityUsd !== null && raw?.liquidityUsd !== undefined;
        const observedLiqUsd = hasObservedLiq
          ? raw!.liquidityUsd
          : liqUsd && liqUsd > 0
            ? liqUsd
            : candidate.liquidityUsd > 0
              ? candidate.liquidityUsd
              : null;
        const provLiq: MetricProvenance = hasObservedLiq
          ? "OBSERVED"
          : (candProv.liquidityUsd ?? (observedLiqUsd !== null ? "OBSERVED" : "UNAVAILABLE"));

        const provMcap: MetricProvenance =
          candProv.marketCapUsd ?? (candidate.marketCapUsd > 0 ? "DERIVED" : "UNAVAILABLE");

        const provLpBurn: MetricProvenance =
          candProv.lpBurnPct ?? (candidate.lpBurnPct !== undefined ? "OBSERVED" : "UNAVAILABLE");

        const observedSpotUsd = spotUsd && spotUsd > 0 ? spotUsd : null;
        const observedSpotSol = spotSol && spotSol > 0 ? spotSol : null;
        const provSpotUsd: MetricProvenance = observedSpotUsd !== null ? "OBSERVED" : "UNAVAILABLE";
        const provSpotSol: MetricProvenance = observedSpotSol !== null ? "OBSERVED" : "UNAVAILABLE";
        const provTokenAge: MetricProvenance =
          candidate.assetAgeSeconds > 0 ? (candProv.tokenAgeSec ?? "OBSERVED") : "UNAVAILABLE";
        const provLmcRatio: MetricProvenance =
          candidate.marketCapUsd > 0 && observedLiqUsd !== null ? "DERIVED" : "UNAVAILABLE";

        telemetryDecisions.recordDecision({
          sessionId,
          generationId: "gen-01-legacy-baseline",
          mintAddress: candidate.mintAddress,
          poolId: candidate.poolId,
          symbol: candidate.symbol,
          sourceTimestampMs: currentTimestampMs,
          ingestionTimestampMs: currentTimestampMs,
          poolOpenTimeMs:
            candidate.assetAgeSeconds > 0
              ? currentTimestampMs - candidate.assetAgeSeconds * 1000
              : undefined,
          decisionCohort: "TRIGGER_REJECTED",
          primaryRejectionReason: reason,
          filterEvaluations: [
            {
              filterName,
              passed: false,
              valueObserved: null,
              threshold: null,
              rejectionReason: reason,
            },
          ],
          metricsSnapshot: {
            tokenAgeSec: candidate.assetAgeSeconds,
            liquidityUsd: observedLiqUsd,
            marketCapUsd: candidate.marketCapUsd,
            lmcRatio: candidate.lmcRatio,
            lpBurnPct: candidate.lpBurnPct ?? 100,
            spotPriceUsd: observedSpotUsd,
            spotPriceSol: observedSpotSol,
            volume5mUsd: observedVolume5mUsd,
            txCount5m: observedTxCount5m,
            buys5m: observedBuys5m,
            sells5m: observedSells5m,
            metricProvenance: {
              tokenAgeSec: provTokenAge,
              liquidityUsd: provLiq,
              marketCapUsd: provMcap,
              lmcRatio: provLmcRatio,
              lpBurnPct: provLpBurn,
              spotPriceUsd: provSpotUsd,
              spotPriceSol: provSpotSol,
              volume5mUsd: provVolume,
              txCount5m: provTxCount,
              buys5m: provBuys,
              sells5m: provSells,
            },
          },
          providerIdentity: candidate.poolId.startsWith("dexscreener") ? "dexscreener" : "raydium",
        });
      } catch (tErr) {
        console.warn("[PaperDaemon] Telemetry trigger rejection recording error:", tErr);
      }
    };

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
    let activeTradingMs = 0;
    let lastActiveTickMs = startMs;
    let hasEnteredActiveSchedule = false;
    let lastScanMs = 0;
    let lastWatchlistRefreshMs = 0;
    let lastHeartbeatMs = 0;
    let lastPersistMs = 0;
    let lastRadarSampleMs = 0;
    let lastStandbyLogMs = 0;
    let wasInStandby = false;
    const scanIntervalMs = 5000;
    const SESSION_START_WARMUP_MS = 60_000;
    const armedPullbackCandidates = new Map<string, ArmedPullbackState>();

    let lastReportSaveMs = 0;
    const persistState = (forceReportSave = false, isFinal = false) => {
      const snap = daemon.getSnapshot();
      const fullState = {
        ...snap,
        durationHours: config.durationHours,
        lastTickAtMs: nowMs(),
        watchlist: watchlistService.getItems(),
        recentActivityLogs: activityLogs,
      };
      try {
        const targetPath = getCanonicalActiveSessionPath();
        const dir = path.dirname(targetPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const tempPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
        writeFileSync(tempPath, JSON.stringify(fullState, null, 2), "utf8");
        renameSync(tempPath, targetPath);
        const currentNow = nowMs();
        if (forceReportSave || currentNow - lastReportSaveMs >= 60_000) {
          lastReportSaveMs = currentNow;
          tracker.saveReportToFile(
            getCanonicalObservationReportPath(),
            config.initialPortfolioSol,
            snap.currentPortfolioSol,
          );
        }
      } catch (err) {
        if (isFinal) {
          throw new Error(
            `[PaperDaemon] [FATAL] Final active-state persistence failed: ${String(err)}`,
          );
        }
        void err;
      }
    };

    let archived = false;
    const archiveSession = () => {
      if (archived) return;
      try {
        const sessionsDir = getCanonicalSessionsDir();
        if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });
        const snap = daemon.getSnapshot();
        const report = tracker.generateReport(config.initialPortfolioSol, snap.currentPortfolioSol);
        const summary = daemon.getHistoricalSummary({
          coinsWatchedCount: report.totalCandidatesObserved,
          missedOpportunitiesCount: report.missedWinnersCount,
        });

        const liquidCashSol =
          snap.currentCashSol ??
          snap.currentPortfolioSol -
            snap.openPositions.reduce((acc, p) => acc + p.tokensHeld * p.spotPriceSol, 0);
        const reconciledIds = snap.closedTrades
          .filter(
            (t) =>
              t.exitReason === "MANUAL_RECONCILIATION" || t.exitReason.includes("RECONCILIATION"),
          )
          .map((t) => t.positionId);

        // 0. Initialize Settlement Journal (D7-03)
        const journalEntry: SettlementJournalEntry = {
          sessionId: config.sessionId,
          startedAtMs: nowMs(),
          stage: "STARTED",
          sessionSummary: summary,
          sessionNewRealizedPnlSol: snap.sessionNewRealizedPnlSol,
          liquidCashSol,
          initialPortfolioSol: config.initialPortfolioSol,
          unresolvedPositions: snap.unresolvedPositions,
          reconciledPositionIds: reconciledIds,
        };
        writeSettlementJournal(journalEntry);

        // 1. Write individual session JSON atomically (P0-3)
        const sessionFile = getCanonicalSessionFilePath(config.sessionId);
        const tempSessionFile = `${sessionFile}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
        writeFileSync(tempSessionFile, JSON.stringify(summary, null, 2), "utf8");
        renameSync(tempSessionFile, sessionFile);
        updateSettlementJournalStage("SESSION_FILE_WRITTEN", journalEntry);

        // 2. Read, update, and write past-sessions.json atomically (P0-3 & P0-R4)
        let pastSessions: HistoricalSessionSummary[] = [];
        const pastSessionsPath = getCanonicalPastSessionsPath();
        if (existsSync(pastSessionsPath)) {
          try {
            const raw = readFileSync(pastSessionsPath, "utf8");
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
              throw new Error("past-sessions.json content is not an array");
            }
            pastSessions = parsed;
          } catch (parseErr) {
            const corruptBackup = `${pastSessionsPath}.corrupt-${Date.now()}`;
            try {
              copyFileSync(pastSessionsPath, corruptBackup);
              console.error(
                `[PaperDaemon] [PAST_SESSIONS_CORRUPT] Existing ${pastSessionsPath} is corrupted. Backed up to ${corruptBackup}`,
              );
            } catch {
              // ignore backup failure
            }
            throw new Error(
              `[PaperDaemon] [FATAL] Corrupt ${pastSessionsPath}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Archiving aborted to fail closed and preserve history.`,
            );
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

        const tempPastSessionsPath = `${pastSessionsPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
        writeFileSync(tempPastSessionsPath, JSON.stringify(pastSessions, null, 2), "utf8");
        renameSync(tempPastSessionsPath, pastSessionsPath);
        updateSettlementJournalStage("PAST_SESSIONS_WRITTEN", journalEntry);
        console.log(
          `[PaperDaemon] Archived session summary to ${sessionFile} and updated ${pastSessionsPath}`,
        );

        // 3. Update Continuous Virtual Wallet (Idempotent settlement: P0-C, P0-1, & D7-01 incremental realized P&L)
        const wallet = loadVirtualWallet();
        const settled = settleSessionInWallet(
          wallet,
          config.sessionId,
          liquidCashSol,
          config.initialPortfolioSol,
          nowMs(),
          snap.unresolvedPositions,
          snap.sessionNewRealizedPnlSol,
          reconciledIds,
        );
        if (settled) {
          saveVirtualWallet(wallet);
          console.log(
            `[PaperDaemon] Updated Continuous Virtual Wallet: Balance=${wallet.currentBalanceSol.toFixed(4)} SOL | All-Time Realized PnL=${wallet.allTimeRealizedPnlSol >= 0 ? "+" : ""}${wallet.allTimeRealizedPnlSol.toFixed(4)} SOL | Unresolved Tokens=${wallet.unresolvedTokens?.length ?? 0} | Sessions=${wallet.totalSessionsCompleted}`,
          );
        } else {
          console.log(
            `[PaperDaemon] Continuous Virtual Wallet already settled for session ${config.sessionId}. Skipping duplicate balance update.`,
          );
        }
        updateSettlementJournalStage("WALLET_SETTLED", journalEntry);

        // 4. Mark COMMITTED and clean up
        cleanSettlementJournal();
        archived = true;
      } catch (archiveErr) {
        console.error("[PaperDaemon] Failed to archive session summary:", archiveErr);
        throw archiveErr;
      }
    };

    // Graceful shutdown handlers
    let terminating = false;
    const handleShutdown = () => {
      if (terminating) return;
      terminating = true;
      console.log("\n[PaperDaemon] Termination signal received. Stopping daemon...");
      daemon.stop("MANUAL_STOP");

      // P0-R1: Mark any remaining open positions as unresolved inventory before saving/archiving
      const openPositions = daemon.getSnapshot().openPositions;
      if (openPositions.length > 0) {
        console.warn(
          `[PaperDaemon] [SHUTDOWN_UNRESOLVED] Converting ${openPositions.length} active position(s) to unresolved inventory due to termination signal interruption...`,
        );
        for (const pos of openPositions) {
          daemon.markPositionUnresolved(pos.positionId, "TERMINATION_SIGNAL_INTERRUPTION", nowMs());
        }
      }

      const snap = daemon.getSnapshot();
      console.log(
        `[PaperDaemon] Final Equity: ${snap.currentPortfolioSol.toFixed(4)} SOL | Closed Trades: ${snap.closedTrades.length} | Unresolved Positions: ${snap.unresolvedPositions?.length ?? 0}`,
      );
      try {
        persistState(true, true);
        archiveSession();
      } catch (shutdownErr) {
        console.error(
          "[PaperDaemon] [FATAL] Persistence or archive failed during shutdown:",
          shutdownErr,
        );
        process.exit(1);
      } finally {
        releaseProcessLock(processLockHandle);
      }
      const report = tracker.generateReport(config.initialPortfolioSol, snap.currentPortfolioSol);
      console.log(
        `[PaperDaemon] Counterfactual Summary: Observed=${report.totalCandidatesObserved}, Executed=${report.executedBuysCount}, MissedWinners=${report.missedWinnersCount}, AvoidedRugs=${report.avoidedRugsCount}`,
      );
      process.exit(0);
    };

    process.on("SIGINT", handleShutdown);
    process.on("SIGTERM", handleShutdown);

    // Cashout Helper (Fetches live DexScreener spot prices before closing; handles missing feeds safely via P0-A)
    const cashoutAllPositions = async (
      reason: "SCHEDULE_WINDOW_CONCLUDED" | "SESSION_DURATION_CASHOUT" | "CIRCUIT_BREAKER_CASHOUT",
    ): Promise<void> => {
      const currentNow = nowMs();
      const openPositions = daemon.getSnapshot().openPositions;
      if (openPositions.length === 0) return;

      await Promise.all(
        openPositions.map(async (pos) => {
          try {
            let exitPrice = 0;
            try {
              const freshSpot = await fetchDexScreenerSpotInfo(pos.mintAddress);
              if (freshSpot && freshSpot.spotPriceSol > 0) {
                exitPrice = freshSpot.spotPriceSol;
                pos.lastValidPriceObservedAtMs = currentNow;
              }
            } catch {
              // failed to fetch fresh price
            }

            // P0-2: Require strict freshness (<= 30s) based on dedicated lastValidPriceObservedAtMs
            const MAX_CASHOUT_PRICE_AGE_MS = 30_000;
            const priceAgeMs = pos.lastValidPriceObservedAtMs
              ? currentNow - pos.lastValidPriceObservedAtMs
              : currentNow - pos.lastActivityMs;
            const isPosSpotFresh =
              exitPrice <= 0 && pos.spotPriceSol > 0 && priceAgeMs <= MAX_CASHOUT_PRICE_AGE_MS;
            if (isPosSpotFresh) {
              exitPrice = pos.spotPriceSol;
            }

            if (exitPrice <= 0 || !Number.isFinite(exitPrice)) {
              // P0-A & P0-2: Never substitute entry price or record zero-proceeds sale. Keep position unresolved!
              const reasonForMissingData =
                priceAgeMs > MAX_CASHOUT_PRICE_AGE_MS
                  ? `STALE_PRICE_FEED_AT_CASHOUT_${Math.round(priceAgeMs / 1000)}S_OLD`
                  : "MISSING_PRICE_FEED_AT_CASHOUT";
              daemon.markPositionUnresolved(pos.positionId, reasonForMissingData, currentNow);
              const timeStr = new Date(currentNow).toLocaleTimeString();
              addActivityLog(
                "CONTROL",
                `⚠️ ${pos.symbol ?? pos.mintAddress.slice(0, 6)} marked UNRESOLVED at ${timeStr} (${reasonForMissingData}) | 0 wallet cash credited`,
                pos.mintAddress,
                pos.symbol,
              );
              console.warn(
                `[PaperDaemon] [UNRESOLVED_POSITION] ${pos.mintAddress} has no valid fresh price feed at cashout (${reasonForMissingData}). Marked unresolved with 0 SOL cash credited.`,
              );
              return;
            }

            daemon.manualExit(pos.positionId, exitPrice, currentNow, reason);
            const timeStr = new Date(currentNow).toLocaleTimeString();
            addActivityLog(
              "SELL",
              `🔴 ${pos.symbol ?? pos.mintAddress.slice(0, 6)} closed at session cashout at ${timeStr} | Exit: ${reason}`,
              pos.mintAddress,
              pos.symbol,
            );
            console.log(
              `[PaperDaemon] [${reason}] Liquidated ${pos.symbol ?? pos.mintAddress} at ${exitPrice} SOL`,
            );
          } catch (cashoutErr) {
            console.error(`[PaperDaemon] Error cashing out ${pos.mintAddress}:`, cashoutErr);
          }
        }),
      );
    };

    // Shared state between Position Ticker and Discovery Loop
    let isStandby = false;
    let minutesUntilNextWindow = 0;

    // LOOP A: High-Frequency Position Monitor Ticker (every pollIntervalMs, default 1500ms)
    const runPositionMonitorTicker = async (): Promise<void> => {
      while (!terminating) {
        const currentNow = nowMs();
        daemon.heartbeat(currentNow);

        if (config.tradingSchedule) {
          const scheduleCheck = isWithinTradingSchedule(currentNow, config.tradingSchedule);
          isStandby = !scheduleCheck.isWithin;
          minutesUntilNextWindow = scheduleCheck.minutesUntilNext;

          if (!isStandby) {
            hasEnteredActiveSchedule = true;
            activeTradingMs += currentNow - lastActiveTickMs;
            lastActiveTickMs = currentNow;

            if (wasInStandby) {
              wasInStandby = false;
              console.log(
                `[PaperDaemon] [ACTIVE] Trading window active (${config.tradingSchedule.rawString})! Radar scanning and buy gates re-engaged.`,
              );
              addActivityLog(
                "CONTROL",
                `🟢 Trading window active (${config.tradingSchedule.rawString}). Radar scanning and buy gates re-engaged.`,
              );
            }
          } else {
            lastActiveTickMs = currentNow;

            // Auto-cashout if the active schedule window has just concluded
            if (hasEnteredActiveSchedule) {
              console.log(
                `[PaperDaemon] [SCHEDULE_WINDOW_CONCLUDED] Scheduled trading window (${config.tradingSchedule.rawString}) has concluded. Executing end-of-schedule cashout...`,
              );
              await cashoutAllPositions("SCHEDULE_WINDOW_CONCLUDED");
              daemon.stop("SCHEDULE_WINDOW_CONCLUDED");
              terminating = true;
              break;
            }

            if (!wasInStandby) {
              wasInStandby = true;
              lastStandbyLogMs = currentNow;
              console.log(
                `[PaperDaemon] [STANDBY] Outside trading window (${config.tradingSchedule.rawString}). Standby active. Next window in ${minutesUntilNextWindow}m. Radar scanning and new entries paused.`,
              );
              addActivityLog(
                "CONTROL",
                `⏸️ Standby active: Outside trading window (${config.tradingSchedule.rawString}). Next window in ${minutesUntilNextWindow}m.`,
              );
            } else if (currentNow - lastStandbyLogMs >= 15 * 60 * 1000) {
              lastStandbyLogMs = currentNow;
              console.log(
                `[PaperDaemon] [STANDBY] Outside trading window (${config.tradingSchedule.rawString}). Standby active. Next window in ${minutesUntilNextWindow}m.`,
              );
            }
          }
        }

        const effectiveElapsedMs = config.tradingSchedule ? activeTradingMs : currentNow - startMs;
        if (effectiveElapsedMs >= maxDurationMs) {
          console.log(
            `[PaperDaemon] Active duration of ${config.durationHours} hours reached. Executing end-of-session cashout...`,
          );
          await cashoutAllPositions("SESSION_DURATION_CASHOUT");
          daemon.stop("DURATION_ELAPSED");
          terminating = true;
          break;
        }

        const snap = daemon.getSnapshot();
        if (snap.status === "HALTED" && !config.uninterruptedResearchMode) {
          console.error(`[PaperDaemon] Daemon halted due to: ${snap.haltReason}`);
          terminating = true;
          break;
        }

        // 1. Parallel Tick Open Positions with Live DexScreener Prices (Phase 12.93 High-Frequency Monitor)
        if (snap.openPositions.length > 0) {
          const openPosWithSpots = await Promise.all(
            snap.openPositions.map(async (pos) => {
              try {
                const spotInfo = await fetchDexScreenerSpotInfo(pos.mintAddress);
                return { pos, spotInfo };
              } catch {
                return { pos, spotInfo: null };
              }
            }),
          );

          for (const { pos, spotInfo } of openPosWithSpots) {
            try {
              if (!spotInfo || !spotInfo.spotPriceSol || spotInfo.spotPriceSol <= 0) {
                // P0-B: Missing or failed price feed is an external data outage, NOT market stagnation
                daemon.recordFeedOutageTick(pos.positionId, currentNow);
                continue;
              }

              tracker.samplePrice(pos.mintAddress, spotInfo.spotPriceSol, currentNow);

              const prevPrice = pos.spotPriceSol;
              const singleTickDropBps =
                prevPrice > 0
                  ? Math.round(((spotInfo.spotPriceSol - prevPrice) / prevPrice) * 10_000)
                  : 0;

              const isVolumeStalled =
                spotInfo.recentTransactionsCount === 0 ||
                (spotInfo.recentBuys60s === 0 && spotInfo.recentSells60s === 0);

              const marketContext: MarketEvaluationContext = {
                currentTimestampMs: currentNow,
                spotPriceSol: spotInfo.spotPriceSol,
                lpIntact: true,
                recentBuysCount60s: spotInfo.recentBuys60s,
                recentSellsCount60s: spotInfo.recentSells60s,
                momentum5mBps: spotInfo.momentum5mBps,
                volumeStalled3m: isVolumeStalled,
                singleTickDropBps,
              };

              const result = daemon.tickPosition(pos.positionId, marketContext, currentNow);
              if (result?.action === "SELL_ALL") {
                const timeStr = new Date(currentNow).toLocaleTimeString();
                const usdPrice = (
                  spotInfo.spotPriceUsd !== null && spotInfo.spotPriceUsd > 0
                    ? spotInfo.spotPriceUsd
                    : spotInfo.spotPriceSol * 150
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
                  spotInfo.spotPriceUsd !== null && spotInfo.spotPriceUsd > 0
                    ? spotInfo.spotPriceUsd
                    : spotInfo.spotPriceSol * 150
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
                  spotInfo.spotPriceUsd !== null && spotInfo.spotPriceUsd > 0
                    ? spotInfo.spotPriceUsd
                    : spotInfo.spotPriceSol * 150
                ).toFixed(6);
                const peakGainPct = (result.diagnostics.peakGainBps ?? 0) / 10000;
                const trailBufferPct = peakGainPct >= 2.0 ? 10 : peakGainPct >= 1.0 ? 15 : 18;
                const floorPct = ((result.diagnostics.currentStopFloorBps ?? 0) / 100).toFixed(1);
                addActivityLog(
                  "RATCHET",
                  `🟡 ${pos.symbol ?? pos.mintAddress.slice(0, 6)} sold 25% at $${usdPrice} (+48.5% Tier 2) | Floor locked to Trailing Moonbag (${trailBufferPct}% buffer, Floor: +${floorPct}%)`,
                  pos.mintAddress,
                  pos.symbol,
                );
                console.log(
                  `[PaperDaemon] [TAKE PROFIT 25%] ${pos.mintAddress} | Reason: ${result.reasonCode} | Milestone +48.5% reached | Realized PnL: ${(result.diagnostics.currentPnlBps / 100).toFixed(2)}% | Moonbag Buffer: ${trailBufferPct}% | Floor: +${floorPct}%`,
                );
              }

              // Phase 12.92 / Phase 12.93 Deliverable 1: Momentum-Only Scale-In Pyramiding
              // P0-06: Strict guard preventing scale-in after any partial profit milestone has triggered
              const hasViralScaleInMomentum =
                spotInfo.recentBuys60s >= 15 &&
                spotInfo.recentBuys60s >= 2.0 * Math.max(1, spotInfo.recentSells60s) &&
                spotInfo.momentum5mBps >= 400;

              if (
                result?.action !== "SELL_ALL" &&
                pos.cohort === "ESTABLISHED" &&
                !pos.pyramided &&
                !pos.tier1ProfitTaken &&
                !pos.tier2ProfitTaken &&
                pos.currentPnlBps >= 700 &&
                daemon.getCurrentCashSol() > 0.5 &&
                hasViralScaleInMomentum
              ) {
                const currentCash = daemon.getCurrentCashSol();
                const walletScale = Math.min(1.25, Math.max(1.0, currentCash / 10.0));
                const establishedScaleInAmountSol = Math.min(
                  0.65,
                  Number((0.5 * walletScale).toFixed(2)),
                );
                const updatedPos = daemon.scaleInPosition(
                  pos.positionId,
                  establishedScaleInAmountSol,
                  spotInfo.spotPriceSol,
                  currentNow,
                );
                if (updatedPos) {
                  console.log(
                    `[PaperDaemon] [ESTABLISHED_PYRAMIDING_SCALE_IN] Added +${establishedScaleInAmountSol} SOL to ${pos.symbol ?? pos.mintAddress.slice(0, 6)} at ${spotInfo.spotPriceSol} SOL (+7% confirmation) | Blended Entry: ${updatedPos.entryPriceSol} SOL`,
                  );
                  addActivityLog(
                    "BUY",
                    `🟢 Scaled in +${establishedScaleInAmountSol} SOL to ${pos.symbol ?? pos.mintAddress.slice(0, 6)} at ${spotInfo.spotPriceSol.toFixed(6)} SOL [ESTABLISHED +7% breakout] | Blended entry: ${updatedPos.entryPriceSol.toFixed(6)} SOL`,
                    pos.mintAddress,
                    pos.symbol,
                  );
                }
              }

              // Micro-Cap Scale-In Pyramiding:
              if (
                result?.action !== "SELL_ALL" &&
                pos.cohort === "MICRO_CAP" &&
                !pos.pyramided &&
                !pos.tier1ProfitTaken &&
                !pos.tier2ProfitTaken &&
                pos.currentPnlBps >= 1000 &&
                daemon.getCurrentCashSol() > 0.5 &&
                hasViralScaleInMomentum
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
        }

        // 4. Heartbeat Telemetry Logging (Every 15s)
        if (currentNow - lastHeartbeatMs >= 15000) {
          lastHeartbeatMs = currentNow;
          const currentSnap = daemon.getSnapshot();
          const watchingCount = isStandby ? 0 : watchlistService.getActiveWatchingItems().length;
          const statusPrefix = isStandby ? `[STANDBY (Next in ${minutesUntilNextWindow}m)] ` : "";
          const elapsedLabel = config.tradingSchedule
            ? `Active: ${(activeTradingMs / 60000).toFixed(1)}m (Wall: ${((currentNow - startMs) / 60000).toFixed(1)}m)`
            : `Elapsed: ${((currentNow - startMs) / 60000).toFixed(1)}m`;
          console.log(
            `[PaperDaemon] [HEARTBEAT] ${statusPrefix}${elapsedLabel} | Open: ${currentSnap.openPositions.length}/${config.maxOpenPositions} | Radar: ${watchingCount} watching | Cash: ${currentSnap.currentPortfolioSol.toFixed(4)} SOL | Closed: ${currentSnap.closedTrades.length} | Realized PnL: ${currentSnap.totalRealizedPnlSol >= 0 ? "+" : ""}${currentSnap.totalRealizedPnlSol.toFixed(4)} SOL`,
          );
        }

        // 5. Persist Active Session State to File for Dashboard (Every 3s)
        if (currentNow - lastPersistMs >= 3000) {
          lastPersistMs = currentNow;
          persistState();
        }

        await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
      }
    };

    // LOOP B: Candidate Discovery, Metadata Enrichment & Buy Gates (Runs independently every 5000ms)
    const runDiscoveryAndRadarLoop = async (): Promise<void> => {
      while (!terminating) {
        if (isStandby || daemon.getSnapshot().status === "HALTED") {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        const currentNow = nowMs();

        // 2. Scan Candidate Pools & Ingest into Stage 1 Watchlist Radar
        if (!isStandby && currentNow - lastScanMs >= scanIntervalMs) {
          lastScanMs = currentNow;
          try {
            const rawPools = await streamEngine.fetchRawPools(25);
            const currentNowSec = Math.floor(currentNow / 1000);

            // A. Ingest into Watchlist Service
            for (const pool of rawPools) {
              const admitted = watchlistService.admitOrUpdate(pool, currentNowSec);
              const initialSolPrice = pool.spotPriceSol ?? 0;
              if (admitted) {
                if (admitted.status === "DROPPED") {
                  tracker.recordCandidate(
                    pool,
                    "FILTERED_REJECTED",
                    initialSolPrice,
                    currentNow,
                    admitted.rejectionReason ?? "EXPIRED_WATCHLIST_AGE",
                  );
                } else {
                  tracker.recordCandidate(pool, "WATCHLIST_RADAR", initialSolPrice, currentNow);
                }
              } else {
                tracker.recordCandidate(
                  pool,
                  "FILTERED_REJECTED",
                  initialSolPrice,
                  currentNow,
                  "FAILED_BASELINE_SCANNER_PRESCREEN",
                );
              }
            }

            // B. Birdeye Trending Poll (Every 2.5 minutes if budget permits and quota is not exhausted)
            if (
              !birdeyeDiscovery.isQuotaExhausted() &&
              birdeyeDiscovery.getBudgetTracker().canPollTrending(currentNow)
            ) {
              try {
                const trendingTokens = await birdeyeDiscovery.fetchTrendingTokens(20, currentNow);
                if (trendingTokens.length > 0 && !birdeyeDiscovery.isQuotaExhausted()) {
                  console.log(
                    `[PaperDaemon] [Birdeye] Fetched ${trendingTokens.length} trending tokens from Birdeye`,
                  );
                  for (const token of trendingTokens) {
                    if (streamEngine.isMintSeen(token.address)) continue;

                    // Deliverable 1: Real-Data Pre-Enrichment for Birdeye Trending (Zero Synthetic Defaults)
                    const dexRecord = await streamEngine.fetchDexScreenerTokenPair(token.address);
                    if (
                      !dexRecord ||
                      !dexRecord.spotPriceUsd ||
                      dexRecord.spotPriceUsd <= 0 ||
                      !dexRecord.liquidityUsd ||
                      dexRecord.liquidityUsd <= 0
                    ) {
                      tracker.recordCandidate(
                        {
                          poolId: `birdeye-trending-${token.address.slice(0, 8)}`,
                          mintAddress: token.address,
                          symbol: token.symbol ?? "UNKNOWN",
                          liquidityUsd: token.liquidity ?? 0,
                          marketCapUsd: 0,
                          spotPriceUsd: token.price ?? 0,
                        },
                        "FILTERED_REJECTED",
                        token.price ?? 0,
                        currentNow,
                        "FAILED_BIRDEYE_ENRICHMENT",
                      );
                      telemetryDecisions.recordDecision({
                        sessionId,
                        generationId: "gen-01-legacy-baseline",
                        mintAddress: token.address,
                        poolId: `birdeye-trending-${token.address.slice(0, 8)}`,
                        symbol: token.symbol ?? "UNKNOWN",
                        sourceTimestampMs: currentNow,
                        ingestionTimestampMs: currentNow,
                        decisionCohort: "FILTERED_REJECTED",
                        primaryRejectionReason: "FAILED_BIRDEYE_ENRICHMENT",
                        filterEvaluations: [
                          {
                            filterName: "DexScreenerEnrichment",
                            passed: false,
                            valueObserved: null,
                            threshold: null,
                            rejectionReason: "FAILED_BIRDEYE_ENRICHMENT",
                          },
                        ],
                        metricsSnapshot: {
                          tokenAgeSec: 0,
                          liquidityUsd: token.liquidity ?? null,
                          marketCapUsd: null,
                          lmcRatio: null,
                          lpBurnPct: null,
                          spotPriceUsd: token.price ?? null,
                          spotPriceSol: null,
                          volume5mUsd: null,
                          txCount5m: null,
                          buys5m: null,
                          sells5m: null,
                          metricProvenance: {
                            tokenAgeSec: "UNAVAILABLE",
                            liquidityUsd: token.liquidity ? "OBSERVED" : "UNAVAILABLE",
                            marketCapUsd: "UNAVAILABLE",
                            lmcRatio: "UNAVAILABLE",
                            lpBurnPct: "UNAVAILABLE",
                            spotPriceUsd: token.price ? "OBSERVED" : "UNAVAILABLE",
                            spotPriceSol: "UNAVAILABLE",
                            volume5mUsd: "UNAVAILABLE",
                            txCount5m: "UNAVAILABLE",
                            buys5m: "UNAVAILABLE",
                            sells5m: "UNAVAILABLE",
                          },
                        },
                        providerIdentity: "birdeye",
                      });
                      continue;
                    }

                    streamEngine.markMintSeen(token.address);
                    const evalResult = streamEngine.evaluatePool(dexRecord, currentNowSec);
                    if (evalResult.admitted) {
                      const admitted = watchlistService.admitOrUpdate(dexRecord, currentNowSec);
                      if (admitted && admitted.status !== "DROPPED") {
                        tracker.recordCandidate(
                          dexRecord,
                          "WATCHLIST_RADAR",
                          dexRecord.spotPriceSol ?? dexRecord.spotPriceUsd,
                          currentNow,
                        );
                      } else {
                        tracker.recordCandidate(
                          dexRecord,
                          "FILTERED_REJECTED",
                          dexRecord.spotPriceSol ?? dexRecord.spotPriceUsd,
                          currentNow,
                          admitted?.rejectionReason ?? "EXPIRED_WATCHLIST_AGE",
                        );
                      }
                    } else {
                      tracker.recordCandidate(
                        dexRecord,
                        "FILTERED_REJECTED",
                        dexRecord.spotPriceSol ?? dexRecord.spotPriceUsd,
                        currentNow,
                        evalResult.primaryRejectionReason,
                      );
                    }
                  }
                }
              } catch (birdeyeErr) {
                console.error("[PaperDaemon] Error fetching Birdeye trending tokens:", birdeyeErr);
              }
            }

            // B. Prune expired candidates
            const expiredCandidates = watchlistService.pruneExpired(currentNowSec);
            for (const expired of expiredCandidates) {
              armedPullbackCandidates.delete(expired.mintAddress);
              tracker.recordCandidate(
                expired,
                "FILTERED_REJECTED",
                0,
                currentNow,
                expired.rejectionReason ?? "EXPIRED_WATCHLIST_AGE",
              );
            }

            // Prune stale armed pullback candidates (> 120s)
            for (const [mint, state] of armedPullbackCandidates.entries()) {
              if (currentNow - state.armedAtMs > 120_000) {
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

                  const spotInfo = await fetchDexScreenerSpotInfo(
                    candidate.mintAddress,
                    candidate.poolId,
                  );
                  if (spotInfo && spotInfo.spotPriceSol && spotInfo.spotPriceSol > 0) {
                    try {
                      const normalize = (id: string) =>
                        id.replace(/^dexscreener-/, "").toLowerCase();
                      const isPoolMatch =
                        !spotInfo.actualResponsePoolId ||
                        normalize(spotInfo.actualResponsePoolId) === normalize(candidate.poolId);

                      if (isPoolMatch) {
                        telemetryObservations.recordObservation({
                          sessionId,
                          generationId: "gen-01-legacy-baseline",
                          mintAddress: candidate.mintAddress,
                          poolId: candidate.poolId,
                          sourceTimestampMs: spotInfo.sourceTimestampMs,
                          ingestionTimestampMs: spotInfo.responseReceivedMs ?? currentNow,
                          requestInitiatedMs: spotInfo.requestInitiatedMs,
                          responseReceivedMs: spotInfo.responseReceivedMs,
                          actualResponsePoolId: spotInfo.actualResponsePoolId,
                          derivationStatus:
                            spotInfo.rawProviderMetrics.txCount5m !== null
                              ? "DIRECT_OBSERVATION"
                              : "DERIVED_FROM_5M",
                          measurementWindow: {
                            windowStartMs:
                              spotInfo.sourceTimestampMs -
                              spotInfo.rawProviderMetrics.measurementWindowSec * 1000,
                            windowEndMs: spotInfo.sourceTimestampMs,
                            durationSec: spotInfo.rawProviderMetrics.measurementWindowSec,
                          },
                          providerIdentity: "dexscreener",
                          priceMetrics: {
                            spotPriceUsd: spotInfo.spotPriceUsd,
                            spotPriceSol: spotInfo.spotPriceSol,
                            priceSource: "INDEXED_TICK",
                          },
                          liquidityMetrics: {
                            baseReserve: spotInfo.rawProviderMetrics.baseReserve,
                            quoteReserve: spotInfo.rawProviderMetrics.quoteReserve,
                            liquidityUsd: spotInfo.rawProviderMetrics.liquidityUsd,
                          },
                          flowMetrics: {
                            txCount: spotInfo.rawProviderMetrics.txCount5m,
                            buys: spotInfo.rawProviderMetrics.buys5m,
                            sells: spotInfo.rawProviderMetrics.sells5m,
                            volumeUsd: spotInfo.rawProviderMetrics.volume5mUsd,
                            netBuyerVolumeUsd: null,
                          },
                        });
                        telemetrySampling.updateObservation(
                          StratifiedSamplingController.buildTrackerKey(
                            "gen-01-legacy-baseline",
                            sessionId,
                            candidate.poolId,
                            candidate.mintAddress,
                          ),
                          spotInfo.spotPriceSol,
                          currentNow,
                        );
                      }
                    } catch (obsErr) {
                      console.warn("[PaperDaemon] Failed to record market observation:", obsErr);
                    }
                  }
                  if (!spotInfo || !spotInfo.spotPriceSol || spotInfo.spotPriceSol <= 0) {
                    recordTriggerRejection(
                      candidate,
                      "REJECTED_NO_ACTIVE_DEX_PAIR",
                      null,
                      null,
                      candidate.liquidityUsd,
                      null,
                      null,
                      "DexPairActive",
                      currentNow,
                      null,
                    );
                    continue;
                  }

                  // Fetch RugCheck anti-bundler metrics (bundler ratio, top10 concentration, holder count)
                  const rugMetrics = await BuyGateTriggerService.fetchRugCheckMetrics(
                    candidate.mintAddress,
                  );

                  // Deliverable 2: Live Spot Liquidity Hard Floor at Execution Time & Verified Holder Floor
                  // Phase 12.91: Include Graduated Viral Runner (CHROME Exception)
                  const isViral =
                    candidate.liquidityUsd >= 30000 &&
                    candidate.marketCapUsd >= 150000 &&
                    candidate.assetAgeSeconds >= 900 &&
                    candidate.assetAgeSeconds <= 7200;
                  const isCandidateEstablished =
                    ((candidate.liquidityUsd >= 50000 && candidate.assetAgeSeconds >= 1800) ||
                      isViral) &&
                    candidate.assetAgeSeconds <= 7200 &&
                    rugMetrics?.holdersCount !== undefined &&
                    rugMetrics.holdersCount >= (isViral ? 1000 : 250);
                  const requiredLiveLiq = isCandidateEstablished
                    ? isViral
                      ? 30000
                      : 50000
                    : 20000;
                  const liveLiqUsd = spotInfo.liquidityUsd ?? 0;
                  if (liveLiqUsd < requiredLiveLiq) {
                    if (armedPullbackCandidates.has(candidate.mintAddress)) {
                      armedPullbackCandidates.delete(candidate.mintAddress);
                    }
                    watchlistService.updateStatus(candidate.poolId, "DROPPED");
                    recordTriggerRejection(
                      candidate,
                      "REJECTED_INSUFFICIENT_LIVE_LIQUIDITY",
                      spotInfo.spotPriceSol,
                      spotInfo.spotPriceUsd,
                      liveLiqUsd,
                      spotInfo.recentBuys60s,
                      spotInfo.recentSells60s,
                      "LiveLiquidityFloor",
                      currentNow,
                      spotInfo,
                    );
                    console.log(
                      `[PaperDaemon] [LIVE_LIQ_REJECTED] ${candidate.symbol} live liquidity $${liveLiqUsd.toFixed(0)} < $${requiredLiveLiq} required (${isCandidateEstablished ? "ESTABLISHED" : "MICRO_CAP"}). Dropping candidate.`,
                    );
                    continue;
                  }

                  // Phase 12.89: Fail-Closed RugCheck on all cohorts (requireVerifiedHolders: true)
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
                    requireVerifiedHolders: true,
                  });

                  if (!fullGateResult.triggered) {
                    if (armedPullbackCandidates.has(candidate.mintAddress)) {
                      armedPullbackCandidates.delete(candidate.mintAddress);
                    }
                    recordTriggerRejection(
                      candidate,
                      fullGateResult.rejectionReason ?? "REJECTED_BUY_GATE_UNTRIGGERED",
                      spotInfo.spotPriceSol,
                      spotInfo.spotPriceUsd,
                      liveLiqUsd,
                      spotInfo.recentBuys60s,
                      spotInfo.recentSells60s,
                      "BuyGateService",
                      currentNow,
                      spotInfo,
                    );
                    continue;
                  }

                  // Deliverable 4: Established Token Age Ceiling (Max 2 Hours / 7,200s, Min 30m / 1,800s, Min 250 Holders)
                  // Phase 12.91: Include Graduated Viral Runner (CHROME Exception)
                  const isCandidateViral =
                    candidate.liquidityUsd >= 30000 &&
                    candidate.marketCapUsd >= 150000 &&
                    candidate.assetAgeSeconds >= 900 &&
                    candidate.assetAgeSeconds <= 7200;
                  const isEstablished =
                    ((candidate.liquidityUsd >= 50000 &&
                      liveLiqUsd >= 50000 &&
                      candidate.assetAgeSeconds >= 1800) ||
                      (isCandidateViral && liveLiqUsd >= 30000)) &&
                    candidate.assetAgeSeconds <= 7200 &&
                    rugMetrics?.holdersCount !== undefined &&
                    rugMetrics.holdersCount >= (isCandidateViral ? 1000 : 250);

                  // Deliverable 5: Route Established & Micro-Cap Tokens Through Retest Gate
                  const armed = armedPullbackCandidates.get(candidate.mintAddress);
                  if (!armed) {
                    armedPullbackCandidates.set(candidate.mintAddress, {
                      mintAddress: candidate.mintAddress,
                      armedAtMs: currentNow,
                      peakPriceSol: spotInfo.spotPriceSol,
                      peakPriceUsd: spotInfo.spotPriceUsd ?? 0,
                      ticksObserved: 1,
                    });
                    const cohortLabel = isEstablished ? "ESTABLISHED" : "MICRO_CAP";
                    const targetWait = isEstablished
                      ? "4-8% pullback or consolidation"
                      : "10-18% pullback or consolidation";
                    console.log(
                      `[PaperDaemon] [ARMED_PULLBACK] Armed ${candidate.symbol} (${candidate.mintAddress}) at peak ${spotInfo.spotPriceSol} SOL ($${(spotInfo.spotPriceUsd ?? 0).toFixed(6)}) [${cohortLabel}]. Awaiting ${targetWait}...`,
                    );
                    addActivityLog(
                      "INFO",
                      `🎯 Armed ${candidate.symbol} at peak ${spotInfo.spotPriceSol.toFixed(6)} SOL [${cohortLabel}]. Awaiting retest/pullback...`,
                      candidate.mintAddress,
                      candidate.symbol,
                    );
                    continue;
                  }

                  // Candidate already armed: update ticks & peak price
                  const newPeakSol = Math.max(armed.peakPriceSol, spotInfo.spotPriceSol);
                  const newPeakUsd =
                    spotInfo.spotPriceSol >= armed.peakPriceSol
                      ? (spotInfo.spotPriceUsd ?? armed.peakPriceUsd)
                      : armed.peakPriceUsd;
                  const updatedArmed: ArmedPullbackState = {
                    ...armed,
                    peakPriceSol: newPeakSol,
                    peakPriceUsd: newPeakUsd,
                    ticksObserved: armed.ticksObserved + 1,
                  };
                  armedPullbackCandidates.set(candidate.mintAddress, updatedArmed);

                  // Cohort parameters for Retest Gate (Phase 12.92 Flow-Aware Retest Gate):
                  // Established: Flow-aware crater drop ceiling: 12% if buyers absorbing (>= 1.15x), 8% if unabsorbed.
                  // Micro-Cap: max 15% crater drop ceiling, 90s expiry.
                  const isFlowAbsorbing =
                    spotInfo.recentBuys60s >= 1.15 * Math.max(1, spotInfo.recentSells60s);
                  const maxCraterDropPct = isEstablished ? (isFlowAbsorbing ? 0.12 : 0.08) : 0.15;
                  const maxExpiryMs = isEstablished ? 120_000 : 90_000;

                  // Rule C: Plunged below crater threshold (anti-falling knife)
                  if (spotInfo.spotPriceSol < updatedArmed.peakPriceSol * (1 - maxCraterDropPct)) {
                    armedPullbackCandidates.delete(candidate.mintAddress);
                    watchlistService.updateStatus(candidate.poolId, "DROPPED");
                    const rejectReason = isEstablished
                      ? "REJECTED_EXCESSIVE_PULLBACK"
                      : "REJECTED_PULLBACK_CRATERED";
                    recordTriggerRejection(
                      candidate,
                      rejectReason,
                      spotInfo.spotPriceSol,
                      spotInfo.spotPriceUsd,
                      spotInfo.liquidityUsd,
                      spotInfo.recentBuys60s,
                      spotInfo.recentSells60s,
                      "RetestCraterDrop",
                      currentNow,
                      spotInfo,
                    );
                    console.log(
                      `[PaperDaemon] [ARMED_PULLBACK_${isEstablished ? "EXCESSIVE" : "CRATERED"}] ${candidate.symbol} plunged >${(maxCraterDropPct * 100).toFixed(0)}% from peak (${spotInfo.spotPriceSol} < ${(updatedArmed.peakPriceSol * (1 - maxCraterDropPct)).toFixed(6)} SOL). Dropping candidate.`,
                    );
                    addActivityLog(
                      "ALERT",
                      `⚠️ ${candidate.symbol} dropped: pullback >${(maxCraterDropPct * 100).toFixed(0)}% from peak (${spotInfo.spotPriceSol.toFixed(6)} SOL)`,
                      candidate.mintAddress,
                      candidate.symbol,
                    );
                    continue;
                  }

                  // Rule E: In-Flight Seller Surge (Anti-Cabal exit wave while awaiting pullback)
                  if (
                    spotInfo.recentSells60s >= 25 &&
                    spotInfo.recentSells60s >= 2.5 * Math.max(1, spotInfo.recentBuys60s)
                  ) {
                    armedPullbackCandidates.delete(candidate.mintAddress);
                    watchlistService.updateStatus(candidate.poolId, "DROPPED");
                    recordTriggerRejection(
                      candidate,
                      "REJECTED_IN_FLIGHT_SELLER_SURGE",
                      spotInfo.spotPriceSol,
                      spotInfo.spotPriceUsd,
                      spotInfo.liquidityUsd,
                      spotInfo.recentBuys60s,
                      spotInfo.recentSells60s,
                      "RetestSellerSurge",
                      currentNow,
                      spotInfo,
                    );
                    console.log(
                      `[Retest Gate] Disarmed ${candidate.symbol} due to seller surge while awaiting pullback (Sells60s: ${spotInfo.recentSells60s}, Buys60s: ${spotInfo.recentBuys60s})`,
                    );
                    addActivityLog(
                      "ALERT",
                      `⚠️ Disarmed ${candidate.symbol}: seller surge while awaiting pullback (${spotInfo.recentSells60s}S vs ${spotInfo.recentBuys60s}B)`,
                      candidate.mintAddress,
                      candidate.symbol,
                    );
                    continue;
                  }

                  // Rule D: Expiry after timeout
                  if (currentNow - updatedArmed.armedAtMs > maxExpiryMs) {
                    armedPullbackCandidates.delete(candidate.mintAddress);
                    watchlistService.updateStatus(candidate.poolId, "DROPPED");
                    recordTriggerRejection(
                      candidate,
                      "REJECTED_PULLBACK_EXPIRED",
                      spotInfo.spotPriceSol,
                      spotInfo.spotPriceUsd,
                      spotInfo.liquidityUsd,
                      spotInfo.recentBuys60s,
                      spotInfo.recentSells60s,
                      "RetestTimeout",
                      currentNow,
                      spotInfo,
                    );
                    console.log(
                      `[PaperDaemon] [ARMED_PULLBACK_EXPIRED] ${candidate.symbol} expired after ${(maxExpiryMs / 1000).toFixed(0)}s without entry confirmation. Dropping candidate.`,
                    );
                    continue;
                  }

                  // Rule A: Retest Pullback Discount with flow absorption
                  // Established: 4% to 10% pullback discount with recentBuys60s >= 1.15 * recentSells60s
                  // Micro-Cap: 10% to 15% pullback discount with recentBuys60s >= 1.25 * recentSells60s
                  const minPullbackRatio = isEstablished ? 0.9 : 0.85;
                  const maxPullbackRatio = isEstablished ? 0.96 : 0.9;
                  const minPullbackFlowRatio = isEstablished ? 1.15 : 1.25;

                  const isPullbackDiscount =
                    spotInfo.spotPriceSol <= updatedArmed.peakPriceSol * maxPullbackRatio &&
                    spotInfo.spotPriceSol >= updatedArmed.peakPriceSol * minPullbackRatio;
                  const hasPullbackFlow =
                    spotInfo.recentBuys60s >= minPullbackFlowRatio * spotInfo.recentSells60s;
                  const ruleAConfirmed = isPullbackDiscount && hasPullbackFlow;

                  // Rule B: Consolidation Breakout
                  // Established: within 4% of peak for >= 30s with buyer dominance (>= 1.25 * sells)
                  // Micro-Cap: within 5% of peak for >= 30s or >= 3 ticks with strong flow (>= 1.5 * sells)
                  const maxConsolidationDropPct = isEstablished ? 0.04 : 0.05;
                  const minConsolidationFlowRatio = isEstablished ? 1.25 : 1.5;

                  const isConsolidatingNearPeak =
                    spotInfo.spotPriceSol >=
                    updatedArmed.peakPriceSol * (1 - maxConsolidationDropPct);
                  const hasConsolidationDuration =
                    currentNow - updatedArmed.armedAtMs >= 30_000 ||
                    updatedArmed.ticksObserved >= 3;
                  const hasConsolidationFlow =
                    spotInfo.recentBuys60s >= minConsolidationFlowRatio * spotInfo.recentSells60s;
                  const ruleBConfirmed =
                    isConsolidatingNearPeak && hasConsolidationDuration && hasConsolidationFlow;

                  if (!ruleAConfirmed && !ruleBConfirmed) {
                    const pullbackPct = (
                      ((spotInfo.spotPriceSol - updatedArmed.peakPriceSol) /
                        updatedArmed.peakPriceSol) *
                      100
                    ).toFixed(1);
                    console.log(
                      `[PaperDaemon] [ARMED_PULLBACK_WAIT] ${candidate.symbol} [${isEstablished ? "ESTAB" : "MICRO"}] awaiting trigger | Spot: ${spotInfo.spotPriceSol} SOL (Peak: ${updatedArmed.peakPriceSol} SOL, Pullback: ${pullbackPct}%) | Flow: ${spotInfo.recentBuys60s}B/${spotInfo.recentSells60s}S | Ticks: ${updatedArmed.ticksObserved}`,
                    );
                    continue;
                  }

                  const confirmReason = ruleAConfirmed
                    ? "RETEST_PULLBACK_DISCOUNT"
                    : "CONSOLIDATION_BREAKOUT";
                  console.log(
                    `[PaperDaemon] [ARMED_PULLBACK_CONFIRMED] ${candidate.symbol} [${isEstablished ? "ESTABLISHED" : "MICRO_CAP"}] entry confirmed via ${confirmReason}! Spot: ${spotInfo.spotPriceSol} SOL (Peak: ${updatedArmed.peakPriceSol} SOL)`,
                  );
                  armedPullbackCandidates.delete(candidate.mintAddress);

                  const entryPriceSol = spotInfo.spotPriceSol;
                  const foundPoolRecord = rawPools.find(
                    (p) => p.mintAddress === candidate.mintAddress,
                  );

                  const targetPoolRecord: ScannedPoolRecord = foundPoolRecord ?? {
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
                    volume5mUsd: candidate.volume5mUsd ?? 0,
                    txCount5m: candidate.buys5m + candidate.sells5m,
                    buys5m: candidate.buys5m,
                    sells5m: candidate.sells5m,
                    spotPriceUsd:
                      spotInfo.spotPriceUsd !== null && spotInfo.spotPriceUsd > 0
                        ? spotInfo.spotPriceUsd
                        : spotInfo.spotPriceSol * 150,
                    spotPriceSol: spotInfo.spotPriceSol,
                    fetchedAt: new Date(currentNow).toISOString(),
                  };

                  const cohort: CohortTier = isEstablished ? "ESTABLISHED" : "MICRO_CAP";
                  const ratchetConfig = isEstablished
                    ? ESTABLISHED_DYNAMIC_RATCHET_CONFIG
                    : MICRO_CAP_DYNAMIC_RATCHET_CONFIG;

                  // Phase 12.93 Deliverable 4: Calibrated Probe Sizing (0.50 SOL Established, 0.35 SOL Micro)
                  const currentCash = daemon.getCurrentCashSol();
                  const walletScale = Math.min(1.25, Math.max(1.0, currentCash / 10.0));
                  const establishedProbeBaseSize = Math.min(
                    0.65,
                    Number((0.5 * walletScale).toFixed(2)),
                  );
                  const microProbeBaseSize = Math.min(
                    0.45,
                    Number((0.35 * walletScale).toFixed(2)),
                  );

                  let targetCohortSize = isEstablished
                    ? establishedProbeBaseSize
                    : microProbeBaseSize;
                  if (isEstablished) {
                    const highBundler =
                      rugMetrics?.bundlerPct !== undefined && rugMetrics.bundlerPct > 0.6;
                    const highTop10 =
                      rugMetrics?.top10HolderPct !== undefined && rugMetrics.top10HolderPct > 0.3;
                    if (highBundler || highTop10) {
                      targetCohortSize = Math.min(0.35, targetCohortSize);
                      console.log(
                        `[PaperDaemon] [ESTABLISHED_HIGH_RISK] Downsizing probe for ${candidate.symbol} to ${targetCohortSize} SOL (Bundlers: ${((rugMetrics?.bundlerPct ?? 0) * 100).toFixed(1)}%, Top10: ${((rugMetrics?.top10HolderPct ?? 0) * 100).toFixed(1)}%)`,
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
                    targetPoolRecord,
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
                    try {
                      const dec = telemetryDecisions.recordDecision({
                        sessionId,
                        generationId: "gen-01-legacy-baseline",
                        mintAddress: candidate.mintAddress,
                        poolId: candidate.poolId,
                        symbol: candidate.symbol,
                        sourceTimestampMs: currentNow,
                        ingestionTimestampMs: currentNow,
                        poolOpenTimeMs:
                          targetPoolRecord.openTimeSec > 0
                            ? targetPoolRecord.openTimeSec * 1000
                            : candidate.assetAgeSeconds > 0
                              ? currentNow - candidate.assetAgeSeconds * 1000
                              : undefined,
                        decisionCohort: "EXECUTED_BUY",
                        filterEvaluations: [],
                        metricsSnapshot: {
                          tokenAgeSec: candidate.assetAgeSeconds,
                          liquidityUsd:
                            spotInfo.rawProviderMetrics.liquidityUsd ??
                            (candidate.liquidityUsd > 0 ? candidate.liquidityUsd : null),
                          marketCapUsd: candidate.marketCapUsd,
                          lmcRatio: candidate.lmcRatio,
                          lpBurnPct: candidate.lpBurnPct ?? 100,
                          spotPriceUsd:
                            spotInfo.spotPriceUsd !== null && spotInfo.spotPriceUsd > 0
                              ? spotInfo.spotPriceUsd
                              : null,
                          spotPriceSol: entryPriceSol,
                          volume5mUsd:
                            spotInfo.rawProviderMetrics.volume5mUsd ??
                            candidate.volume5mUsd ??
                            null,
                          txCount5m: spotInfo.rawProviderMetrics.txCount5m ?? null,
                          buys5m: spotInfo.rawProviderMetrics.buys5m ?? null,
                          sells5m: spotInfo.rawProviderMetrics.sells5m ?? null,
                          metricProvenance: {
                            tokenAgeSec:
                              candidate.assetAgeSeconds > 0
                                ? (candidate.metricProvenance?.tokenAgeSec ?? "OBSERVED")
                                : "UNAVAILABLE",
                            liquidityUsd:
                              spotInfo.rawProviderMetrics.liquidityUsd !== null &&
                              spotInfo.rawProviderMetrics.liquidityUsd !== undefined
                                ? "OBSERVED"
                                : (candidate.metricProvenance?.liquidityUsd ??
                                  (candidate.liquidityUsd > 0 ? "OBSERVED" : "UNAVAILABLE")),
                            marketCapUsd:
                              candidate.metricProvenance?.marketCapUsd ??
                              (candidate.marketCapUsd > 0 ? "DERIVED" : "UNAVAILABLE"),
                            lmcRatio: candidate.marketCapUsd > 0 ? "DERIVED" : "UNAVAILABLE",
                            lpBurnPct:
                              candidate.metricProvenance?.lpBurnPct ??
                              (candidate.lpBurnPct !== undefined ? "OBSERVED" : "UNAVAILABLE"),
                            spotPriceUsd:
                              spotInfo.spotPriceUsd !== null && spotInfo.spotPriceUsd > 0
                                ? "OBSERVED"
                                : "UNAVAILABLE",
                            spotPriceSol: entryPriceSol > 0 ? "OBSERVED" : "UNAVAILABLE",
                            volume5mUsd:
                              spotInfo.rawProviderMetrics.volume5mUsd !== null &&
                              spotInfo.rawProviderMetrics.volume5mUsd !== undefined
                                ? "OBSERVED"
                                : (candidate.metricProvenance?.volume5mUsd ??
                                  (candidate.volume5mUsd !== undefined
                                    ? "DERIVED"
                                    : "UNAVAILABLE")),
                            txCount5m:
                              spotInfo.rawProviderMetrics.txCount5m !== null &&
                              spotInfo.rawProviderMetrics.txCount5m !== undefined
                                ? "OBSERVED"
                                : (candidate.metricProvenance?.txCount5m ?? "UNAVAILABLE"),
                            buys5m:
                              spotInfo.rawProviderMetrics.buys5m !== null &&
                              spotInfo.rawProviderMetrics.buys5m !== undefined
                                ? "OBSERVED"
                                : (candidate.metricProvenance?.buys5m ?? "UNAVAILABLE"),
                            sells5m:
                              spotInfo.rawProviderMetrics.sells5m !== null &&
                              spotInfo.rawProviderMetrics.sells5m !== undefined
                                ? "OBSERVED"
                                : (candidate.metricProvenance?.sells5m ?? "UNAVAILABLE"),
                          },
                        },
                        providerIdentity: candidate.poolId.startsWith("dexscreener")
                          ? "dexscreener"
                          : "raydium",
                      });
                      telemetrySampling.evaluateForTracking(dec, entryPriceSol);
                    } catch (tErr) {
                      console.warn("[PaperDaemon] Telemetry buy recording error:", tErr);
                    }
                    const timeStr = new Date(currentNow).toLocaleTimeString();
                    const usdStr = (
                      spotInfo.spotPriceUsd !== null && spotInfo.spotPriceUsd > 0
                        ? spotInfo.spotPriceUsd
                        : entryPriceSol * 150
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
        if (!isStandby && currentNow - lastWatchlistRefreshMs >= 10000) {
          lastWatchlistRefreshMs = currentNow;
          const itemsToRefresh = watchlistService.getItems();
          for (const item of itemsToRefresh) {
            try {
              const freshRecord = await streamEngine.fetchDexScreenerTokenPair(item.mintAddress);
              if (freshRecord) {
                const currentNowSec = Math.floor(currentNow / 1000);
                const updated = watchlistService.admitOrUpdate(freshRecord, currentNowSec);
                if (updated && updated.status === "DROPPED") {
                  tracker.recordCandidate(
                    updated,
                    "FILTERED_REJECTED",
                    freshRecord.spotPriceUsd ?? 0,
                    currentNow,
                    updated.rejectionReason ?? "EXPIRED_WATCHLIST_AGE",
                  );
                }
              }
            } catch {
              // ignore transient refresh errors
            }
          }
        }

        // 3. Counterfactual Price Sampler for Top Candidates across ALL cohorts (Every 15s)
        if (!isStandby && currentNow - lastRadarSampleMs >= 15000) {
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

        // 3b. Telemetry Follow-Up Scheduler for Stratified Trackers
        try {
          await telemetryFollowUp.pollPendingTrackers(currentNow);
        } catch (followUpErr) {
          console.warn("[PaperDaemon] Telemetry follow-up polling error:", followUpErr);
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };

    // Run Position Monitor Ticker and Candidate Discovery Loop concurrently
    await Promise.all([runPositionMonitorTicker(), runDiscoveryAndRadarLoop()]);

    // P0-R1: Convert any open positions left at normal conclusion into unresolved inventory
    const remainingOpen = daemon.getSnapshot().openPositions;
    if (remainingOpen.length > 0) {
      console.warn(
        `[PaperDaemon] [SESSION_END_UNRESOLVED] Converting ${remainingOpen.length} remaining open position(s) to unresolved inventory at session completion...`,
      );
      for (const pos of remainingOpen) {
        daemon.markPositionUnresolved(pos.positionId, "UNRESOLVED_AT_SESSION_END", nowMs());
      }
    }

    const finalSnap = daemon.getSnapshot();
    console.log(`[PaperDaemon] Session finished with status: ${finalSnap.status}`);
    persistState(true, true);
    archiveSession();

    const finalReport = tracker.generateReport(
      config.initialPortfolioSol,
      finalSnap.currentPortfolioSol,
    );
    console.log(
      `[PaperDaemon] Final Report: Observed=${finalReport.totalCandidatesObserved}, Executed=${finalReport.executedBuysCount}, MissedWinners=${finalReport.missedWinnersCount}, AvoidedRugs=${finalReport.avoidedRugsCount}`,
    );

    try {
      telemetryStorage.finalizeSessionTelemetry(sessionId, {
        generationId: "gen-01-legacy-baseline",
        strategyRevision: telemetryMeta.strategyRevision,
        startedAtIso: telemetryMeta.startedAtIso,
        totalCandidatesScreened: streamEngine.getStats().totalEvaluationsAttempted,
        totalScannerDecisionsRecorded: telemetryDecisions.getScannerDecisionsCount(),
        totalTriggerDecisionsRecorded: telemetryDecisions.getTriggerDecisionsCount(),
        totalExecutedBuyDecisionsRecorded: telemetryDecisions.getExecutedBuyDecisionsCount(),
        totalDecisionsRecorded: telemetryDecisions.getTotalDecisionsCount(),
        decisionWriteFailures: telemetryStorage.getDecisionWriteFailuresCount(),
        decisionCallbackErrors: streamEngine.getStats().decisionCallbackErrors,
        rateShedCount: telemetryRate.getShedCount(),
        cohortBreakdown: {
          filteredRejected: telemetryDecisions.getCohortCount("FILTERED_REJECTED"),
          watchlistRadar: telemetryDecisions.getCohortCount("WATCHLIST_RADAR"),
          triggerRejected: telemetryDecisions.getCohortCount("TRIGGER_REJECTED"),
          executedBuy: telemetryDecisions.getCohortCount("EXECUTED_BUY"),
        },
        topRejectionReasons: telemetryDecisions.getRejectionReasonBreakdown(),
        totalMarketObservationsRecorded: telemetryStorage.getMarketObservationsCount(),
        totalStratifiedCandidatesTracked: telemetrySampling.getTotalEverTrackedCount(),
        missedWinnersCount: finalReport.missedWinnersCount,
        avoidedRugsCount: finalReport.avoidedRugsCount,
        isCompleteSession: !telemetryMeta.isInterruptedSession,
        isInterruptedSession: !!telemetryMeta.isInterruptedSession,
      });
      console.log(`[PaperDaemon] Telemetry session summary finalized for ${sessionId}`);
    } catch (telemetryErr) {
      console.warn("[PaperDaemon] Failed to finalize session telemetry summary:", telemetryErr);
    }
  } catch (finalArchiveErr) {
    console.error(
      "[PaperDaemon] [FATAL] Persistence, archive, or runtime error in session:",
      finalArchiveErr,
    );
    process.exit(1);
  } finally {
    releaseProcessLock(processLockHandle);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  void run();
}
