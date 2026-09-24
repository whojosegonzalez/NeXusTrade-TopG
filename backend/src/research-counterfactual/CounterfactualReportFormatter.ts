import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getRepoRoot } from "../db/utils/paths.js";
import type {
  CounterfactualCandidateAnalysis,
  CounterfactualReport,
  CounterfactualScenarioSummary,
} from "./CounterfactualTypes.js";

export function formatCounterfactualJson(report: CounterfactualReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatCounterfactualReport(report: CounterfactualReport): string {
  const lines = [
    "NeXusTrade Counterfactual Decision Analysis",
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
    "Inputs",
    `  runs: ${report.config.runLabels.join(", ")}`,
    `  catalog version: ${report.config.catalogVersion}`,
    `  source decisions: ${report.config.sourceDecisions.join(",")}`,
    `  min score: ${report.config.minScore}`,
    `  targets pct: ${report.config.targetPcts.join(",")}`,
    `  stops pct: ${report.config.stopPcts.join(",")}`,
    `  max holds minutes: ${report.config.maxHoldMinutes.join(",")}`,
    `  dedupe mode: ${report.config.dedupeMode}`,
    `  scenarios: ${report.config.scenarioIds.join(",")}`,
    "",
    "Baseline Fidelity",
    `  reproduced=${report.aggregate.fidelityCounts.REPRODUCED} partial=${report.aggregate.fidelityCounts.PARTIALLY_REPRODUCED} mismatch=${report.aggregate.fidelityCounts.MISMATCH} notReplayable=${report.aggregate.fidelityCounts.NOT_REPLAYABLE}`,
    `  candidates=${report.aggregate.candidateCount} observed=${report.aggregate.observedCandidateCount} uniqueMints=${report.aggregate.uniqueMintCount}`,
    `  archive execution rows: orders=${report.aggregate.orderCount} fills=${report.aggregate.fillCount} positions=${report.aggregate.positionCount}`,
    "",
    "Scenario Summary",
    ...formatScenarioSummaries(report.scenarioSummaries),
    "",
    "Top Counterfactual Promotions",
    ...formatAnalyses(report.topPromotions),
    "",
    "Replay Exceptions",
    ...formatAnalyses(report.notReplayable),
    "",
    "Recommendation",
    `  ${report.recommendation}`,
    "",
    "Limitations",
    ...report.limitations.map((item) => `  ${item}`),
  ];

  return lines.join("\n").trimEnd();
}

export function writeCounterfactualArtifacts(input: {
  readonly report: CounterfactualReport;
  readonly outputDir: string;
}): readonly string[] {
  const outputDir = path.isAbsolute(input.outputDir)
    ? path.resolve(input.outputDir)
    : path.resolve(getRepoRoot(), input.outputDir);
  const stamp = new Date(input.report.generatedAtMs).toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `counterfactual-${stamp}.json`);
  const textPath = path.join(outputDir, `counterfactual-${stamp}.txt`);

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(jsonPath, formatCounterfactualJson(input.report), "utf8");
  writeFileSync(textPath, formatCounterfactualReport(input.report), "utf8");

  return [jsonPath, textPath];
}

function formatScenarioSummaries(
  rows: readonly CounterfactualScenarioSummary[],
): readonly string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.scenarioId}: evaluated=${row.evaluatedCount} unique=${row.uniqueMintCount} direct=${row.directEvidenceCount} gateOverride=${row.gateOverrideEvidenceCount} promotedWatch=${row.promotedToWatchCount} promotedBuy=${row.promotedToBuyCount} observedPromotions=${row.observedPromotedCount} avgBest=${formatOptional(row.averagePromotedBestReturnPct)}% avgWorst=${formatOptional(row.averagePromotedWorstReturnPct)}% targetFirst=${formatRates(row.targetFirstRates)} drawdownFirst=${formatRates(row.drawdownFirstRates)} maxMint=${formatNumber(row.maxMintPromotionSharePct)}% maxRun=${formatNumber(row.maxRunPromotionSharePct)}%`,
  );
}

function formatAnalyses(rows: readonly CounterfactualCandidateAnalysis[]): readonly string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.flatMap((analysis) => [
    `  ${analysis.candidate.symbol ?? analysis.candidate.mintAddress}: stored=${analysis.candidate.decision} score=${analysis.candidate.score ?? "n/a"} fidelity=${analysis.baseline.fidelity} best=${formatOptional(analysis.candidate.bestReturnPct)}% worst=${formatOptional(analysis.candidate.worstReturnPct)}%`,
    ...analysis.scenarios.map(
      (scenario) =>
        `    ${scenario.scenarioId}: ${scenario.outcome} -> ${scenario.counterfactualDecision ?? "n/a"}; change=${scenario.changedInput}; remaining=${scenario.remainingBlockers.join(",") || "none"}`,
    ),
    ...analysis.baseline.warnings.map((warning) => `    warning: ${warning}`),
  ]);
}

function formatOptional(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }

  const formatted = value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");

  return value > 0 ? `+${formatted}` : formatted;
}

function formatRates(rates: Readonly<Record<string, number>>): string {
  return Object.entries(rates)
    .map(([key, value]) => `${key}:${formatNumber(value)}%`)
    .join(" ");
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toString()
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
