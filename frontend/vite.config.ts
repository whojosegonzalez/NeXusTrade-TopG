import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

interface RawPositionRatchetState {
  peakGainBps?: number;
  currentStopFloorBps?: number;
  activeTier?: string;
  drawdownState?: string;
}

interface RawDaemonPosition {
  positionId: string;
  mintAddress: string;
  entryPriceSol: number;
  spotPriceSol: number;
  currentPnlBps: number;
  openedAtMs: number;
  ratchetState?: RawPositionRatchetState;
}

interface RawDaemonTrade {
  positionId: string;
  mintAddress: string;
  entryPriceSol: number;
  exitPriceSol: number;
  costBasisSol: number;
  proceedsSol: number;
  realizedPnlSol: number;
  realizedPnlBps: number;
  exitReason: string;
  openedAtMs: number;
  closedAtMs: number;
}

interface RawDaemonSnapshot {
  sessionId?: string;
  status?: string;
  haltReason?: string;
  initialPortfolioSol?: number;
  currentPortfolioSol?: number;
  totalRealizedPnlSol?: number;
  totalUnrealizedPnlSol?: number;
  startedAtMs?: number;
  lastTickAtMs?: number;
  openPositions?: RawDaemonPosition[];
  closedTrades?: RawDaemonTrade[];
  netSessionPnlSol?: number;
  watchlist?: unknown[];
}

function nexusDevApiPlugin(): Plugin {
  return {
    name: "nexus-dev-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";

        if (url === "/api/session/active") {
          const rootTmp = path.resolve(process.cwd(), "../.tmp/paper-session-active.json");
          const backendTmp = path.resolve(
            process.cwd(),
            "../backend/.tmp/paper-session-active.json",
          );
          const localTmp = path.resolve(process.cwd(), ".tmp/paper-session-active.json");
          const target = [localTmp, rootTmp, backendTmp].find((p) => fs.existsSync(p));

          if (target) {
            try {
              const raw = JSON.parse(fs.readFileSync(target, "utf8")) as RawDaemonSnapshot;
              if (raw.netSessionPnlSol !== undefined && Array.isArray(raw.watchlist)) {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(raw));
                return;
              }

              // Transform raw PaperTradingDaemonSnapshot into ActiveSessionTelemetry
              const initial = raw.initialPortfolioSol || 10.0;
              const current = raw.currentPortfolioSol || initial;
              const realized = raw.totalRealizedPnlSol || 0;
              const unrealized = raw.totalUnrealizedPnlSol || 0;
              const netPnlSol = current - initial;
              const netPnlPct = (netPnlSol / initial) * 100;
              const closedTrades = raw.closedTrades || [];
              const wins = closedTrades.filter(
                (t: RawDaemonTrade) => t.realizedPnlBps >= 100,
              ).length;
              const losses = closedTrades.filter(
                (t: RawDaemonTrade) => t.realizedPnlBps < -100,
              ).length;
              const scratches = closedTrades.length - wins - losses;
              const now = raw.lastTickAtMs || Date.now();
              const start = raw.startedAtMs || now;
              const elapsed = Math.floor((now - start) / 1000);

              const openPositions = (raw.openPositions || []).map((p: RawDaemonPosition) => ({
                positionId: p.positionId,
                poolId: p.positionId,
                mintAddress: p.mintAddress,
                symbol: p.mintAddress.slice(0, 4) + "..." + p.mintAddress.slice(-4),
                entryPriceSol: p.entryPriceSol,
                spotPriceSol: p.spotPriceSol,
                currentPnlBps: p.currentPnlBps,
                peakGainBps: p.ratchetState?.peakGainBps ?? 0,
                currentStopFloorBps: p.ratchetState?.currentStopFloorBps ?? -800,
                activeTier: p.ratchetState?.activeTier ?? "HARD_STOP",
                drawdownState: p.ratchetState?.drawdownState ?? "NORMAL",
                openedAt: new Date(p.openedAtMs).toISOString(),
                holdDurationSeconds: Math.floor((now - p.openedAtMs) / 1000),
              }));

              const logs = closedTrades.map((t: RawDaemonTrade) => ({
                timestamp: t.closedAtMs || now,
                type: t.realizedPnlSol >= 0 ? "RATCHET" : "SELL",
                message: `${t.exitReason}: ${t.mintAddress.slice(0, 8)}... closed at ${t.exitPriceSol} SOL (${(t.realizedPnlBps / 100).toFixed(2)}%)`,
              }));

              const telemetry = {
                sessionId: raw.sessionId || "session-paper",
                status: raw.status || "HALTED",
                haltReason: raw.haltReason,
                startedAtMs: start,
                durationHours: 1,
                elapsedSeconds: elapsed,
                initialPortfolioSol: initial,
                currentPortfolioSol: current,
                realizedPnlSol: realized,
                unrealizedPnlSol: unrealized,
                netSessionPnlSol: netPnlSol,
                netSessionPnlPct: netPnlPct,
                openPositionCount: openPositions.length,
                maxConcurrentPositions: 3,
                closedTradesCount: closedTrades.length,
                winsCount: wins,
                lossesCount: losses,
                scratchesCount: scratches,
                openPositions,
                watchlist: [],
                recentActivityLogs: logs,
              };

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(telemetry));
              return;
            } catch (readErr) {
              void readErr;
            }
          }
        }

        if (url.startsWith("/api/wallet/telemetry")) {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              solBalance: 10.0,
              deployableSol: 9.95,
              tokens: [],
              signatureReady: true,
              fetchedAt: new Date().toISOString(),
            }),
          );
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), nexusDevApiPlugin()],
  test: {
    environment: "jsdom",
    setupFiles: "./src/setupTests.ts",
  },
});
