import type {
  ShadowCandidateResult,
  ShadowExitReport,
  ShadowExitScenario,
  ShadowObservedReturn,
  ShadowScenarioSummary,
} from "./ShadowTypes.js";

export function formatShadowExitReport(report: ShadowExitReport): string {
  return [
    "NeXusTrade Shadow Exit Report",
    `Generated: ${new Date(report.generatedAtMs).toISOString()}`,
    "",
    "Session",
    `  id: ${report.session.id}`,
    `  mode/status: ${report.session.mode}/${report.session.status}`,
    "",
    "Config",
    `  source decisions: ${report.config.sourceDecisions.join(",")}`,
    `  include shadow scores: ${report.config.includeShadowScores ? "yes" : "no"}`,
    `  shadow score min: ${report.config.shadowScoreMin}`,
    `  targets: ${report.config.targetPcts.join(",")}%`,
    `  stops: ${report.config.stopPcts.join(",")}%`,
    `  max hold: ${report.config.maxHoldMinutes}m`,
    `  simulated balance: ${formatNumber(report.config.startingBalanceSol)} SOL`,
    `  position size: ${formatNumber(report.config.positionSizeSol)} SOL`,
    `  session goal: ${formatNumber(report.config.sessionGoalPct)}%`,
    "",
    "Selection",
    `  selected: ${report.selectedCount}`,
    `  skipped: ${report.skippedCount}`,
    ...report.skippedReasons.slice(0, 5).map((reason) => `  skipped reason: ${reason}`),
    "",
    "Scenario Summary",
    ...report.scenarioSummaries.slice(0, 12).map(formatScenarioSummary),
    "",
    "Candidates",
    ...report.candidates.map(formatCandidate),
    "",
    "Shadow Portfolio",
    `  starting: ${formatNumber(report.portfolio.startingBalanceSol)} SOL`,
    `  ending: ${formatNumber(report.portfolio.endingBalanceSol)} SOL`,
    `  pnl: ${formatSigned(report.portfolio.pnlSol)} SOL (${formatSigned(
      report.portfolio.pnlPct,
    )}%)`,
    `  goal: ${formatNumber(report.portfolio.goalBalanceSol)} SOL reached=${
      report.portfolio.goalReached ? "yes" : "no"
    }`,
    `  trades: ${report.portfolio.trades.length} winners=${report.portfolio.winningTrades} losers=${report.portfolio.losingTrades}`,
    `  max drawdown: ${formatNumber(report.portfolio.maxDrawdownPct)}%`,
    "",
    "Recommendations",
    ...report.recommendations.map((recommendation) => `  - ${recommendation}`),
  ].join("\n");
}

export function formatShadowExitJson(report: ShadowExitReport): string {
  return JSON.stringify(report, null, 2);
}

function formatScenarioSummary(summary: ShadowScenarioSummary): string {
  return [
    `  target=${formatNumber(summary.targetPct)}%`,
    `stop=${formatNumber(summary.stopPct)}%`,
    `hold=${summary.maxHoldMinutes}m:`,
    `evaluated=${summary.evaluatedCount}`,
    `targetHit=${summary.targetHitCount}`,
    `stopHit=${summary.stopHitCount}`,
    `maxHold=${summary.maxHoldCount}`,
    `avgExit=${formatOptionalSigned(summary.averageExitReturnPct)}%`,
    `targetHitRate=${formatNumber(summary.targetHitRatePct)}%`,
  ].join(" ");
}

function formatCandidate(candidate: ShadowCandidateResult): string {
  const primaryScenario = candidate.outcomes[0];
  const scenarioText = primaryScenario
    ? ` exit=${primaryScenario.exitReason}@${formatHorizon(primaryScenario.exitHorizonMinutes)} return=${formatOptionalSigned(
        primaryScenario.exitReturnPct,
      )}% scenario=${formatScenario(primaryScenario.scenario)}`
    : "";

  return [
    `  ${candidate.symbol ?? candidate.mintAddress}`,
    `decision=${candidate.decision}`,
    `score=${candidate.score ?? "n/a"}`,
    `mode=${candidate.selectionMode}`,
    `best=${formatOptionalSigned(candidate.bestReturnPct)}%`,
    `worst=${formatOptionalSigned(candidate.worstReturnPct)}%`,
    `returns=${formatObservedReturns(candidate.observedReturns)}`,
    scenarioText,
  ]
    .filter(Boolean)
    .join(" ");
}

function formatScenario(scenario: ShadowExitScenario): string {
  return `${formatNumber(scenario.targetPct)}/${formatNumber(scenario.stopPct)}/${scenario.maxHoldMinutes}m`;
}

function formatObservedReturns(observedReturns: readonly ShadowObservedReturn[]): string {
  if (observedReturns.length === 0) {
    return "none";
  }

  return observedReturns
    .map((observed) => `${observed.horizonMinutes}m=${formatSigned(observed.returnPct)}%`)
    .join(",");
}

function formatHorizon(horizon: number | undefined): string {
  return horizon === undefined ? "n/a" : `${horizon}m`;
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
