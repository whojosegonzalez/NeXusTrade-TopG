import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const sessionsDir = path.join(rootDir, "backend/.tmp/sessions");
const activeSessionFile = path.join(rootDir, "backend/.tmp/paper-session-active.json");

const sessionFiles = fs
  .readdirSync(sessionsDir)
  .filter((f) => f.startsWith("session-paper-") && f.endsWith(".json"))
  .sort();

const allTrades = [];
const sessionSummaries = [];
const sessionMap = new Map();

for (const f of sessionFiles) {
  const filePath = path.join(sessionsDir, f);
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  sessionMap.set(data.sessionId, data);

  const trades = (data.trades || []).map((t) => {
    const sizeSol = t.sizeSol ?? t.costBasisSol ?? 0;
    const finalPnlSol = t.finalPnlSol ?? t.realizedPnlSol ?? 0;
    const proceedsSol = t.proceedsSol !== undefined ? t.proceedsSol : sizeSol + finalPnlSol;
    const pnlBps = t.finalPnlBps ?? t.realizedPnlBps ?? 0;
    const enteredAt = t.enteredAt || data.startedAt;
    const exitedAt = t.exitedAt || data.endedAt;
    const holdSec =
      t.holdDurationSeconds ??
      (enteredAt && exitedAt
        ? Math.max(
            1,
            Math.round((new Date(exitedAt).getTime() - new Date(enteredAt).getTime()) / 1000),
          )
        : 1);

    return {
      session_id: data.sessionId,
      session_date: enteredAt.slice(0, 10),
      trade_id: t.tradeId || t.positionId,
      symbol: t.symbol || "UNKNOWN",
      mint_address: t.mintAddress,
      pool_id: t.poolId || `pool-${t.mintAddress.slice(0, 8)}`,
      entered_at: enteredAt,
      exited_at: exitedAt,
      hold_duration_seconds: holdSec,
      entry_price_sol: t.entryPriceSol,
      exit_price_sol: t.exitPriceSol,
      size_sol: Number(sizeSol.toFixed(6)),
      proceeds_sol: Number(proceedsSol.toFixed(6)),
      realized_pnl_sol: Number(finalPnlSol.toFixed(6)),
      realized_pnl_bps: pnlBps,
      realized_pnl_pct: Number((pnlBps / 100).toFixed(2)),
      peak_gain_bps: t.peakGainBps ?? Math.max(0, pnlBps),
      exit_reason: t.exitReason || "UNKNOWN",
      final_tier:
        t.finalTier || (pnlBps >= 5000 ? "TIER_2" : pnlBps >= 1500 ? "TIER_1" : "BASELINE"),
      is_win: finalPnlSol > 0,
    };
  });

  sessionSummaries.push({
    sessionId: data.sessionId,
    startedAt: data.startedAt,
    endedAt: data.endedAt,
    tradeCount: trades.length,
    netPnlSol: Number((data.netPnlSol || 0).toFixed(4)),
    startingCapitalSol: data.startingCapitalSol,
    endingCapitalSol: data.endingCapitalSol,
  });

  allTrades.push(...trades);
}

// Active session (12.92-day3)
if (fs.existsSync(activeSessionFile)) {
  const active = JSON.parse(fs.readFileSync(activeSessionFile, "utf8"));
  const activeTrades = (active.closedTrades || []).map((t) => {
    const sizeSol = t.costBasisSol ?? 0;
    const finalPnlSol = t.realizedPnlSol ?? 0;
    const proceedsSol = t.proceedsSol !== undefined ? t.proceedsSol : sizeSol + finalPnlSol;
    const pnlBps = t.realizedPnlBps ?? 0;
    const enteredAt = new Date(t.openedAtMs).toISOString();
    const exitedAt = new Date(t.closedAtMs).toISOString();
    const holdSec = Math.max(1, Math.round((t.closedAtMs - t.openedAtMs) / 1000));

    return {
      session_id: active.sessionId,
      session_date: enteredAt.slice(0, 10),
      trade_id: t.positionId,
      symbol: t.symbol || "UNKNOWN",
      mint_address: t.mintAddress,
      pool_id: `pool-${t.mintAddress.slice(0, 8)}`,
      entered_at: enteredAt,
      exited_at: exitedAt,
      hold_duration_seconds: holdSec,
      entry_price_sol: t.entryPriceSol,
      exit_price_sol: t.exitPriceSol,
      size_sol: Number(sizeSol.toFixed(6)),
      proceeds_sol: Number(proceedsSol.toFixed(6)),
      realized_pnl_sol: Number(finalPnlSol.toFixed(6)),
      realized_pnl_bps: pnlBps,
      realized_pnl_pct: Number((pnlBps / 100).toFixed(2)),
      peak_gain_bps: Math.max(0, pnlBps),
      exit_reason: t.exitReason || "UNKNOWN",
      final_tier: pnlBps >= 5000 ? "TIER_2" : pnlBps >= 1500 ? "TIER_1" : "BASELINE",
      is_win: finalPnlSol > 0,
    };
  });

  const activeNetPnl = activeTrades.reduce((acc, t) => acc + t.realized_pnl_sol, 0);

  sessionSummaries.push({
    sessionId: active.sessionId,
    startedAt: new Date(active.startedAtMs).toISOString(),
    endedAt: new Date(active.lastTickAtMs).toISOString(),
    tradeCount: activeTrades.length,
    netPnlSol: Number(activeNetPnl.toFixed(4)),
    startingCapitalSol: active.initialPortfolioSol,
    endingCapitalSol: active.currentPortfolioSol,
  });

  allTrades.push(...activeTrades);
}

