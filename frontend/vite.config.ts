/// <reference types="vitest" />
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { type Plugin } from "vite";
import { defineConfig } from "vitest/config";

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

export interface NexusDevApiPluginOptions {
  workspaceRoot?: string;
}

export function resolveProjectRoot(startDir: string = process.cwd()): string {
  let cur = path.resolve(startDir);
  while (true) {
    if (
      fs.existsSync(path.join(cur, "pnpm-workspace.yaml")) ||
      fs.existsSync(path.join(cur, ".git"))
    ) {
      return cur;
    }
    const pkgPath = path.resolve(cur, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (parsed.name === "nexustrade-otis") return cur;
      } catch {
        // ignore
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(startDir);
}

export function nexusDevApiPlugin(options?: NexusDevApiPluginOptions): Plugin {
  const projectRoot = options?.workspaceRoot ?? resolveProjectRoot();
  const canonicalTmp = path.join(projectRoot, ".tmp");
  const canonicalWallet = path.join(canonicalTmp, "virtual-wallet.json");
  const canonicalPastSessions = path.join(canonicalTmp, "past-sessions.json");
  const canonicalSessionsDir = path.join(canonicalTmp, "sessions");
  const canonicalActiveSession = path.join(canonicalTmp, "paper-session-active.json");
  const canonicalCommands = path.join(canonicalTmp, "session-commands.json");

  return {
    name: "nexus-dev-api",
    configureServer(server) {
      // NOTE: Sub-Phase 12.84 automatic past-sessions.json truncation was permanently removed
      // per Audit v12 finding V12-P0-02 to prevent destructive index overwrites during Vite startup.

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

              if (!fs.existsSync(canonicalTmp)) {
                fs.mkdirSync(canonicalTmp, { recursive: true });
              }
              const logFile = path.resolve(canonicalTmp, "daemon-spawn.log");
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
                env: { ...process.env },
              });
              child.unref();

              if (child.pid) {
                fs.writeFileSync(
                  path.resolve(canonicalTmp, "paper-daemon.pid"),
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

              if (!fs.existsSync(canonicalTmp)) fs.mkdirSync(canonicalTmp, { recursive: true });
              let existing: unknown[] = [];
              if (fs.existsSync(canonicalCommands)) {
                try {
                  const parsed = JSON.parse(fs.readFileSync(canonicalCommands, "utf8"));
                  if (Array.isArray(parsed)) existing = parsed;
                } catch {
                  existing = [];
                }
              }
              existing.push(cmd);
              fs.writeFileSync(canonicalCommands, JSON.stringify(existing, null, 2), "utf8");

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
          const target = canonicalActiveSession;

          if (fs.existsSync(target)) {
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

        if (url === "/api/session/logs" || url.startsWith("/api/session/logs")) {
          const logCandidates = [
            path.join(canonicalTmp, "paper-daemon.log"),
            path.join(canonicalTmp, "daemon-spawn.log"),
          ].filter((p) => fs.existsSync(p));

          logCandidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
          const targetLog = logCandidates[0];

          let logs: string[] = [];
          if (targetLog) {
            try {
              const content = fs.readFileSync(targetLog, "utf8");
              const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
              logs = lines.slice(-100);
            } catch (err) {
              void err;
            }
          }

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, logs }));
          return;
        }

        if (url === "/api/wallet/virtual" && req.method === "GET") {
          if (!fs.existsSync(canonicalWallet)) {
            const hasHistory =
              fs.existsSync(canonicalPastSessions) ||
              (fs.existsSync(canonicalSessionsDir) &&
                fs.readdirSync(canonicalSessionsDir).length > 0);
            if (hasHistory) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "WALLET_MISSING_WITH_HISTORY",
                  message:
                    "Canonical virtual wallet missing at .tmp/virtual-wallet.json, but prior session history exists. Halting to prevent false 10.0 SOL baseline.",
                }),
              );
              return;
            }
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ok: false,
                error: "WALLET_NOT_INITIALIZED",
                message: "Canonical virtual wallet has not been initialized.",
              }),
            );
            return;
          }

          try {
            const raw = JSON.parse(fs.readFileSync(canonicalWallet, "utf8"));
            if (
              typeof raw?.currentBalanceSol !== "number" ||
              !Number.isFinite(raw.currentBalanceSol)
            ) {
              throw new Error("Invalid currentBalanceSol in canonical wallet");
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(raw));
            return;
          } catch (err) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ok: false,
                error: "WALLET_CORRUPTED",
                message: `Canonical virtual wallet at .tmp/virtual-wallet.json is corrupted: ${String(err)}`,
              }),
            );
            return;
          }
        }

        if (url === "/api/wallet/reset" && req.method === "POST") {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              ok: false,
              error: "DASHBOARD_RESET_DISABLED",
              message:
                "Direct wallet reset via dashboard UI is disabled to protect ledger integrity. A fresh 10 SOL research wallet generation will be initiated under explicit Phase 12.94 workflow.",
            }),
          );
          return;
        }

        if (url.startsWith("/api/wallet/telemetry")) {
          if (!fs.existsSync(canonicalWallet)) {
            res.statusCode = 503;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ok: false,
                error: "WALLET_UNAVAILABLE",
                message: "Canonical virtual wallet is not available.",
              }),
            );
            return;
          }

          try {
            const raw = JSON.parse(fs.readFileSync(canonicalWallet, "utf8"));
            if (
              typeof raw?.currentBalanceSol !== "number" ||
              !Number.isFinite(raw.currentBalanceSol)
            ) {
              throw new Error("Invalid balance in canonical wallet");
            }
            const solBalance = raw.currentBalanceSol;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                solBalance,
                deployableSol: Math.max(0, parseFloat((solBalance - 0.05).toFixed(4))),
                tokens: [],
                signatureReady: true,
                fetchedAt: new Date().toISOString(),
              }),
            );
            return;
          } catch (err) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ok: false,
                error: "WALLET_CORRUPTED",
                message: `Canonical virtual wallet is corrupted: ${String(err)}`,
              }),
            );
            return;
          }
        }

        if (url === "/api/session/history" || url.startsWith("/api/session/history")) {
          const isArchiveRequest = url.includes("archive=true") || url.includes("archived=true");
          const targetFilename = isArchiveRequest
            ? "past-sessions-archive-12.83.json"
            : "past-sessions.json";
          const targetPath = path.join(canonicalTmp, targetFilename);

          let sessions: unknown[] = [];
          if (fs.existsSync(targetPath)) {
            try {
              const raw = JSON.parse(fs.readFileSync(targetPath, "utf8"));
              if (Array.isArray(raw)) {
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
