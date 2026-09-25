import { parseArgs } from "node:util";
import { PaperTradingDaemon, type PaperTradingDaemonConfig } from "../paper/PaperTradingDaemon.js";
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
    pollIntervalMs: 1000,
    dryRun,
  };
}

async function run(): Promise<void> {
  const config = parseCliArgs();
  console.log(`[PaperDaemon] Starting Paper Trading Daemon Session: ${config.sessionId}`);
  console.log(
    `[PaperDaemon] Config: Duration=${config.durationHours}h, MaxPositions=${config.maxOpenPositions}, Size=${config.positionSizeSol} SOL`,
  );

  const daemon = new PaperTradingDaemon({ config });
  daemon.start();

  const startMs = nowMs();
  const maxDurationMs = config.durationHours * 3600 * 1000;

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
    process.exit(0);
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  // In daemon mode, tick and monitor until duration elapsed
  while (!terminating) {
    const elapsed = nowMs() - startMs;
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

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }

  const snap = daemon.getSnapshot();
  console.log(`[PaperDaemon] Session finished with status: ${snap.status}`);
}

void run();
