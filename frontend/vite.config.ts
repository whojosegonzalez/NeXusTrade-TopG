import { spawn } from "node:child_process";
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
  symbol?: string;
  entryPriceSol: number;
  spotPriceSol: number;
  currentPnlBps: number;
  openedAtMs: number;
  ratchetState?: RawPositionRatchetState;
}

interface RawDaemonTrade {
  positionId: string;
  mintAddress: string;
  symbol?: string;
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
  maxOpenPositions?: number;
  durationHours?: number;
  recentActivityLogs?: Array<{
    timestamp: number;
    type: string;
    message: string;
    symbol?: string;
    mintAddress?: string;
  }>;
}

function nexusDevApiPlugin(): Plugin {
  return {
    name: "nexus-dev-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";

        if (url === "/api/session/start" && req.method === "POST") {
          let bodyStr = "";
          req.on("data", (chunk) => {
            bodyStr += chunk;
          });
          req.on("end", () => {
            try {
              const body = JSON.parse(bodyStr || "{}");
              const durationHours = body.durationHours ?? 4;
              const sessionId = body.sessionId ?? `session-paper-${Date.now()}`;
              const maxPositions = body.maxConcurrentPositions ?? 5;

              let projectRoot = process.cwd();
              const checkRoot = (dir: string) => {
                const pkgPath = path.resolve(dir, "package.json");
                if (fs.existsSync(pkgPath)) {
                  try {
                    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
                    return parsed.name === "nexustrade-otis";
                  } catch {
                    return false;
                  }
                }
                return false;
              };
              if (!checkRoot(projectRoot)) {
                const parentDir = path.resolve(projectRoot, "..");
                if (checkRoot(parentDir)) {
                  projectRoot = parentDir;
                }
              }

              const tmpDir = path.resolve(projectRoot, ".tmp");
              if (!fs.existsSync(tmpDir)) {
                fs.mkdirSync(tmpDir, { recursive: true });
              }
              const logFile = path.resolve(tmpDir, "daemon-spawn.log");
              const outFd = fs.openSync(logFile, "a");

              const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
              const args = [
                "--filter",
                "@nexustrade/backend",
                "trading:paper-daemon",
                "--",
                `--duration-hours=${durationHours}`,
                `--session-id=${sessionId}`,
                `--max-positions=${maxPositions}`,
              ];

              const child = spawn(pnpmCmd, args, {
                cwd: projectRoot,
                detached: true,
                stdio: ["ignore", outFd, outFd],
                shell: process.platform === "win32",
              });
              child.unref();

              if (child.pid) {
                fs.writeFileSync(
                  path.resolve(tmpDir, "paper-daemon.pid"),
                  String(child.pid),
                  "utf8",
                );
              }

              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  ok: true,
                  sessionId,
                  pid: child.pid,
                  message: "Paper session started successfully",
                }),
              );
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: false, error: String(err) }));
            }
          });
          return;
        }

        if (
          (url === "/api/session/control" || url === "/api/session/stop") &&
          req.method === "POST"
        ) {
          let bodyStr = "";
          req.on("data", (chunk) => {
            bodyStr += chunk;
          });
          req.on("end", () => {
            try {
              const body = JSON.parse(bodyStr || "{}");
              const action =
                url === "/api/session/stop" ? "START_EXITING" : (body.action ?? "START_EXITING");
              const cmd = {
                action,
                ...(body.targetPositionId ? { targetPositionId: body.targetPositionId } : {}),
                issuedAt: Date.now(),
              };

              const rootTmp = path.resolve(process.cwd(), "../.tmp");
              const localTmp = path.resolve(process.cwd(), ".tmp");
              for (const dir of [rootTmp, localTmp]) {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const cmdFile = path.join(dir, "session-commands.json");
                let existing: unknown[] = [];
                if (fs.existsSync(cmdFile)) {
                  try {
                    const parsed = JSON.parse(fs.readFileSync(cmdFile, "utf8"));
                    if (Array.isArray(parsed)) existing = parsed;
                  } catch {
                    existing = [];
                  }
                }
                existing.push(cmd);
                fs.writeFileSync(cmdFile, JSON.stringify(existing, null, 2), "utf8");
              }

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true, command: cmd }));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: false, error: String(err) }));
            }
          });
          return;
        }

        if (url === "/api/session/active") {
          const rootTmp = path.resolve(process.cwd(), "../.tmp/paper-session-active.json");
          const backendTmp = path.resolve(
            process.cwd(),
            "../backend/.tmp/paper-session-active.json",
          );
          const localTmp = path.resolve(process.cwd(), ".tmp/paper-session-active.json");
          const candidates = [backendTmp, rootTmp, localTmp].filter((p) => fs.existsSync(p));
          candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
          const target = candidates[0];

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
              const now = Date.now();
              const start = raw.startedAtMs || now;
              const isHaltedOrDone =
                raw.status === "HALTED" || raw.status === "STOPPED" || raw.status === "COMPLETED";
              const plannedDurationMs = (raw.durationHours || 4) * 3600 * 1000;
              const endTimestamp = isHaltedOrDone
                ? Math.min(raw.lastTickAtMs || now, start + plannedDurationMs)
                : now;
              const elapsed = Math.max(0, Math.floor((endTimestamp - start) / 1000));

              const openPositions = (raw.openPositions || []).map((p: RawDaemonPosition) => ({
                positionId: p.positionId,
                poolId: p.positionId,
                mintAddress: p.mintAddress,
                symbol: p.symbol || p.mintAddress.slice(0, 4) + "..." + p.mintAddress.slice(-4),
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

              const logs =
                Array.isArray(raw.recentActivityLogs) && raw.recentActivityLogs.length > 0
                  ? raw.recentActivityLogs
                  : closedTrades.map((t: RawDaemonTrade) => ({
                      timestamp: t.closedAtMs || now,
                      type: t.realizedPnlSol >= 0 ? "RATCHET" : "SELL",
                      message: `${t.exitReason}: ${t.symbol ? t.symbol : t.mintAddress.slice(0, 8) + "..."} closed at ${t.exitPriceSol} SOL (${(t.realizedPnlBps / 100).toFixed(2)}%)`,
                      symbol: t.symbol,
                      mintAddress: t.mintAddress,
                    }));

              const telemetry = {
                sessionId: raw.sessionId || "session-paper",
                status: raw.status || "HALTED",
                haltReason: raw.haltReason,
                startedAtMs: start,
                durationHours: raw.durationHours || 4,
                elapsedSeconds: elapsed,
                initialPortfolioSol: initial,
                currentPortfolioSol: current,
                realizedPnlSol: realized,
                unrealizedPnlSol: unrealized,
                netSessionPnlSol: netPnlSol,
                netSessionPnlPct: netPnlPct,
                openPositionCount: openPositions.length,
                maxConcurrentPositions: raw.maxOpenPositions || 5,
                closedTradesCount: closedTrades.length,
                winsCount: wins,
                lossesCount: losses,
                scratchesCount: scratches,
                openPositions,
                watchlist: raw.watchlist || [],
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

        if (url === "/api/session/history" || url.startsWith("/api/session/history")) {
          const defaultPastSessions = [
            {
              sessionId: "session-paper-12.3-01",
              startedAt: "2026-09-25T18:00:00.000Z",
              endedAt: "2026-09-25T22:00:00.000Z",
              durationMinutes: 240,
              startingCapitalSol: 10.0,
              endingCapitalSol: 9.58,
              netPnlSol: -0.42,
              netPnlPct: -4.2,
              totalTrades: 8,
              buysCount: 8,
              sellsCount: 8,
              winsCount: 3,
              lossesCount: 5,
              scratchesCount: 0,
              winRatePct: 37.5,
              coinsWatchedCount: 48,
              missedOpportunitiesCount: 0,
              trades: [],
            },
            {
              sessionId: "session-paper-12.4-01",
              startedAt: "2026-09-26T14:30:00.000Z",
              endedAt: "2026-09-26T18:30:00.000Z",
              durationMinutes: 240,
              startingCapitalSol: 10.0,
              endingCapitalSol: 10.708,
              netPnlSol: 0.708,
              netPnlPct: 7.08,
              totalTrades: 12,
              buysCount: 12,
              sellsCount: 12,
              winsCount: 8,
              lossesCount: 4,
              scratchesCount: 0,
              winRatePct: 66.67,
              coinsWatchedCount: 73,
              missedOpportunitiesCount: 0,
              trades: [],
            },
            {
              sessionId: "session-paper-12.5-01",
              startedAt: "2026-09-26T20:00:00.000Z",
              endedAt: "2026-09-27T00:00:00.000Z",
              durationMinutes: 240,
              startingCapitalSol: 10.0,
              endingCapitalSol: 9.974,
              netPnlSol: -0.026,
              netPnlPct: -0.26,
              totalTrades: 7,
              buysCount: 7,
              sellsCount: 7,
              winsCount: 2,
              lossesCount: 5,
              scratchesCount: 0,
              winRatePct: 28.57,
              coinsWatchedCount: 54,
              missedOpportunitiesCount: 0,
              trades: [],
            },
            {
              sessionId: "session-paper-12.6-01",
              startedAt: "2026-09-27T00:30:00.000Z",
              endedAt: "2026-09-27T04:30:00.000Z",
              durationMinutes: 240,
              startingCapitalSol: 10.0,
              endingCapitalSol: 8.307,
              netPnlSol: -1.693,
              netPnlPct: -16.93,
              totalTrades: 11,
              buysCount: 11,
              sellsCount: 11,
              winsCount: 4,
              lossesCount: 7,
              scratchesCount: 0,
              winRatePct: 36.36,
              coinsWatchedCount: 62,
              missedOpportunitiesCount: 0,
              trades: [],
            },
          ];

          const rootTmp = path.resolve(process.cwd(), "../.tmp/past-sessions.json");
          const backendTmp = path.resolve(process.cwd(), "../backend/.tmp/past-sessions.json");
          const localTmp = path.resolve(process.cwd(), ".tmp/past-sessions.json");
          const candidates = [backendTmp, rootTmp, localTmp].filter((p) => fs.existsSync(p));
          let sessions = defaultPastSessions;
          if (candidates.length > 0) {
            try {
              const raw = JSON.parse(fs.readFileSync(candidates[0], "utf8"));
              if (Array.isArray(raw) && raw.length > 0) {
                sessions = raw;
              }
            } catch (err) {
              void err;
            }
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(sessions));
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
