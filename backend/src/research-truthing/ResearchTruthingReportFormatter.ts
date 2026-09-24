import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getRepoRoot } from "../db/utils/paths.js";
import type {
  ResearchTruthingArchiveCounts,
  ResearchTruthingConcentrationRow,
  ResearchTruthingLimitMetadata,
  ResearchTruthingOutcomeSummary,
  ResearchTruthingProviderReclassification,
  ResearchTruthingReport,
} from "./ResearchTruthingTypes.js";

export function formatResearchTruthingJson(report: ResearchTruthingReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatResearchTruthingReport(report: ResearchTruthingReport): string {
  const lines: string[] = [];
  const selectedRecommendation = report.recommendations.find((item) => item.selected);

  lines.push("NeXusTrade Research Truthing Report");
  lines.push(`Generated: ${new Date(report.generatedAtMs).toISOString()}`);
  lines.push("");
  lines.push("Safety Boundary");
  lines.push(`  passed: ${report.safety.passed ? "yes" : "no"}`);
  lines.push(`  mode: ${report.safety.mode}`);
  lines.push(`  database access: ${report.safety.databaseAccess}`);
  lines.push("  live provider calls: no");
  lines.push("  paper BUY automation: disabled");
  lines.push("  wallet loaded: no");
  lines.push("  transaction signing: disabled");
  lines.push("  transaction submission: disabled");
  lines.push("");
  lines.push("Inputs");
  lines.push(`  runs: ${report.config.runLabels.join(", ")}`);
  lines.push(`  dedupe mode: ${report.config.dedupeMode}`);
  lines.push(`  source decisions: ${report.config.sourceDecisions.join(",")}`);
  lines.push(`  min score: ${report.config.minScore}`);
  lines.push(`  top limit: ${report.config.topLimit}`);
  lines.push(
    `  runner cycles included in report JSON: ${report.archives.some((archive) => archive.runnerCyclesIncluded) ? "yes" : "no"}`,
  );
  lines.push("");
  lines.push("Archive Database Counts");
  lines.push(...formatArchiveCounts(report.archiveCounts));
  lines.push("");
  lines.push("Report Limit And Truncation Audit");
  lines.push(...formatLimitAudit(report.reportLimitAudit));
  lines.push("");
  lines.push("Decision Row Truth Table");
  lines.push(`  rowsAvailable: ${report.decisionTruthTable.rowsAvailable}`);
  lines.push(`  rowsEvaluated: ${report.decisionTruthTable.rowsEvaluated}`);
  lines.push(`  rowsDisplayed: ${report.decisionTruthTable.rowsDisplayed}`);
  lines.push(`  displayLimit: ${report.decisionTruthTable.displayLimit}`);
  lines.push(`  displayTruncated: ${report.decisionTruthTable.displayTruncated ? "yes" : "no"}`);
  lines.push(`  omittedDisplayRows: ${report.decisionTruthTable.omittedDisplayRows}`);
  lines.push(`  considered: ${report.decisionTruthTable.consideredDefinition}`);
  lines.push("");
  lines.push("Quote Evidence Attribution");
  lines.push(`  candidates: ${report.quoteEvidence.totalCandidates}`);
  lines.push(`  missingQuote: ${report.quoteEvidence.missingQuoteCount}`);
  lines.push(`  directMissingQuote: ${report.quoteEvidence.directMissingQuoteCount}`);
  lines.push(`  correlatedMissingQuote: ${report.quoteEvidence.correlatedMissingQuoteCount}`);
  lines.push(
    `  insufficientArchiveEvidenceMissingQuote: ${report.quoteEvidence.insufficientArchiveEvidenceMissingQuoteCount}`,
  );
  lines.push(`  unclassifiedMissingQuote: ${report.quoteEvidence.unclassifiedMissingQuoteCount}`);
  lines.push(
    `  quotePresentButImpactMissing: ${report.quoteEvidence.quotePresentButImpactMissingCount}`,
  );
  lines.push(`  categories: ${formatCounts(report.quoteEvidence.categoryCounts)}`);
  lines.push(
    `  explanationConfidence: ${formatCounts(report.quoteEvidence.explanationConfidenceCounts)}`,
  );
  lines.push(`  providers: ${formatCounts(report.quoteEvidence.providerCounts)}`);
  lines.push(`  sourceTypes: ${formatCounts(report.quoteEvidence.sourceTypeCounts)}`);
  lines.push(`  failureReasons: ${formatCounts(report.quoteEvidence.failureReasonCounts)}`);
  lines.push(...report.quoteEvidence.notes.map((note) => `  note: ${note}`));
  lines.push("");
  lines.push("Birdeye Attribution");
  lines.push(`  rows: ${report.birdeyeAttribution.totalRows}`);
  lines.push(`  liveCalls: ${report.birdeyeAttribution.liveCalls}`);
  lines.push(`  livePriceCalls: ${report.birdeyeAttribution.livePriceCalls}`);
  lines.push(`  liveOverviewCalls: ${report.birdeyeAttribution.liveOverviewCalls}`);
  lines.push(`  cacheHits: ${report.birdeyeAttribution.cacheHits}`);
  lines.push(`  cachedPriceRows: ${report.birdeyeAttribution.cachedPriceRows}`);
  lines.push(`  cachedOverviewRows: ${report.birdeyeAttribution.cachedOverviewRows}`);
  lines.push(`  estimatedCuTotal: ${report.birdeyeAttribution.estimatedCuTotal}`);
  lines.push(
    `  reportedCumulativeCuByRun: ${formatCounts(report.birdeyeAttribution.reportedCumulativeCuByRun)}`,
  );
  lines.push(`  budgetSkips: ${report.birdeyeAttribution.budgetSkipCount}`);
  lines.push(`  budgetSkippedPriceRows: ${report.birdeyeAttribution.budgetSkippedPriceRows}`);
  lines.push(`  budgetSkippedOverviewRows: ${report.birdeyeAttribution.budgetSkippedOverviewRows}`);
  lines.push(`  providerFailures: ${report.birdeyeAttribution.providerFailureCount}`);
  lines.push(`  uniqueEnrichedMints: ${report.birdeyeAttribution.uniqueEnrichedMints}`);
  lines.push(`  endpoints: ${formatCounts(report.birdeyeAttribution.endpointCounts)}`);
  lines.push(`  cache: ${formatCounts(report.birdeyeAttribution.cacheStatusCounts)}`);
  lines.push(`  failures: ${formatCounts(report.birdeyeAttribution.failureCounts)}`);
  lines.push(`  reasons: ${formatCounts(report.birdeyeAttribution.selectionReasonCounts)}`);
  lines.push(`  enriched: ${formatOutcome(report.birdeyeAttribution.enrichedCohort)}`);
  lines.push(
    `  eligibleControl: ${formatOutcome(report.birdeyeAttribution.eligibleControlCohort)}`,
  );
  lines.push(...report.birdeyeAttribution.notes.map((note) => `  note: ${note}`));
  lines.push("");
  lines.push("Provider Failure Reclassification");
  lines.push(...formatProviders(report.providerReclassification));
  lines.push("");
  lines.push("Concentration Analysis");
  lines.push("  by run:");
  lines.push(...formatConcentration(report.concentration.byRun));
  lines.push("  by mint:");
  lines.push(...formatConcentration(report.concentration.byMint.slice(0, 10)));
  lines.push(...report.concentration.notes.map((note) => `  note: ${note}`));
  lines.push("");
  lines.push("Blocker Classification Audit");
  lines.push(`  skipWithNoBlockers: ${report.blockerAudit.skipWithNoBlockers}`);
  lines.push(`  scoreThresholdOnly: ${report.blockerAudit.scoreThresholdOnly}`);
  lines.push(`  unresolvedStrategyGate: ${report.blockerAudit.unresolvedStrategyGate}`);
  lines.push(`  insufficientArchiveEvidence: ${report.blockerAudit.insufficientArchiveEvidence}`);
  lines.push(`  highScoringSkips: ${report.blockerAudit.highScoringSkips}`);
  lines.push(`  riskPassSkips: ${report.blockerAudit.riskPassSkips}`);
  lines.push(`  quoteAvailableImpactMissing: ${report.blockerAudit.quoteAvailableImpactMissing}`);
  lines.push(`  thresholdSources: ${formatCounts(report.blockerAudit.thresholdSourceCounts)}`);
  lines.push("");
  lines.push("Scenario Portfolio Audit");
  lines.push(...formatScenarioRows(report));
  lines.push(...report.scenarioPortfolioAudit.notes.map((note) => `  note: ${note}`));
  lines.push("");
  lines.push("Truthing Findings");
  lines.push(...report.findings.map((finding) => `  - ${finding}`));
  lines.push("");
  lines.push("Recommendation Gate");
  lines.push(
    `  selected: ${selectedRecommendation?.recommendationCode ?? "none"} ${
      selectedRecommendation?.label ?? ""
    }`.trimEnd(),
  );
  lines.push(...formatRecommendations(report));

  return lines.join("\n").trimEnd();
}

export function writeResearchTruthingArtifacts(input: {
  readonly report: ResearchTruthingReport;
  readonly outputDir: string;
}): readonly string[] {
  const resolvedOutputDir = path.isAbsolute(input.outputDir)
    ? path.resolve(input.outputDir)
    : path.resolve(getRepoRoot(), input.outputDir);
  const stamp = new Date(input.report.generatedAtMs).toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(resolvedOutputDir, `research-truthing-${stamp}.json`);
  const textPath = path.join(resolvedOutputDir, `research-truthing-${stamp}.txt`);

  mkdirSync(resolvedOutputDir, { recursive: true });
  writeFileSync(jsonPath, formatResearchTruthingJson(input.report), "utf8");
  writeFileSync(textPath, formatResearchTruthingReport(input.report), "utf8");

  return [jsonPath, textPath];
}

function formatArchiveCounts(rows: readonly ResearchTruthingArchiveCounts[]): readonly string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.flatMap((row) => [
    `  ${row.label}: oneSession=${row.oneSession ? "yes" : "no"} session=${row.sessionId ?? "n/a"}`,
    `    rows: ${formatCounts(row.tableCounts)}`,
    ...row.warnings.map((warning) => `    warning: ${warning}`),
  ]);
}

