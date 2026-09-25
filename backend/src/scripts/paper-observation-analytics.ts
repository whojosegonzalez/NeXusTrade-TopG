import { existsSync, readFileSync } from "node:fs";
import type { CounterfactualOpportunityReport } from "../candidate-scanner/CounterfactualOpportunityTracker.js";

function runAnalytics(): void {
  const reportPath = ".tmp/session-paper-observation-report.json";
  if (!existsSync(reportPath)) {
    console.error(`[Analytics] No observation report found at ${reportPath}.`);
    console.error(
      `[Analytics] Run a paper trading session first via: pnpm daemon:paper --duration-hours=4`,
    );
    process.exit(1);
  }

  const raw = readFileSync(reportPath, "utf8");
  const report: CounterfactualOpportunityReport = JSON.parse(raw);

  console.log("===============================================================================");
  console.log("             NEXUSTRADE: 4-HOUR OBSERVATIONAL & STRATEGY REPORT                ");
  console.log("===============================================================================");
  console.log(`Generated At: ${report.generatedAt}`);
  console.log(
    `Portfolio Progression: ${report.portfolioStartSol.toFixed(4)} SOL -> ${report.portfolioCurrentSol.toFixed(4)} SOL`,
  );
  console.log(
    `Net Realized Session PnL: ${report.portfolioRealizedPnlSol >= 0 ? "+" : ""}${report.portfolioRealizedPnlSol.toFixed(4)} SOL (${((report.portfolioRealizedPnlSol / report.portfolioStartSol) * 100).toFixed(2)}%)`,
  );
  console.log("-------------------------------------------------------------------------------");
  console.log(`Candidates Observed:     ${report.totalCandidatesObserved}`);
  console.log(`Executed Paper Buys:     ${report.executedBuysCount}`);
  console.log(`Watchlist Radar Monitored: ${report.watchlistRadarCount}`);
  console.log(`Pre-screen Filtered Out:  ${report.filteredRejectedCount}`);
  console.log(`Missed Winners (>= +15%): ${report.missedWinnersCount}`);
  console.log(`Avoided Rugs (<= -30%):   ${report.avoidedRugsCount}`);
  console.log("===============================================================================\n");

  // 1. Avoided Rugs Showcase
  console.log("--- 🛡️ TOP AVOIDED RUGS (Tokens Filtered Out That Crashed) ---");
  if (report.avoidedRugs.length === 0) {
    console.log("No rejected tokens exhibited >= -30% crashes during this period.");
  } else {
    for (const rug of report.avoidedRugs.slice(0, 10)) {
      console.log(
        `  • ${rug.symbol.padEnd(10)} | Drop: ${rug.maxLossPct.toFixed(2)}% | Entry: ${rug.initialPriceSol} -> Low: ${rug.lowestPriceSol} | Filter: ${rug.rejectionReason ?? "PRESCREEN"}`,
      );
    }
  }
  console.log("");

  // 2. Missed Winners Showcase
  console.log("--- 🚀 TOP MISSED WINNERS (Unbought Tokens That Surged) ---");
  if (report.missedWinners.length === 0) {
    console.log("No unbought tokens surged >= +15% (Strategy filters captured all runners).");
  } else {
    for (const win of report.missedWinners.slice(0, 10)) {
      console.log(
        `  • ${win.symbol.padEnd(10)} | Peak: +${win.peakGainPct.toFixed(2)}% | Initial: ${win.initialPriceSol} -> Peak: ${win.peakPriceSol} | Cohort: ${win.cohort} (${win.durationMinutes}m)`,
      );
    }
  }
  console.log("");

  // 3. Rejection Reason Distribution
  console.log("--- 📊 FILTER DISQUALIFICATION BREAKDOWN ---");
  for (const [reason, count] of Object.entries(report.rejectionReasonBreakdown)) {
    console.log(`  • ${reason.padEnd(35)}: ${count}`);
  }
  console.log("===============================================================================");
}

runAnalytics();
