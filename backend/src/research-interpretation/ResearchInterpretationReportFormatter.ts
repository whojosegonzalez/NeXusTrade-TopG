import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getRepoRoot } from "../db/utils/paths.js";
import type {
  ResearchBlockerSummary,
  ResearchGroupedOutcomeSummary,
  ResearchInterpretationReport,
  ResearchMarketWindowSummary,
  ResearchOpportunityRow,
  ResearchRecommendationMatrixRow,
  ResearchTokenSummary,
} from "./ResearchInterpretationTypes.js";

export function formatResearchInterpretationJson(report: ResearchInterpretationReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatResearchInterpretationReport(report: ResearchInterpretationReport): string {
  const lines: string[] = [];

  lines.push("NeXusTrade Research Interpretation Report");
  lines.push(`Generated: ${new Date(report.generatedAtMs).toISOString()}`);
  lines.push("");
  lines.push("Safety");
  lines.push("  mode: PAPER research");
  lines.push("  database access: read-only archived runs");
  lines.push("  paper BUY automation: disabled");
  lines.push("  wallet loaded: no");
  lines.push("  transaction signing: disabled");
  lines.push("  transaction submission: disabled");
  lines.push("");
  lines.push("Inputs");
  lines.push(`  runs: ${report.config.runLabels.join(", ")}`);
  lines.push(`  source decisions: ${report.config.sourceDecisions.join(",")}`);
  lines.push(`  min score: ${report.config.minScore}`);
  lines.push(`  dedupe mode: ${report.config.dedupeMode}`);
  lines.push(`  targets pct: ${report.config.targetPcts.join(",")}`);
  lines.push(`  stops pct: ${report.config.stopPcts.join(",")}`);
  lines.push(`  max holds minutes: ${report.config.maxHoldMinutes.join(",")}`);
  lines.push("");
  lines.push("Run Validity Snapshot");
  lines.push(...formatRunValidations(report));
  lines.push("");
  lines.push("Decision Attribution Summary");
  lines.push(`  candidates: ${report.candidates.length}`);
  lines.push(`  observed decisions: ${report.aggregate.observedDecisionCount}`);
  lines.push(`  unique mints: ${report.aggregate.uniqueMintCount}`);
  lines.push(
    `  paper execution rows: orders=${report.aggregate.orderCount} fills=${report.aggregate.fillCount} positions=${report.aggregate.positionCount}`,
  );
  lines.push("");
  lines.push("Top Blockers");
  lines.push(...formatBlockers(report.blockerSummaries));
  lines.push("");
  lines.push("High-Scoring SKIP Review");
  lines.push(...formatOpportunities(report.highScoringSkips));
  lines.push("");
  lines.push("WARN Outcome Analysis");
  lines.push(...formatGroupedOutcomes(report.warnOutcomeSummaries));
  lines.push("");
  lines.push("Missing Quote Outcome Analysis");
  lines.push(...formatGroupedOutcomes([report.missingQuoteAnalysis.missingQuote]));
  lines.push(...formatGroupedOutcomes([report.missingQuoteAnalysis.quoteAvailable]));
  lines.push(...report.missingQuoteAnalysis.notes.map((note) => `  note: ${note}`));
  lines.push("");
  lines.push("Provider Interpretation");
  lines.push(...formatProviders(report));
  lines.push("");
  lines.push("Quote Budget Allocation");
  lines.push(
    `  riskCycles=${report.missingQuoteAnalysis.quoteBudget.riskCycleCount} plannerEnabledCycles=${report.missingQuoteAnalysis.quoteBudget.plannerEnabledCycleCount} selected=${report.missingQuoteAnalysis.quoteBudget.selectedCount} notSelected=${report.missingQuoteAnalysis.quoteBudget.notSelectedCount} skippedLiveCallsEstimate=${report.missingQuoteAnalysis.quoteBudget.skippedLiveCallsEstimate}`,
  );
  lines.push("");
  lines.push("Market Window Analysis");
  lines.push(...formatMarketWindows(report.marketWindows));
  lines.push("");
  lines.push("Per-Token Missed Opportunities");
  lines.push(...formatTokenSummaries(report.tokenSummaries));
  lines.push("");
  lines.push("Phase 9.25 Recommendation Matrix");
  lines.push(...formatRecommendationMatrix(report.recommendationMatrix));

  return lines.join("\n").trimEnd();
}

export function writeResearchInterpretationArtifacts(input: {
  readonly report: ResearchInterpretationReport;
  readonly outputDir: string;
}): readonly string[] {
  const resolvedOutputDir = path.isAbsolute(input.outputDir)
    ? path.resolve(input.outputDir)
    : path.resolve(getRepoRoot(), input.outputDir);
  const stamp = new Date(input.report.generatedAtMs).toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(resolvedOutputDir, `research-interpretation-${stamp}.json`);
  const textPath = path.join(resolvedOutputDir, `research-interpretation-${stamp}.txt`);

  mkdirSync(resolvedOutputDir, { recursive: true });
  writeFileSync(jsonPath, formatResearchInterpretationJson(input.report), "utf8");
  writeFileSync(textPath, formatResearchInterpretationReport(input.report), "utf8");

  return [jsonPath, textPath];
}

function formatRunValidations(report: ResearchInterpretationReport): readonly string[] {
  if (report.runValidations.length === 0) {
    return ["  none"];
  }

  return report.runValidations.flatMap((run) => [
    `  ${run.label}: safety=${run.safetyStatus} cycles=${run.cycleCount} oneSession=${
      run.oneSession ? "yes" : "no"
    }`,
    `    session: terminal=${run.terminalSessionId ?? "n/a"} db=${run.databaseSessionId ?? "n/a"}`,
    `    rows: orders=${run.orderCount} fills=${run.fillCount} positions=${run.positionCount}`,
    ...run.warnings.map((warning) => `    warning: ${warning}`),
  ]);
}

function formatBlockers(rows: readonly ResearchBlockerSummary[]): readonly string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.blocker}: n=${row.count} unique=${row.uniqueMints} observed=${row.observedCount} avgScore=${formatOptional(
        row.averageScore,
      )} avgBest=${formatOptional(row.averageBestReturnPct)}% avgWorst=${formatOptional(
        row.averageWorstReturnPct,
      )}% examples=${row.exampleMints.join(",")}`,
  );
}

function formatGroupedOutcomes(rows: readonly ResearchGroupedOutcomeSummary[]): readonly string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.label}: n=${row.count} unique=${row.uniqueMints} observed=${
        row.observedCount
      } avgBest=${formatOptional(row.averageBestReturnPct)}% avgWorst=${formatOptional(
        row.averageWorstReturnPct,
      )}% hit=${formatRates(row.targetHitRates)} drawdownFirst=${formatRates(
        row.drawdownFirstRates,
      )}`,
  );
}