function formatLimitAudit(rows: readonly ResearchTruthingLimitMetadata[]): readonly string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.sectionName}: available=${row.rowsAvailable} evaluated=${row.rowsEvaluated} displayed=${row.rowsDisplayed} limit=${row.displayLimit} truncated=${row.displayTruncated ? "yes" : "no"} omitted=${row.omittedDisplayRows}`,
  );
}

function formatProviders(
  rows: readonly ResearchTruthingProviderReclassification[],
): readonly string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.provider}: total=${row.total} classes=${formatCounts(row.classes)} failures=${formatCounts(
        row.failureCounts,
      )} diagnostics=${formatCounts(row.diagnosticCounts)}`,
  );
}

function formatConcentration(rows: readonly ResearchTruthingConcentrationRow[]): readonly string[] {
  if (rows.length === 0) {
    return ["    none"];
  }

  return rows.map(
    (row) =>
      `    ${row.label ?? row.key}: decisions=${row.decisionCount} observed=${
        row.observedCount
      } targetFirst=${row.targetFirstWins} observedShare=${formatNumber(
        row.shareOfObservedPct,
      )}% targetFirstShare=${formatNumber(row.shareOfTargetFirstWinsPct)}%`,
  );
}

function formatScenarioRows(report: ResearchTruthingReport): readonly string[] {
  return report.scenarioPortfolioAudit.rows
    .slice(0, report.config.topLimit)
    .map(
      (row) =>
        `  target=${row.targetPct}% stop=${row.stopPct}% hold=${row.maxHoldMinutes}m entries=${row.entriesConsidered} unique=${row.uniqueMints} targetFirst=${row.targetFirstCount} stopFirst=${row.drawdownFirstCount} unobserved=${row.unobservedCount} avgExit=${formatOptional(row.averageExitReturnPct)}% truncated=${row.truncated ? "yes" : "no"}`,
    );
}

function formatRecommendations(report: ResearchTruthingReport): readonly string[] {
  return report.recommendations.flatMap((row) => [
    `  ${row.selected ? "*" : "-"} ${row.recommendationCode}. ${row.label}`,
    `    next: ${row.requiredNextAction}`,
    `    safety: ${row.safetyCaveat}`,
    ...row.evidenceFor.map((item) => `    for: ${item}`),
    ...row.evidenceAgainst.map((item) => `    against: ${item}`),
  ]);
}

function formatOutcome(row: ResearchTruthingOutcomeSummary): string {
  return `n=${row.count} unique=${row.uniqueMints} observed=${row.observedCount} coverage=${formatNumber(
    row.observedCoveragePct,
  )}% comparison=${row.outcomeComparisonStatus} avgBest=${formatOptional(
    row.averageBestReturnPct,
  )}% avgWorst=${formatOptional(row.averageWorstReturnPct)}%`;
}

function formatCounts(counts: Readonly<Record<string, number>>): string {
  const formatted = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");

  return formatted || "none";
}

function formatOptional(value: number | undefined): string {
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
