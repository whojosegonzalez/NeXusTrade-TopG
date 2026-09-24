import type {
  CandidateFilterSummary,
  EntryConfirmationSummary,
  ShadowCalibrationRecommendation,
  ShadowCalibrationReport,
  ShadowCalibrationRunSummary,
  ShadowDecisionOutcomeSummary,
  ShadowScenarioPortfolioSummary,
  ShadowUniqueMintOutcomeSummary,
} from "./ShadowCalibrationTypes.js";

export function formatShadowCalibrationJson(report: ShadowCalibrationReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatShadowCalibrationReport(report: ShadowCalibrationReport): string {
  const lines: string[] = [];

  lines.push("NeXusTrade Shadow Calibration Report");
  lines.push(`Generated: ${new Date(report.generatedAtMs).toISOString()}`);
  lines.push("");
  lines.push("Safety");
  lines.push("  mode: PAPER diagnostics");
  lines.push("  database access: read-only");
  lines.push("  wallet loaded: no");
  lines.push("  transaction signing: disabled");
  lines.push("  transaction submission: disabled");
  lines.push("");
  lines.push("Config");
  lines.push(`  targets pct: ${report.config.targetPcts.join(",")}`);
  lines.push(`  stops pct: ${report.config.stopPcts.join(",")}`);
  lines.push(`  max holds minutes: ${report.config.maxHoldMinutes.join(",")}`);
  lines.push(`  source decisions: ${report.config.sourceDecisions.join(",")}`);
  lines.push(`  min score: ${report.config.minScore}`);
  lines.push(`  dedupe mode: ${report.config.dedupeMode}`);
  lines.push(
    `  simulated portfolio: start=${formatNumber(
      report.config.portfolioStartingSol,
    )} SOL position=${formatNumber(report.config.portfolioPositionSizeSol)} SOL goal=${formatNumber(
      report.config.portfolioGoalPct,
    )}% maxPositions=${report.config.portfolioMaxPositions}`,
  );
  lines.push("");
  lines.push("Aggregate");
  lines.push(`  runs: ${report.aggregate.runCount}`);
  lines.push(`  database runs: ${report.aggregate.databaseRunCount}`);
  lines.push(`  report-only runs: ${report.aggregate.reportOnlyRunCount}`);
  lines.push(`  observed decisions: ${report.aggregate.observedDecisionCount}`);
  lines.push(`  unique mints: ${report.aggregate.uniqueMintCount}`);
  lines.push(
    `  paper execution rows: orders=${report.aggregate.orderCount} fills=${report.aggregate.fillCount} positions=${report.aggregate.positionCount}`,
  );
  lines.push("");
  lines.push("Runs");
  lines.push(...formatRuns(report.runs));
  lines.push("");
  lines.push("Decision-Level Outcomes");
  lines.push(...formatOutcomeRows(report.decisionOutcomes.slice(0, 24)));
  lines.push("");
  lines.push("Unique-Mint Outcomes");
  lines.push(...formatUniqueRows(report.uniqueMintOutcomes.slice(0, 24)));
  lines.push("");
  lines.push("Scenario Portfolio Grid");
  lines.push(...formatScenarioRows(report.scenarioPortfolioGrid.slice(0, 24)));
  lines.push("");
  lines.push("Entry Confirmation");
  lines.push(...formatConfirmationRows(report.confirmationResults.slice(0, 24)));
  lines.push("");
  lines.push("Candidate Filters");
  lines.push(...formatFilterRows(report.filterAnalysis.slice(0, 30)));
  lines.push("");
  lines.push("Recommendations");
  lines.push(...formatRecommendations(report.recommendations));
  lines.push("");
  lines.push("Next Test Plan");
  lines.push(...report.nextTestPlan.map((step) => `  - ${step}`));

  return lines.join("\n").trimEnd();
}

function formatRuns(runs: readonly ShadowCalibrationRunSummary[]): string[] {
  if (runs.length === 0) {
    return ["  none"];
  }

  return runs.flatMap((run) => [
    `  ${run.label}: ${run.sourceKind} valid=${run.mechanicallyValid ? "yes" : "no"} session=${
      run.sessionId ?? "n/a"
    }`,
    `    rows: radar=${run.tokenRadarRows} risk=${run.riskRows} strategy=${run.strategyRows} observedReturns=${run.observedReturnRows} providerHealth=${run.providerHealthRows}`,
    `    unique: radar=${run.uniqueRadarMints ?? "n/a"} strategy=${
      run.uniqueStrategyMints ?? "n/a"
    } observedDecisions=${run.observedDecisionCount ?? "n/a"}`,
    `    scanner: runtime=${formatOptional(run.scannerRuntimeMinutes)}m cycles=${
      run.scannerCycleCount ?? "n/a"
    } jupiterRateLimited=${formatOptional(run.jupiterRateLimitedPercent)}%`,
    ...run.warnings.map((warning) => `    warning: ${warning}`),
  ]);
}

function formatOutcomeRows(rows: readonly ShadowDecisionOutcomeSummary[]): string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.label}/${row.group}: n=${row.count} unique=${row.uniqueMints} avgBest=${formatOptionalSigned(
        row.averageBestReturnPct,
      )}% avgWorst=${formatOptionalSigned(row.averageWorstReturnPct)}% medBest=${formatOptionalSigned(
        row.medianBestReturnPct,
      )}% hits=${formatRates(row.targetHitRates)} drawdownFirst=${formatRates(
        row.drawdownFirstRates,
      )}`,
  );
}

function formatUniqueRows(rows: readonly ShadowUniqueMintOutcomeSummary[]): string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.label}/${row.group}: dedupe=${row.dedupeMode} n=${row.count} unique=${row.uniqueMints} avgBest=${formatOptionalSigned(
        row.averageBestReturnPct,
      )}% avgWorst=${formatOptionalSigned(row.averageWorstReturnPct)}% hits=${formatRates(
        row.targetHitRates,
      )}`,
  );
}