function formatOpportunities(rows: readonly ResearchOpportunityRow[]): readonly string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.symbol ?? row.mintAddress}: decision=${row.decision} score=${
        row.score ?? "n/a"
      } best=${formatOptional(row.bestReturnPct)}% worst=${formatOptional(
        row.worstReturnPct,
      )}% primary=${row.primaryBlocker} quoteMissing=${row.missingQuote ? "yes" : "no"}`,
  );
}

function formatProviders(report: ResearchInterpretationReport): readonly string[] {
  if (report.missingQuoteAnalysis.providers.length === 0) {
    return ["  none"];
  }

  return report.missingQuoteAnalysis.providers.map(
    (provider) =>
      `  ${provider.provider}: total=${provider.total} liveRateLimited=${formatNumber(
        provider.liveRateLimitedPercent,
      )}% combinedRateLimited=${formatNumber(provider.combinedRateLimitedPercent)}% cacheHits=${
        provider.routerCacheHits
      } cooldownSkips=${provider.routerCooldownSkips}${formatCountsSuffix(
        " quoteSourceTypes",
        provider.quoteSourceTypeCounts,
      )}${formatCountsSuffix(
        " fallbackReasons",
        provider.quoteFallbackReasonCounts,
      )}${formatCountsSuffix(
        " raydiumFailures",
        provider.raydiumFailureCategoryCounts,
      )}${formatCountsSuffix(
        " raydiumPreflight",
        provider.raydiumPreflightStatusCounts,
      )}${formatCountsSuffix(
        " heliusSources",
        provider.heliusEvidenceSourceCounts,
      )}${formatCountsSuffix(" heliusCache", provider.heliusCacheStatusCounts)}${formatCountsSuffix(
        " birdeyeEndpoints",
        provider.birdeyeEndpointCounts,
      )}${formatCountsSuffix(" birdeyeCache", provider.birdeyeCacheStatusCounts)}${formatCountsSuffix(
        " birdeyeFailures",
        provider.birdeyeFailureCategoryCounts,
      )}${formatCountsSuffix(
        " birdeyeReasons",
        provider.birdeyeSelectionReasonCounts,
      )}${formatCountsSuffix(" birdeyeBudget", provider.birdeyeBudgetReasonCounts)}`,
  );
}

function formatCountsSuffix(label: string, counts: Readonly<Record<string, number>>): string {
  const formatted = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");

  return formatted ? `${label}=${formatted}` : "";
}

function formatMarketWindows(rows: readonly ResearchMarketWindowSummary[]): readonly string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.runLabel} ${new Date(row.windowStartMs).toISOString()}: decisions=${
        row.decisionCount
      } unique=${row.uniqueMints} targetFirst=${row.targetFirstWins} avgBest=${formatOptional(
        row.averageBestReturnPct,
      )}%`,
  );
}

function formatTokenSummaries(rows: readonly ResearchTokenSummary[]): readonly string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.symbol ?? row.mintAddress}: decisions=${row.decisionCount} runs=${row.runs.join(
        ",",
      )} highScore=${row.highestScore ?? "n/a"} best=${formatOptional(
        row.bestReturnPct,
      )}% worst=${formatOptional(row.worstReturnPct)}% blockers=${row.primaryBlockersSeen.join(
        ",",
      )}`,
  );
}

function formatRecommendationMatrix(
  rows: readonly ResearchRecommendationMatrixRow[],
): readonly string[] {
  return rows.flatMap((row) => [
    `  ${row.selected ? "*" : "-"} ${row.recommendationCode}. ${row.label}`,
    `    next: ${row.requiredNextAction}`,
    `    safety: ${row.safetyCaveat}`,
    ...row.evidenceFor.map((item) => `    for: ${item}`),
    ...row.evidenceAgainst.map((item) => `    against: ${item}`),
  ]);
}

function formatRates(rates: Readonly<Record<string, number>>): string {
  return Object.entries(rates)
    .map(([target, rate]) => `${target}:${formatNumber(rate)}%`)
    .join(" ");
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
