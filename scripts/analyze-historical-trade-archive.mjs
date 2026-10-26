/**
 * NeXusTrade Phase 12.94-D Milestone D.3.2: Historical Strategy Robustness Analysis
 *
 * 100% OFFLINE script to analyze:
 *   1. The 177-trade historical archive (Phase 12.6 through 12.92)
 *   2. Cohort segregation: Established Runners vs Micro-Cap Probes
 *   3. Regime breakdown across phases
 *   4. Friction scenario modeling (Scenarios A, B, B2, C)
 *   5. Outlier concentration & drawdown analysis
 *   6. Micro-Cap failure mode diagnostics & AIRPAD comparison
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archivePath = path.join(
  rootDir,
  "data/backups/pre-legacy-retirement-20261013/backend_tmp/trade-history-2026-09-27-to-2026-10-12.json",
);

const archiveRaw = JSON.parse(fs.readFileSync(archivePath, "utf8"));
const trades = archiveRaw.trades;

console.log("=== NeXusTrade D.3.2 Historical Trade Analysis ===");
console.log(
  `Loaded ${trades.length} trades from archive across ${archiveRaw.metadata.totalSessions} sessions.`,
);

// 1. Friction helper functions
function calcNetPnL(t, feeSol, slipPctPerLeg) {
  const gross = t.realized_pnl_sol;
  const size = t.size_sol;
  const exitVal = Math.max(0, size + gross);
  const entrySlip = size * slipPctPerLeg;
  const exitSlip = exitVal * slipPctPerLeg;
  return gross - feeSol - entrySlip - exitSlip;
}

// 2. Classify into cohorts
const establishedTrades = trades.filter((t) => t.size_sol >= 0.8);
const microTrades = trades.filter((t) => t.size_sol <= 0.5);

console.log(`Established cohort: ${establishedTrades.length} trades`);
console.log(`Micro-Cap cohort:   ${microTrades.length} trades`);
console.log(`Sum of cohorts:     ${establishedTrades.length + microTrades.length}`);

// 3. Robustness metric computer
function computeCohortMetrics(name, cohortTrades) {
  const count = cohortTrades.length;
  if (count === 0) return null;

  const sessions = new Set(cohortTrades.map((t) => t.session_id));
  const wins = cohortTrades.filter((t) => t.realized_pnl_sol > 0);
  const losses = cohortTrades.filter((t) => t.realized_pnl_sol < 0);
  const scratches = cohortTrades.filter((t) => t.realized_pnl_sol === 0);

  const winRate = (wins.length / count) * 100;
  const grossProfit = wins.reduce((acc, t) => acc + t.realized_pnl_sol, 0);
  const grossLoss = losses.reduce((acc, t) => acc + t.realized_pnl_sol, 0);
  const grossNet = grossProfit + grossLoss;
  const profitFactor = Math.abs(grossLoss) > 0 ? grossProfit / Math.abs(grossLoss) : Infinity;

  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const meanTrade = grossNet / count;

  // Median
  const sortedPnl = [...cohortTrades].map((t) => t.realized_pnl_sol).sort((a, b) => a - b);
  const mid = Math.floor(sortedPnl.length / 2);
  const medianTrade =
    sortedPnl.length % 2 !== 0 ? sortedPnl[mid] : (sortedPnl[mid - 1] + sortedPnl[mid]) / 2;

  // Scenarios
  // Scenario A: fee 0.003
  const pnlA = cohortTrades.reduce((acc, t) => acc + (t.realized_pnl_sol - 0.003), 0);
  // Scenario B: fee 0.003, slip 1.0%
  const pnlB = cohortTrades.reduce((acc, t) => acc + calcNetPnL(t, 0.003, 0.01), 0);
  // Scenario B2: fee 0.005, slip 1.5%
  const pnlB2 = cohortTrades.reduce((acc, t) => acc + calcNetPnL(t, 0.005, 0.015), 0);

  // Outlier concentration (sorted by realized_pnl_sol descending)
  const sortedByPnlDesc = [...cohortTrades].sort((a, b) => b.realized_pnl_sol - a.realized_pnl_sol);
  const top1 = sortedByPnlDesc[0];
  const top3 = sortedByPnlDesc.slice(0, 3);
  const top5 = sortedByPnlDesc.slice(0, 5);

  const top1Profit = top1 ? top1.realized_pnl_sol : 0;
  const top3Profit = top3.reduce((acc, t) => acc + t.realized_pnl_sol, 0);
  const top5Profit = top5.reduce((acc, t) => acc + t.realized_pnl_sol, 0);

  const top1Conc = grossProfit > 0 ? (top1Profit / grossProfit) * 100 : 0;
  const top3Conc = grossProfit > 0 ? (top3Profit / grossProfit) * 100 : 0;
  const top5Conc = grossProfit > 0 ? (top5Profit / grossProfit) * 100 : 0;

  // Exclude Top 1 winner
  const tradesExTop1 = sortedByPnlDesc.slice(1);
  const grossNetExTop1 = tradesExTop1.reduce((acc, t) => acc + t.realized_pnl_sol, 0);
  const pnlBExTop1 = tradesExTop1.reduce((acc, t) => acc + calcNetPnL(t, 0.003, 0.01), 0);

  // Equity curve and max drawdown
  let cumPnl = 0;
  let peakCumPnl = 0;
  let maxDrawdownSol = 0;
  for (const t of cohortTrades) {
    cumPnl += t.realized_pnl_sol;
    if (cumPnl > peakCumPnl) peakCumPnl = cumPnl;
    const dd = peakCumPnl - cumPnl;
    if (dd > maxDrawdownSol) maxDrawdownSol = dd;
  }

  // Same for Scenario B equity curve
  let cumPnlB = 0;
  let peakCumPnlB = 0;
  let maxDrawdownSolB = 0;
  for (const t of cohortTrades) {
    cumPnlB += calcNetPnL(t, 0.003, 0.01);
    if (cumPnlB > peakCumPnlB) peakCumPnlB = cumPnlB;
    const dd = peakCumPnlB - cumPnlB;
    if (dd > maxDrawdownSolB) maxDrawdownSolB = dd;
  }

  // Hold durations
  const under60s = cohortTrades.filter((t) => t.hold_duration_seconds < 60).length;
  const between60and300s = cohortTrades.filter(
    (t) => t.hold_duration_seconds >= 60 && t.hold_duration_seconds <= 300,
  ).length;
  const over300s = cohortTrades.filter((t) => t.hold_duration_seconds > 300).length;

  // Exit reasons
  const exitReasons = {};
  for (const t of cohortTrades) {
    exitReasons[t.exit_reason] = (exitReasons[t.exit_reason] || 0) + 1;
  }

  return {
    name,
    count,
    sessionsCount: sessions.size,
    winsCount: wins.length,
    lossesCount: losses.length,
    scratchesCount: scratches.length,
    winRatePct: winRate,
    grossProfitSol: grossProfit,
    grossLossSol: grossLoss,
    grossNetSol: grossNet,
    profitFactor,
    avgWinSol: avgWin,
    avgLossSol: avgLoss,
    meanTradeSol: meanTrade,
    medianTradeSol: medianTrade,
    pnlASol: pnlA,
    pnlBSol: pnlB,
    pnlB2Sol: pnlB2,
    top1: top1
      ? {
          symbol: top1.symbol,
          session: top1.session_id,
          pnl: top1.realized_pnl_sol,
          pct: top1.realized_pnl_pct,
        }
      : null,
    top1Profit,
    top1ConcPct: top1Conc,
    top3Profit,
    top3ConcPct: top3Conc,
    top5Profit,
    top5ConcPct: top5Conc,
    grossNetExTop1,
    pnlBExTop1,
    maxDrawdownSol,
    maxDrawdownSolB,
    durations: { under60s, between60and300s, over300s },
    exitReasons,
  };
}

const estMetrics = computeCohortMetrics("Established Runners (>= 0.8 SOL)", establishedTrades);
const microMetrics = computeCohortMetrics("Micro-Cap Probes (<= 0.5 SOL)", microTrades);
const allMetrics = computeCohortMetrics("All Trades Combined", trades);

// 4. Group by historical regime
const regimes = [
  {
    name: "Regime 1: Phase 12.6 Baseline",
    sessions: ["session-paper-12.6-01"],
    desc: "Single cohort fixed 1.0 SOL sizing, early ratchet logic",
  },
  {
    name: "Regime 2: Phase 12.7-12.82 Dual-Cohort V1",
    sessions: [
      "session-paper-12.7-01",
      "session-paper-12.8-01",
      "session-paper-12.81-01",
      "session-paper-12.82-01",
    ],
    desc: "Dual cohort: 0.8 SOL Established, 0.25 SOL Micro-Cap probes",
  },
  {
    name: "Regime 3: Phase 12.83-12.88 Dual-Cohort V2",
    sessions: [
      "session-paper-12.83-01",
      "session-paper-12.84-01",
      "session-paper-12.85-01",
      "session-paper-12.86-01",
      "session-paper-12.87-01",
      "session-paper-12.88-01",
    ],
    desc: "1.0 SOL Established, 0.25/0.50 SOL Micro-Cap, dynamic ratchet v2",
  },
  {
    name: "Regime 4: Phase 12.89 24h Stress Run",
    sessions: ["session-paper-12.89-24h"],
    desc: "45-trade continuous soak test, 1.0 SOL dominant",
  },
  {
    name: "Regime 5: Phase 12.90-12.92 Multi-Day Extended Benchmark",
    sessions: [
      "session-paper-12.90-day1",
      "session-paper-12.90-day1.5",
      "session-paper-12.91-day2",
      "session-paper-12.92-day3",
    ],
    desc: "Multi-day soak test, 1.0 SOL Established vs 0.50 SOL Micro-Cap probes",
  },
];

console.log("\n================ REGIME BREAKDOWN ================");
const regimeResults = [];
for (const r of regimes) {
  const rTrades = trades.filter((t) => r.sessions.includes(t.session_id));
  const rEst = rTrades.filter((t) => t.size_sol >= 0.8);
  const rMicro = rTrades.filter((t) => t.size_sol <= 0.5);

  const rMetrics = computeCohortMetrics(r.name, rTrades);
  const rEstMetrics = computeCohortMetrics(`${r.name} (Established)`, rEst);
  const rMicroMetrics = computeCohortMetrics(`${r.name} (Micro-Cap)`, rMicro);

  regimeResults.push({
    regime: r.name,
    sessions: r.sessions,
    desc: r.desc,
    totalTrades: rTrades.length,
    rMetrics,
    rEstMetrics,
    rMicroMetrics,
  });

  console.log(`\n--- ${r.name} ---`);
  console.log(`  Description: ${r.desc}`);
  console.log(
    `  Total Trades: ${rTrades.length} | Gross PnL: ${rMetrics ? rMetrics.grossNetSol.toFixed(4) : 0} SOL | Net B PnL: ${rMetrics ? rMetrics.pnlBSol.toFixed(4) : 0} SOL | WinRate: ${rMetrics ? rMetrics.winRatePct.toFixed(1) : 0}%`,
  );
  if (rEstMetrics) {
    console.log(
      `    Established: N=${rEstMetrics.count} | Gross: ${rEstMetrics.grossNetSol.toFixed(4)} SOL | Net B: ${rEstMetrics.pnlBSol.toFixed(4)} SOL | WR: ${rEstMetrics.winRatePct.toFixed(1)}%`,
    );
  }
  if (rMicroMetrics) {
    console.log(
      `    Micro-Cap:   N=${rMicroMetrics.count} | Gross: ${rMicroMetrics.grossNetSol.toFixed(4)} SOL | Net B: ${rMicroMetrics.pnlBSol.toFixed(4)} SOL | WR: ${rMicroMetrics.winRatePct.toFixed(1)}%`,
    );
  }
}

// 5. Deep-dive into AIRPAD and top runners
console.log("\n================ TOP 10 RUNNERS IN CORPUS ================");
const top10Runners = [...trades]
  .sort((a, b) => b.realized_pnl_sol - a.realized_pnl_sol)
  .slice(0, 10);
top10Runners.forEach((t, i) => {
  console.log(
    `#${i + 1} Symbol: ${t.symbol.padEnd(8)} | Session: ${t.session_id.padEnd(25)} | Size: ${t.size_sol} SOL | PnL: +${t.realized_pnl_sol.toFixed(4)} SOL (+${t.realized_pnl_pct.toFixed(1)}%) | Exit: ${t.exit_reason} | Hold: ${t.hold_duration_seconds}s`,
  );
});

// 6. Deep-dive into Micro-Cap catastrophic losses
console.log("\n================ WORST 10 MICRO-CAP LOSSES ================");
const worst10Micro = [...microTrades]
  .sort((a, b) => a.realized_pnl_sol - b.realized_pnl_sol)
  .slice(0, 10);
worst10Micro.forEach((t, i) => {
  console.log(
    `#${i + 1} Symbol: ${t.symbol.padEnd(8)} | Session: ${t.session_id.padEnd(25)} | Size: ${t.size_sol} SOL | PnL: ${t.realized_pnl_sol.toFixed(4)} SOL (${t.realized_pnl_pct.toFixed(1)}%) | Exit: ${t.exit_reason} | Hold: ${t.hold_duration_seconds}s`,
  );
});

console.log("\n================ SUMMARY OBJECT ================");
console.log(JSON.stringify({ estMetrics, microMetrics, allMetrics, regimeResults }, null, 2));
