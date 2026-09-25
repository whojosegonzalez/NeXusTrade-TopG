import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PaperTradingDaemon, type PaperTradingDaemonConfig } from "../paper/PaperTradingDaemon.js";
import { CandidateStreamEngine } from "../candidate-scanner/CandidateStreamEngine.js";
import { CANDIDATE_SCANNER_DEFAULTS } from "../candidate-scanner/CandidateScannerConfig.js";
import type { MarketEvaluationContext } from "../exits/DynamicRatchetTypes.js";
import { nowMs } from "../db/utils/timestamps.js";

function parseCliArgs(): PaperTradingDaemonConfig {
  const { values } = parseArgs({
    options: {
      "session-id": { type: "string" },
      "duration-hours": { type: "string" },
      "max-positions": { type: "string" },
      "position-size-sol": { type: "string" },
      "dry-run": { type: "boolean" },
    },
    strict: false,
  });

  const rawDuration = values["duration-hours"];
  const durationHours = typeof rawDuration === "string" ? parseFloat(rawDuration) : 6;

  const rawMaxPos = values["max-positions"];
  const maxOpenPositions = typeof rawMaxPos === "string" ? parseInt(rawMaxPos, 10) : 3;

  const rawSize = values["position-size-sol"];
  const positionSizeSol = typeof rawSize === "string" ? parseFloat(rawSize) : 1.0;

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
    initialPortfolioSol: 10.0,
    maxPortfolioDrawdownBps: -500, // -5.0%
    maxConsecutiveErrors: 3,
    maxClockDriftMs: 5000,
    pollIntervalMs: 2000,
    dryRun,
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
        priceChange?: { m5?: number };
      }>;
    };
    const pairs = body.pairs ?? [];
    if (pairs.length === 0) return null;
    const solPair = pairs.find((p) => p.quoteToken?.symbol === "SOL") ?? pairs[0];
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

  const daemon = new PaperTradingDaemon({ config });
  daemon.start();

  const streamEngine = new CandidateStreamEngine({
    config: config.scannerConfig ?? CANDIDATE_SCANNER_DEFAULTS,
  });

  const startMs = nowMs();
  const maxDurationMs = config.durationHours * 3600 * 1000;
  let lastScanMs = 0;
  let lastHeartbeatMs = 0;
  let lastPersistMs = 0;
  const scanIntervalMs = 5000;

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
    try {
      if (!existsSync(".tmp")) mkdirSync(".tmp", { recursive: true });
      writeFileSync(".tmp/paper-session-active.json", JSON.stringify(snap, null, 2), "utf8");
    } catch (err) {
      void err;
    }
    process.exit(0);
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  // In daemon mode, tick and monitor until duration elapsed
  while (!terminating) {
    const currentNow = nowMs();
    const elapsed = currentNow - startMs;
    if (elapsed >= maxDurationMs) {
      console.log(`[PaperDaemon] Duration of ${config.durationHours} hours reached. Completing.`);
      daemon.stop("DURATION_ELAPSED");
      break;
    }

    const snap = daemon.getSnapshot();
    if (snap.status === "HALTED") {
      console.error(`[PaperDaemon] Daemon halted due to: ${snap.haltReason}`);
      break;
    }

    // 1. Tick Open Positions with Live DexScreener Prices
    for (const pos of snap.openPositions) {
      try {
        const spotInfo = await fetchDexScreenerSpotInfo(pos.mintAddress);
        if (!spotInfo) continue;

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
          console.log(
            `[PaperDaemon] [SELL EXECUTED] ${pos.mintAddress} | Reason: ${result.reasonCode} | Realized PnL: ${(result.diagnostics.currentPnlBps / 100).toFixed(2)}%`,
          );
        }
      } catch (tickErr) {
        console.error(`[PaperDaemon] Tick error on ${pos.mintAddress}:`, tickErr);
      }
    }

    // 2. Scan Candidate Pools from Raydium if Capacity Available
    if (currentNow - lastScanMs >= scanIntervalMs) {
      lastScanMs = currentNow;
      if (daemon.getSnapshot().openPositions.length < config.maxOpenPositions) {
        try {
          const rawPools = await streamEngine.fetchRawPools(25);
          for (const pool of rawPools) {
            if (daemon.getSnapshot().openPositions.length >= config.maxOpenPositions) break;
            const spotInfo = await fetchDexScreenerSpotInfo(pool.mintAddress);
            const entryPriceSolOverride = spotInfo?.spotPriceSol;
            const admitted = daemon.processScannedPool(pool, currentNow, entryPriceSolOverride);
            if (admitted) {
              console.log(
                `[PaperDaemon] [BUY EXECUTED] ${pool.symbol} (${pool.mintAddress}) | Entry: ${entryPriceSolOverride ? `${entryPriceSolOverride} SOL` : `$${pool.spotPriceUsd}`} | Cost Basis: ${config.positionSizeSol} SOL`,
              );
            }
          }
        } catch (scanErr) {
          console.error("[PaperDaemon] Scan error:", scanErr);
        }
      }
    }

    // 3. Heartbeat Telemetry Logging
    if (currentNow - lastHeartbeatMs >= 15000) {
      lastHeartbeatMs = currentNow;
      const currentSnap = daemon.getSnapshot();
      console.log(
        `[PaperDaemon] [HEARTBEAT] Elapsed: ${((currentNow - startMs) / 60000).toFixed(1)}m | Open: ${currentSnap.openPositions.length}/${config.maxOpenPositions} | Cash: ${currentSnap.currentPortfolioSol.toFixed(4)} SOL | Closed Trades: ${currentSnap.closedTrades.length} | Realized PnL: ${currentSnap.totalRealizedPnlSol >= 0 ? "+" : ""}${currentSnap.totalRealizedPnlSol.toFixed(4)} SOL`,
      );
    }

    // 4. Persist Active Session State to File for Real-Time Inspection & Dashboard
    if (currentNow - lastPersistMs >= 3000) {
      lastPersistMs = currentNow;
      try {
        if (!existsSync(".tmp")) mkdirSync(".tmp", { recursive: true });
        writeFileSync(
          ".tmp/paper-session-active.json",
          JSON.stringify(daemon.getSnapshot(), null, 2),
          "utf8",
        );
      } catch (err) {
        void err;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }

  const finalSnap = daemon.getSnapshot();
  console.log(`[PaperDaemon] Session finished with status: ${finalSnap.status}`);
  try {
    if (!existsSync(".tmp")) mkdirSync(".tmp", { recursive: true });
    writeFileSync(".tmp/paper-session-active.json", JSON.stringify(finalSnap, null, 2), "utf8");
  } catch (err) {
    void err;
  }
}

void run();
