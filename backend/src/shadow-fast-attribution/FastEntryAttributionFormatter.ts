import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getRepoRoot } from "../db/utils/paths.js";
import type {
  FastEntryAttributionReport,
  FastEntryFeatureValue,
} from "./FastEntryAttributionTypes.js";

export function formatFastEntryAttributionJson(report: FastEntryAttributionReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatFastEntryAttributionReport(report: FastEntryAttributionReport): string {
  return [
    "NeXusTrade Fast-Entry Feature Attribution",
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
    "Immutable Contract",
    `  source=${report.profile.sourceProfileKey} analysis=${report.profile.analysisKey} baseline=${report.profile.originalBuyScoreThreshold}/${report.profile.originalWatchScoreThreshold}`,
    `  labels only: target=${report.profile.primaryScenario.targetPct}% stop=${report.profile.primaryScenario.stopPct}% hold=${report.profile.primaryScenario.maxHoldMinutes}m horizons=${report.profile.observationHorizonsMinutes.join(",")}m`,
    "",
    "Archive Summary",
    ...report.runs.map(
      (run) =>
        `  ${run.label}: valid=${run.mechanicallyValid} selected=${run.selectedCount} labels=${formatLabelCounts(run.labelCounts)} orders=${run.orderCount} fills=${run.fillCount} positions=${run.positionCount}`,
    ),
    "",
    "Cohort And Concentration",
    `  selected=${report.aggregate.selectedCount} exact3/5/15=${report.aggregate.exactCoverageCount} labels=${formatLabelCounts(report.aggregate.labelCounts)}`,
    `  selected run shares: ${formatShares(report.aggregate.selectedRunSharesPct)}`,
    `  target run shares: ${formatShares(report.aggregate.targetRunSharesPct)}`,
    `  non-target run shares: ${formatShares(report.aggregate.nonTargetRunSharesPct)}`,
    "",
    "Defensibility Gates",
    ...report.gates.map(
      (gate) => `  ${gate.passed ? "PASS" : "FAIL"} ${gate.name}: ${gate.detail}`,
    ),
    "",
    "Feature Attribution",
    ...report.featureSummaries.map(
      (summary) =>
        `  ${summary.family}/${summary.key}: available=${summary.availableCount}/${summary.candidateCount} variation=${summary.hasVariation} ${summary.byLabel.map((row) => `${row.label}=${row.availableCount}/${row.candidateCount}[${row.values.map(formatValue).join(",") || "n/a"}]`).join(" ")}`,
    ),
    "",
    "Candidate Audit",
    ...report.candidates
      .slice(0, 50)
      .map(
        (candidate) =>
          `  ${candidate.runLabel} ${candidate.symbol ?? candidate.decisionId}: label=${candidate.primaryLabel} class=${candidate.classification} exact=${candidate.exactCoverage.map((row) => `${row.horizonMinutes}m:${row.onTime}`).join(",")}`,
      ),
    "",
    "Recommendation",
    `  ${report.recommendation}: ${report.recommendationReason}`,
    ...(report.successor
      ? [
          `  successor=${report.successor.profileId}@${report.successor.version} predicate=${report.successor.featureKey} equals ${formatValue(report.successor.expectedValue)}`,
          `  rationale=${report.successor.rationale}`,
          ...report.successor.collectionContract.map((item) => `  collection: ${item}`),
          ...report.successor.promotionGates.map((item) => `  promotion: ${item}`),
        ]
      : []),
    "",
    "Limitations",
    ...report.limitations.map((limitation) => `  ${limitation}`),
  ].join("\n");
}

export function writeFastEntryAttributionArtifacts(input: {
  readonly report: FastEntryAttributionReport;
  readonly outputDir: string;
}): readonly string[] {
  const outputDir = path.isAbsolute(input.outputDir)
    ? path.resolve(input.outputDir)
    : path.resolve(getRepoRoot(), input.outputDir);
  const stamp = new Date(input.report.generatedAtMs).toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `shadow-fast-attribution-${stamp}.json`);
  const textPath = path.join(outputDir, `shadow-fast-attribution-${stamp}.txt`);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(jsonPath, formatFastEntryAttributionJson(input.report), "utf8");
  writeFileSync(textPath, formatFastEntryAttributionReport(input.report), "utf8");
  return [jsonPath, textPath];
}

function formatLabelCounts(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .map(([label, count]) => `${label}=${count}`)
    .join(",");
}

function formatShares(shares: Readonly<Record<string, number>>): string {
  const values = Object.entries(shares).map(([run, share]) => `${run}=${share.toFixed(2)}%`);
  return values.length === 0 ? "none" : values.join(",");
}

function formatValue(value: FastEntryFeatureValue): string {
  if (Array.isArray(value)) return `[${value.join("|")}]`;
  return String(value);
}