// Sort chronologically
allTrades.sort((a, b) => new Date(a.entered_at).getTime() - new Date(b.entered_at).getTime());

// Add sequential trade number and running cumulative PnL
let cumPnl = 0;
allTrades.forEach((t, i) => {
  cumPnl += t.realized_pnl_sol;
  t.trade_number = i + 1;
  t.cumulative_pnl_sol = Number(cumPnl.toFixed(6));
});

// CSV serialization
const headers = [
  "trade_number",
  "session_id",
  "session_date",
  "trade_id",
  "symbol",
  "mint_address",
  "pool_id",
  "entered_at",
  "exited_at",
  "hold_duration_seconds",
  "entry_price_sol",
  "exit_price_sol",
  "size_sol",
  "proceeds_sol",
  "realized_pnl_sol",
  "realized_pnl_bps",
  "realized_pnl_pct",
  "peak_gain_bps",
  "exit_reason",
  "final_tier",
  "is_win",
  "cumulative_pnl_sol",
];

const csvRows = [headers.join(",")];
for (const t of allTrades) {
  const row = headers.map((h) => {
    const val = t[h];
    if (typeof val === "string" && (val.includes(",") || val.includes('"'))) {
      return `"${val.replaceAll('"', '""')}"`;
    }
    return val;
  });
  csvRows.push(row.join(","));
}
const csvContent = csvRows.join("\n");

// Summary calculation
const wins = allTrades.filter((t) => t.realized_pnl_sol > 0);
const losses = allTrades.filter((t) => t.realized_pnl_sol < 0);
const grossProfit = Number(wins.reduce((acc, t) => acc + t.realized_pnl_sol, 0).toFixed(6));
const grossLoss = Number(losses.reduce((acc, t) => acc + t.realized_pnl_sol, 0).toFixed(6));
const netPnl = Number((grossProfit + grossLoss).toFixed(6));
const winRatePct = Number(((wins.length / allTrades.length) * 100).toFixed(2));
const profitFactor =
  Math.abs(grossLoss) > 0 ? Number((grossProfit / Math.abs(grossLoss)).toFixed(3)) : null;

const exitReasons = {};
allTrades.forEach((t) => {
  exitReasons[t.exit_reason] = (exitReasons[t.exit_reason] || 0) + 1;
});

const jsonPayload = {
  metadata: {
    title: "TopG Complete Trade History",
    phaseRange: "Phase 12.6 through Phase 12.92",
    dateRange: {
      startDate: allTrades[0].entered_at,
      endDate: allTrades[allTrades.length - 1].exited_at,
    },
    generatedAt: new Date().toISOString(),
    totalSessions: sessionSummaries.length,
    totalTrades: allTrades.length,
    overallMetrics: {
      totalTrades: allTrades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRatePct,
      grossProfitSol: grossProfit,
      grossLossSol: grossLoss,
      netRealizedPnlSol: netPnl,
      profitFactor,
      averageTradePnlSol: Number((netPnl / allTrades.length).toFixed(6)),
      averageWinSol: Number((grossProfit / wins.length).toFixed(6)),
      averageLossSol: Number((grossLoss / losses.length).toFixed(6)),
      averageHoldDurationSeconds: Math.round(
        allTrades.reduce((acc, t) => acc + t.hold_duration_seconds, 0) / allTrades.length,
      ),
    },
    exitReasonsBreakdown: exitReasons,
    sessions: sessionSummaries,
  },
  trades: allTrades,
};

const jsonContent = JSON.stringify(jsonPayload, null, 2);

// Output destinations
const targetFiles = [
  {
    csv: path.join(rootDir, "data/trade-history-2026-09-27-to-2026-10-12.csv"),
    json: path.join(rootDir, "data/trade-history-2026-09-27-to-2026-10-12.json"),
  },
  {
    csv: path.join(rootDir, "backend/.tmp/trade-history-2026-09-27-to-2026-10-12.csv"),
    json: path.join(rootDir, "backend/.tmp/trade-history-2026-09-27-to-2026-10-12.json"),
  },
  {
    csv: path.join(rootDir, ".tmp/trade-history-2026-09-27-to-2026-10-12.csv"),
    json: path.join(rootDir, ".tmp/trade-history-2026-09-27-to-2026-10-12.json"),
  },
];

for (const dest of targetFiles) {
  const csvDir = path.dirname(dest.csv);
  if (!fs.existsSync(csvDir)) fs.mkdirSync(csvDir, { recursive: true });
  fs.writeFileSync(dest.csv, csvContent, "utf8");
  fs.writeFileSync(dest.json, jsonContent, "utf8");
}

console.log(
  `[SUCCESS] Extracted ${allTrades.length} trades across ${sessionSummaries.length} sessions.`,
);
console.log(`Exported CSV: data/trade-history-2026-09-27-to-2026-10-12.csv`);
console.log(`Exported JSON: data/trade-history-2026-09-27-to-2026-10-12.json`);
console.log(
  `Summary: ${wins.length} Wins / ${losses.length} Losses | Win Rate: ${winRatePct}% | Net PnL: ${netPnl.toFixed(4)} SOL`,
);
