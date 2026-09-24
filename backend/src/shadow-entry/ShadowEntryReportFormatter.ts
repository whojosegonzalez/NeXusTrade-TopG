import type {
  ShadowEntryBaselineReproductionSummary,
  ShadowEntryProfileExitPairingSummary,
  ShadowEntryProfileImprovementSummary,
  ShadowEntryProfileSummary,
  ShadowEntryReadinessSummary,
  ShadowEntryRecommendation,
  ShadowEntryReport,
  ShadowEntryRunSummary,
  ShadowEntryScenarioSummary,
} from "./ShadowEntryTypes.js";

export function formatShadowEntryJson(report: ShadowEntryReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatShadowEntryReport(report: ShadowEntryReport): string {
  const lines: string[] = [];

  lines.push("NeXusTrade Shadow Entry-Gate Experimentation Report");
  lines.push(`Generated: ${new Date(report.generatedAtMs).toISOString()}`);
  lines.push("");
  lines.push("Safety");
  lines.push("  mode: PAPER research");
  lines.push("  database access: read-only");
  lines.push("  paper execution: disabled");
  lines.push("  wallet loaded: no");
  lines.push("  transaction signing: disabled");
  lines.push("  transaction submission: disabled");
  lines.push("");
  lines.push("Config");
  lines.push(`  profiles: ${report.config.profileIds.join(",")}`);
  lines.push(`  source decisions: ${report.config.sourceDecisions.join(",")}`);
  lines.push(`  entry timings: ${report.config.entryTimingModes.join(",")}`);
  lines.push(`  early drawdown modes: ${report.config.earlyDrawdownModes.join(",")}`);
  lines.push(`  targets pct: ${report.config.targetPcts.join(",")}`);
  lines.push(`  stops pct: ${report.config.stopPcts.join(",")}`);
  lines.push(`  max holds minutes: ${report.config.maxHoldMinutes.join(",")}`);
  lines.push("");
  lines.push("Aggregate");
  lines.push(`  runs: ${report.aggregate.runCount}`);
  lines.push(`  observed decisions: ${report.aggregate.observedDecisionCount}`);
  lines.push(`  unique mints: ${report.aggregate.uniqueMintCount}`);
  lines.push(
    `  paper execution rows: orders=${report.aggregate.orderCount} fills=${report.aggregate.fillCount} positions=${report.aggregate.positionCount}`,
  );
  lines.push("");
  lines.push("Runs");
  lines.push(...formatRuns(report.runs));
  lines.push("");
  lines.push("Baseline Reproduction");
  lines.push(...formatBaseline(report.baselineReproduction));
  lines.push("");
  lines.push("Normalized Profile Summary");
  lines.push(
    ...formatProfiles(report.normalizedProfiles.filter((row) => row.label === "ALL").slice(0, 30)),
  );
  lines.push("");
  lines.push("Experimental Diagnostics");
  lines.push(...formatProfiles(report.profiles.filter((row) => row.label === "ALL").slice(0, 30)));
  lines.push("");
  lines.push("Improvement vs P001 baseline_raw_buy");
  lines.push(...formatImprovements(report.improvementVsBaseline.slice(0, 30)));
  lines.push("");
  lines.push("Best Exit Pairing By Profile");
  lines.push(
    ...formatBestExits(report.bestExitByProfile.filter((row) => row.label === "ALL").slice(0, 30)),
  );
  lines.push("");
  lines.push("Scenario Grid");
  lines.push(...formatScenarioRows(report.scenarioGrid.slice(0, 30)));
  lines.push("");
  lines.push("Phase 9 Readiness");
  lines.push(...formatReadiness(report.readinessByProfile));
  lines.push("");
  lines.push("Recommendations");
  lines.push(...formatRecommendations(report.recommendations));
  lines.push("");
  lines.push("Next Test Plan");
  lines.push(...report.nextTestPlan.map((step) => `  - ${step}`));

  return lines.join("\n").trimEnd();
}

function formatRuns(runs: readonly ShadowEntryRunSummary[]): string[] {
  if (runs.length === 0) return ["  none"];

  return runs.flatMap((run) => [
    `  ${run.label}: ${run.sourceKind} session=${run.sessionId ?? "n/a"}`,
    `    rows: strategy=${run.strategyRows} observedReturns=${run.observedReturnRows} observedDecisions=${run.observedDecisionCount} uniqueMints=${run.uniqueMints}`,
    `    paper rows: orders=${run.orderCount} fills=${run.fillCount} positions=${run.positionCount}`,
    ...run.warnings.map((warning) => `    warning: ${warning}`),
  ]);
}

function formatBaseline(summary: ShadowEntryBaselineReproductionSummary): string[] {
  return [
    `  applicable: ${summary.applicable ? "yes" : "no"}`,
    `  passed: ${summary.passed ? "yes" : "no"}`,
    `  reason: ${summary.reason}`,
    `  expected: entries=${summary.expected.entries} hit10=${formatNumber(
      summary.expected.target10HitRatePct,
    )}% avgWorst=${formatSigned(summary.expected.averageWorstReturnPct)}% drawdownFirst10=${formatNumber(
      summary.expected.drawdownFirst10RatePct,
    )}%`,
    `  observed: entries=${summary.observed.entries} hit10=${formatNumber(
      summary.observed.target10HitRatePct,
    )}% avgWorst=${formatOptionalSigned(
      summary.observed.averageWorstReturnPct,
    )}% drawdownFirst10=${formatNumber(summary.observed.drawdownFirst10RatePct)}%`,
  ];
}

function formatProfiles(rows: readonly ShadowEntryProfileSummary[]): string[] {
  if (rows.length === 0) return ["  none"];

  return rows.map(
    (row) =>
      `  ${row.profileKey} ${row.profileName}/${row.timingMode}: considered=${row.consideredCount} entered=${row.enteredCount} unique=${row.uniqueMints} targetFirst=${formatNumber(
        row.targetFirstRatePct,
      )}% stopFirst=${formatNumber(row.stopFirstRatePct)}% avgBest=${formatOptionalSigned(
        row.averageBestReturnPct,
      )}% avgWorst=${formatOptionalSigned(row.averageWorstReturnPct)}% missedFast=${
        row.missedFastMoveCount
      } avoided=${row.falsePositiveAvoidedCount}`,
  );
}

function formatImprovements(rows: readonly ShadowEntryProfileImprovementSummary[]): string[] {
  if (rows.length === 0) return ["  none"];

  return rows.map(
    (row) =>
      `  ${row.profileKey} ${row.profileName}: entriesDelta=${formatSigned(
        row.observedEntriesDelta,
      )} targetFirstDelta=${formatSigned(row.targetFirstRateDeltaPct)}% stopFirstDelta=${formatSigned(
        row.stopFirstRateDeltaPct,
      )}% avgWorstDelta=${formatOptionalSigned(row.averageWorstReturnDeltaPct)}% pnlDelta=${formatSigned(
        row.simulatedPnlDeltaSol,
      )} SOL drawdownDelta=${formatSigned(row.maxDrawdownDeltaPct)}%`,
  );
}

function formatBestExits(rows: readonly ShadowEntryProfileExitPairingSummary[]): string[] {
  if (rows.length === 0) return ["  none"];

  return rows.map(
    (row) =>
      `  ${row.profileKey} ${row.profileName}: target=${formatNumber(
        row.targetPct,
      )}% stop=${formatNumber(row.stopPct)}% hold=${row.maxHoldMinutes}m evaluated=${
        row.evaluatedCount
      } target=${row.targetHitCount} stop=${row.stopHitCount} pnl=${formatSigned(
        row.simulatedPnlPct,
      )}% drawdown=${formatNumber(row.maxDrawdownPct)}%`,
  );
}

function formatScenarioRows(rows: readonly ShadowEntryScenarioSummary[]): string[] {
  if (rows.length === 0) return ["  none"];

  return rows.map(
    (row) =>
      `  ${row.label}/${row.profileKey}: target=${formatNumber(row.targetPct)}% stop=${formatNumber(
        row.stopPct,
      )}% hold=${row.maxHoldMinutes}m evaluated=${row.evaluatedCount} target=${
        row.targetHitCount
      } stop=${row.stopHitCount} maxHold=${row.maxHoldCount} pnl=${formatSigned(
        row.simulatedPnlSol,
      )} SOL (${formatSigned(row.simulatedPnlPct)}%) drawdown=${formatNumber(row.maxDrawdownPct)}%`,
  );
}

function formatReadiness(rows: readonly ShadowEntryReadinessSummary[]): string[] {
  if (rows.length === 0) return ["  none"];

  return rows.map(
    (row) =>
      `  ${row.profileKey} ${row.profileName}: ${row.status} confidence=${row.confidence} stability=${row.signalStability} marketWindowWins=${formatNumber(
        row.maxMarketWindowWinConcentrationPct,
      )}% (${row.evidence.join("; ")})`,
  );
}

function formatRecommendations(recommendations: readonly ShadowEntryRecommendation[]): string[] {
  if (recommendations.length === 0) return ["  none"];

  return recommendations.flatMap((recommendation) => [
    `  - ${recommendation.category}: ${recommendation.recommendation}`,
    ...recommendation.evidence.map((item) => `    evidence: ${item}`),
  ]);
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