function formatScenarioRows(rows: readonly ShadowScenarioPortfolioSummary[]): string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.label}: target=${formatNumber(row.targetPct)}% stop=${formatNumber(
        row.stopPct,
      )}% hold=${row.maxHoldMinutes}m evaluated=${row.evaluatedCount} target=${row.targetHitCount} stop=${row.stopHitCount} maxHold=${row.maxHoldCount} pnl=${formatSigned(
        row.simulatedPnlSol,
      )} SOL (${formatSigned(row.simulatedPnlPct)}%) drawdown=${formatNumber(
        row.maxDrawdownPct,
      )}% goal=${row.goalReached ? "yes" : "no"}`,
  );
}

function formatConfirmationRows(rows: readonly EntryConfirmationSummary[]): string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.label}: wait=${row.horizonMinutes}m minReturn=${formatNumber(
        row.minReturnPct,
      )}% maxDrawdown=${formatNumber(row.maxDrawdownPct)}% considered=${
        row.consideredCount
      } confirmed=${row.confirmedCount} rejected=${row.rejectedCount} noData=${
        row.noDataCount
      } missedFast=${row.missedFastMoveCount} target=${row.targetHitCount} stop=${
        row.stopHitCount
      } avgExit=${formatOptionalSigned(row.averageConfirmedExitReturnPct)}% avoided=${
        row.falsePositiveBuysAvoided
      } missedWinners=${row.missedWinnersCausedByWaiting}`,
  );
}

function formatFilterRows(rows: readonly CandidateFilterSummary[]): string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.label}/${row.filterName}/${row.bucket}: n=${row.count}${
        row.sampleWarning ? " sample=small" : ""
      } avgBest=${formatOptionalSigned(row.averageBestReturnPct)}% avgWorst=${formatOptionalSigned(
        row.averageWorstReturnPct,
      )}% hits=${formatRates(row.targetHitRates)} drawdownFirst=${formatRates(
        row.drawdownFirstRates,
      )}`,
  );
}

function formatRecommendations(
  recommendations: readonly ShadowCalibrationRecommendation[],
): string[] {
  if (recommendations.length === 0) {
    return ["  none"];
  }

  return recommendations.flatMap((recommendation) => [
    `  - [${recommendation.confidence}] ${recommendation.category}: ${recommendation.recommendation}`,
    ...recommendation.evidence.map((item) => `    evidence: ${item}`),
  ]);
}

function formatRates(rates: Readonly<Record<string, number>>): string {
  return Object.entries(rates)
    .map(([target, rate]) => `${target}:${rate.toFixed(2)}%`)
    .join(" ");
}

function formatOptional(value: number | undefined): string {
  return value === undefined ? "n/a" : formatNumber(value);
}

function formatOptionalSigned(value: number | undefined): string {
  return value === undefined ? "n/a" : formatSigned(value);
}

function formatSigned(value: number): string {
  const formatted = formatNumber(value);

  return value > 0 ? `+${formatted}` : formatted;
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toString()
    : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
