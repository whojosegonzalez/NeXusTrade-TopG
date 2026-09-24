import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getRepoRoot } from "../db/utils/paths.js";
import type {
  FastShadowScenarioSummary,
  FastShadowValidationReport,
} from "./FastShadowValidationTypes.js";

export function formatFastShadowValidationJson(report: FastShadowValidationReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatFastShadowValidationReport(report: FastShadowValidationReport): string {
  return [
    "NeXusTrade Fast Shadow Exit Validation",
    `Generated: ${new Date(report.generatedAtMs).toISOString()}`,
    "",
    "Safety Boundary",
    "  mode: PAPER research",
    "  database access: read-only archived runs",
    "  provider calls: disabled",
    "  database writes: disabled",
    "  session creation: disabled",
    "  paper execution: disabled",
    "  wallet loaded: no",
    "  transaction signing: disabled",
    "  transaction submission: disabled",
    "",
    "Immutable Profile",
    `  ${report.profile.key}: source=${report.profile.sourceDecision} score=${report.profile.scoreRange} horizons=${report.profile.observationHorizonsMinutes.join(",")}m maxLate=${report.profile.maxLateMinutes}m`,
    "  primary: target=10% stop=15% maximumHold=15m",
    "",
    "Archive Summary",
    ...report.runs.map(
      (run) =>
        `  ${run.label}: valid=${run.mechanicallyValid} selected=${run.selectedCount} exact15=${run.selectedWith15mCoverageCount} orders=${run.orderCount} fills=${run.fillCount} positions=${run.positionCount}`,
    ),
    "",
    "Coverage",
    ...report.aggregate.coverage.map(
      (row) =>
        `  ${row.horizonMinutes}m: exactOnTime=${row.exactOnTimeCount} late=${row.lateCount} missing=${row.missingCount}`,
    ),
    "",
    "Scenario Results",
    ...report.scenarios.map(formatScenario),
    "",
    "Controls",
    ...report.controls.map((control) => `  ${control.classification}: ${control.count}`),
    "",
    "Concentration And Sample Quality",
    `  selected max mint=${number(report.concentration.maxSelectedMintSharePct)}% max run=${number(report.concentration.maxSelectedRunSharePct)}%`,
    `  primary-winner max mint=${number(report.concentration.maxPrimaryWinnerMintSharePct)}% max run=${number(report.concentration.maxPrimaryWinnerRunSharePct)}%`,
    `  leave-one-out stable: mint=${report.concentration.leaveOneMintOutStable} run=${report.concentration.leaveOneRunOutStable}`,
    `  sample gate: ${report.sampleQuality.passed ? "PASS" : "NOT YET"}`,
    ...report.sampleQuality.failedRequirements.map((item) => `    required: ${item}`),
    "",
    "Recommendation",
    `  ${report.recommendation}: ${report.recommendationReason}`,
    "",
    "Limitations",
    ...report.limitations.map((item) => `  ${item}`),
  ].join("\n");
}

export function writeFastShadowValidationArtifacts(input: {
  readonly report: FastShadowValidationReport;
  readonly outputDir: string;
}): readonly string[] {
  const outputDir = path.isAbsolute(input.outputDir)
    ? path.resolve(input.outputDir)
    : path.resolve(getRepoRoot(), input.outputDir);
  const stamp = new Date(input.report.generatedAtMs).toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `shadow-fast-exit-${stamp}.json`);
  const textPath = path.join(outputDir, `shadow-fast-exit-${stamp}.txt`);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(jsonPath, formatFastShadowValidationJson(input.report), "utf8");
  writeFileSync(textPath, formatFastShadowValidationReport(input.report), "utf8");
  return [jsonPath, textPath];
}

function formatScenario(row: FastShadowScenarioSummary): string {
  return `  ${row.scenario.name}: target=${row.scenario.targetPct}% stop=${row.scenario.stopPct}% hold=${row.scenario.maxHoldMinutes}m evaluable=${row.evaluableCount}/${row.candidateCount} targetFirst=${row.targetFirstCount} (${number(row.targetFirstRatePct)}%) stopFirst=${row.stopFirstCount} (${number(row.stopFirstRatePct)}%) maxHold=${row.maxHoldCount} missing=${row.noObservationCount} MFE=${optional(row.medianMfePct)}% MAE=${optional(row.medianMaePct)}% exit=${optional(row.medianExitReturnPct)}%`;
}

function optional(value: number | undefined): string {
  return value === undefined ? "n/a" : number(value);
}

function number(value: number): string {
  const formatted = value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return value > 0 ? `+${formatted}` : formatted;
}
