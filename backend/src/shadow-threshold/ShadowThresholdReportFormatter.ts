import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getRepoRoot } from "../db/utils/paths.js";
import type {
  ShadowThresholdReport,
  ShadowThresholdScenarioSummary,
  ShadowThresholdSelectedCandidate,
} from "./ShadowThresholdTypes.js";

export function formatShadowThresholdJson(report: ShadowThresholdReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatShadowThresholdReport(report: ShadowThresholdReport): string {
  const lines = [
    "NeXusTrade Narrow Shadow Threshold Validation",
    `Generated: ${new Date(report.generatedAtMs).toISOString()}`,
    "",
    "Safety Boundary",
    "  mode: PAPER research",
    "  database access: read-only archived runs",
    "  provider calls: disabled",
    "  database writes: disabled",
    "  session creation: disabled",
    "  strategy defaults changed: no",
    "  paper execution: disabled",
    "  wallet loaded: no",
    "  transaction signing: disabled",
    "  transaction submission: disabled",
    "",
    "Immutable Profile",
    `  ${report.config.profileKey}: source=${report.config.sourceDecision} score=${report.config.scoreMin}-${report.config.scoreMax} baseline=${report.config.originalBuyScoreThreshold}/${report.config.originalWatchScoreThreshold}`,
    `  selection: ${report.config.selectionMode}`,
    `  targets: ${report.config.targetPcts.join(",")} stops: ${report.config.stopPcts.join(",")} holds: ${report.config.maxHoldMinutes.join(",")}`,
    "",
    "Archive Summary",
    ...report.runs.map(
      (run) =>
        `  ${run.label}: valid=${run.mechanicallyValid} decisions=${run.sourceDecisionCount} selected=${run.selectedCount} observed=${run.selectedObservedCount} uniqueMints=${run.uniqueSelectedMints} orders=${run.orderCount} fills=${run.fillCount} positions=${run.positionCount}`,
    ),
    "",
    "Cohort Classification",
    ...Object.entries(report.aggregate.classificationCounts).map(
      ([classification, count]) => `  ${classification}: ${count}`,
    ),
    `  eligible before first-per-mint selection: ${report.aggregate.thresholdOnlyEligibleCount}`,
    `  selected=${report.aggregate.selectedCount} observed=${report.aggregate.selectedObservedCount} observed60=${report.aggregate.selectedWith60mObservationCount} uniqueMints=${report.aggregate.uniqueSelectedMintCount}`,
    "",
    "Scenario Summary",
    ...formatScenarios(report.scenarios),
    "",
    "Control Cohorts",
    ...report.controls.map(
      (control) =>
        `  ${control.classification}: count=${control.count} observed=${control.observedCount} uniqueMints=${control.uniqueMints} avgBest=${formatOptional(control.averageBestReturnPct)}% avgWorst=${formatOptional(control.averageWorstReturnPct)}%`,
    ),
    "",
    "Concentration And Sample Quality",
    `  selected max mint=${formatNumber(report.concentration.maxSelectedMintSharePct)}% max run=${formatNumber(report.concentration.maxSelectedRunSharePct)}%`,
    `  target-first max mint=${formatNumber(report.concentration.maxTargetFirstMintSharePct)}% max run=${formatNumber(report.concentration.maxTargetFirstRunSharePct)}%`,
    `  leave-one-out stable: run=${report.concentration.leaveOneRunOutStable} mint=${report.concentration.leaveOneMintOutStable}`,
    `  sample gate: ${report.sampleQuality.sampleGatePassed ? "PASS" : "NOT YET"}`,
    ...report.sampleQuality.failedRequirements.map((requirement) => `    required: ${requirement}`),
    "",
    "Selected Candidate Audit (first 50)",
    ...formatCandidates(report.selectedCandidates),
    "",
    "Recommendation",
    `  ${report.recommendation}: ${report.recommendationReason}`,
    "",
    "Limitations",
    ...report.limitations.map((limitation) => `  ${limitation}`),
  ];

  return lines.join("\n").trimEnd();
}

export function writeShadowThresholdArtifacts(input: {
  readonly report: ShadowThresholdReport;
  readonly outputDir: string;
}): readonly string[] {
  const outputDir = path.isAbsolute(input.outputDir)
    ? path.resolve(input.outputDir)
    : path.resolve(getRepoRoot(), input.outputDir);
  const stamp = new Date(input.report.generatedAtMs).toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `shadow-threshold-${stamp}.json`);
  const textPath = path.join(outputDir, `shadow-threshold-${stamp}.txt`);

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(jsonPath, formatShadowThresholdJson(input.report), "utf8");
  writeFileSync(textPath, formatShadowThresholdReport(input.report), "utf8");

  return [jsonPath, textPath];
}

function formatScenarios(rows: readonly ShadowThresholdScenarioSummary[]): readonly string[] {
  return rows.map(
    (row) =>
      `  target=${row.targetPct}% stop=${row.stopPct}% hold=${row.maxHoldMinutes}m candidates=${row.candidateCount} observed=${row.observedCount} targetFirst=${row.targetFirstCount} (${formatNumber(row.targetFirstRatePct)}%) stopFirst=${row.stopFirstCount} (${formatNumber(row.stopFirstRatePct)}%) ambiguous=${row.ambiguousCount} neither=${row.neitherCount} mfe=${formatOptional(row.medianMfePct)}% mae=${formatOptional(row.medianMaePct)}%`,
  );
}

function formatCandidates(rows: readonly ShadowThresholdSelectedCandidate[]): readonly string[] {
  if (rows.length === 0) return ["  none"];

  return rows.slice(0, 50).map((candidate) => {
    const horizon60 = candidate.outcomes.find((outcome) => outcome.maxHoldMinutes === 60);
    const race = horizon60?.races.find((item) => item.targetPct === 10 && item.stopPct === 10);

    return `  ${candidate.profileKey} ${candidate.runLabel} ${candidate.symbol ?? candidate.mintAddress}: score=${candidate.score ?? "n/a"} baseline=${candidate.attribution.buyScoreThreshold ?? "n/a"}/${candidate.attribution.watchScoreThreshold ?? "n/a"} class=${candidate.classification} observed=${candidate.observedPoints.length} 60mMFE=${formatOptional(horizon60?.mfePct)}% 60mMAE=${formatOptional(horizon60?.maePct)}% 10/10=${race?.outcome ?? "n/a"}`;
  });
}

function formatOptional(value: number | undefined): string {
  return value === undefined ? "n/a" : formatNumber(value);
}

function formatNumber(value: number): string {
  const formatted = value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return value > 0 ? `+${formatted}` : formatted;
}
