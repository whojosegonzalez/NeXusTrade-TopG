import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getRepoRoot } from "../db/utils/paths.js";
import type {
  ResearchAggregateReport,
  ResearchProviderPressureSummary,
  ResearchRunValidation,
  ResearchThresholdComparison,
} from "./ResearchAggregateTypes.js";

export function formatResearchAggregateJson(report: ResearchAggregateReport): string {
  return JSON.stringify(toSerializableReport(report), null, 2);
}

export function formatResearchAggregateReport(report: ResearchAggregateReport): string {
  const lines: string[] = [];

  lines.push("NeXusTrade Research Aggregate Report");
  lines.push(`Generated: ${new Date(report.generatedAtMs).toISOString()}`);
  lines.push("");
  lines.push("Safety");
  lines.push("  mode: PAPER research");
  lines.push("  database access: read-only");
  lines.push("  paper BUY automation: disabled");
  lines.push("  wallet loaded: no");
  lines.push("  transaction signing: disabled");
  lines.push("  transaction submission: disabled");
  lines.push("");
  lines.push("Inputs");
  lines.push(`  runs: ${report.config.runLabels.join(", ")}`);
  lines.push(`  targets pct: ${report.config.targetPcts.join(",")}`);
  lines.push(`  stops pct: ${report.config.stopPcts.join(",")}`);
  lines.push(`  max holds minutes: ${report.config.maxHoldMinutes.join(",")}`);
  lines.push(`  source decisions: ${report.config.sourceDecisions.join(",")}`);
  lines.push(`  min score: ${report.config.minScore}`);
  lines.push("");
  lines.push("Run Validation");
  lines.push(...formatRunValidations(report.runValidations));
  lines.push("");
  lines.push("Cross-Run Summary");
  lines.push(`  validRuns: ${report.crossRun.validRunCount}/${report.crossRun.runCount}`);
  lines.push(`  observedDecisions: ${report.crossRun.observedDecisionCount}`);
  lines.push(`  uniqueMints: ${report.crossRun.uniqueMintCount}`);
  lines.push(
    `  paper execution rows: orders=${report.crossRun.orderCount} fills=${report.crossRun.fillCount} positions=${report.crossRun.positionCount}`,
  );
  lines.push(
    `  target-first concentration: wins=${report.crossRun.concentration.targetFirstWinCount} run=${formatNumber(
      report.crossRun.concentration.maxSingleRunWinSharePct,
    )}% mint=${formatNumber(report.crossRun.concentration.maxSingleMintWinSharePct)}%`,
  );
  lines.push("");
  lines.push("Threshold Comparison");
  lines.push(...formatThresholdComparisons(report.crossRun.thresholdComparisons));
  lines.push("");
  lines.push("Score Bucket Outcomes");
  lines.push(...formatCalibrationFilterRows(report, "score_bucket"));
  lines.push("");
  lines.push("Quote Impact");
  lines.push(...formatCalibrationFilterRows(report, "quote"));
  lines.push("");
  lines.push("Scenario Portfolio");
  lines.push(...formatScenarioPortfolioRows(report));
  lines.push("");
  lines.push("Provider Pressure");
  lines.push(...formatProviderPressure(report.crossRun.providerPressure));
  lines.push("");
  lines.push("Quote Budget Allocation");
  lines.push(formatQuoteBudget(report.crossRun.quoteBudget));
  lines.push("");
  lines.push("Shadow Entry Readiness");
  lines.push(...formatShadowEntryReadiness(report));
  lines.push("");
  lines.push("Promotion Gate");
  lines.push(`  readiness: ${report.promotionGate.readiness}`);
  lines.push(`  confidence: ${report.promotionGate.confidence}`);
  lines.push(
    `  controlledPaperPilotRecommended: ${
      report.promotionGate.controlledPaperPilotRecommended ? "yes" : "no"
    }`,
  );
  lines.push(
    `  paperBuyAutomationEnabled: ${report.promotionGate.paperBuyAutomationEnabled ? "yes" : "no"}`,
  );
  if (report.promotionGate.candidateProfileId) {
    lines.push(`  candidateProfile: ${report.promotionGate.candidateProfileId}`);
  }
  lines.push("  blockers:");
  lines.push(...report.promotionGate.blockingReasons.map((reason) => `    - ${reason}`));
  lines.push("  evidence:");
  lines.push(...report.promotionGate.supportingEvidence.map((item) => `    - ${item}`));
  lines.push("  cautions:");
  lines.push(...report.promotionGate.cautionNotes.map((item) => `    - ${item}`));
  lines.push("");
  lines.push("Recommendations");
  lines.push(...report.recommendations.map((item) => `  - ${item}`));

  return lines.join("\n").trimEnd();
}

export function writeResearchAggregateArtifacts(input: {
  readonly report: ResearchAggregateReport;
  readonly outputDir: string;
}): readonly string[] {
  const resolvedOutputDir = path.isAbsolute(input.outputDir)
    ? path.resolve(input.outputDir)
    : path.resolve(getRepoRoot(), input.outputDir);
  const stamp = new Date(input.report.generatedAtMs).toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(resolvedOutputDir, `research-aggregate-${stamp}.json`);
  const textPath = path.join(resolvedOutputDir, `research-aggregate-${stamp}.txt`);

  mkdirSync(resolvedOutputDir, { recursive: true });
  writeFileSync(jsonPath, formatResearchAggregateJson(input.report), "utf8");
  writeFileSync(textPath, formatResearchAggregateReport(input.report), "utf8");

  return [jsonPath, textPath];
}

function formatRunValidations(runs: readonly ResearchRunValidation[]): readonly string[] {
  if (runs.length === 0) {
    return ["  none"];
  }

  return runs.flatMap((run) => [
    `  ${run.label}: valid=${run.validForPromotion ? "yes" : "no"} safety=${
      run.safetyStatus
    } cycles=${run.cycleCount} oneSession=${run.oneSession ? "yes" : "no"}`,
    `    session: terminal=${run.terminalSessionId ?? "n/a"} db=${run.databaseSessionId ?? "n/a"}`,
    `    rows: scannerStored=${run.scannerStoredCount} strategyWritten=${run.strategyWrittenCount}`,
    ...run.warnings.map((warning) => `    warning: ${warning}`),
  ]);
}

function toSerializableReport(report: ResearchAggregateReport): unknown {
  return {
    ...report,
    archives: report.archives.map((archive) => ({
      label: archive.label,
      inputPath: archive.inputPath,
      resolvedPath: archive.resolvedPath,
      databasePath: archive.databasePath,
      runnerJsonPath: archive.runnerJsonPath,
      ...(archive.runnerTextPath ? { runnerTextPath: archive.runnerTextPath } : {}),
      ...(archive.analyticsReportPath ? { analyticsReportPath: archive.analyticsReportPath } : {}),
      ...(archive.calibrationReportPath
        ? { calibrationReportPath: archive.calibrationReportPath }
        : {}),
      ...(archive.shadowCalibrationReportPath
        ? { shadowCalibrationReportPath: archive.shadowCalibrationReportPath }
        : {}),
      terminalSummary: {
        runId: archive.terminalSummary.runId,
        sessionId: archive.terminalSummary.sessionId,
        mode: archive.terminalSummary.mode,
        shadowOnly: archive.terminalSummary.shadowOnly,
        safetyStatus: archive.terminalSummary.safetyStatus,
        startedAtMs: archive.terminalSummary.startedAtMs,
        endedAtMs: archive.terminalSummary.endedAtMs,
        durationMs: archive.terminalSummary.durationMs,
        maxRuntimeMinutes: archive.terminalSummary.maxRuntimeMinutes,
        intervalMs: archive.terminalSummary.intervalMs,
        cycleCount: archive.terminalSummary.cycleCount,
        providerPressure: archive.terminalSummary.providerPressure,
        stopped: archive.terminalSummary.stopped,
        ...(archive.terminalSummary.fatalErrorMessage
          ? { fatalErrorMessage: archive.terminalSummary.fatalErrorMessage }
          : {}),
      },
      warnings: archive.warnings,
    })),
  };
}

function formatThresholdComparisons(
  rows: readonly ResearchThresholdComparison[],
): readonly string[] {
  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.profileId} ${row.profileVersion}: observedBUY=${row.observedBuyCount} unique=${row.uniqueBuyMints} avgBest=${formatOptional(
        row.averageBestReturnPct,
      )}% avgWorst=${formatOptional(row.averageWorstReturnPct)}% hits=${formatRates(
        row.targetHitRates,
      )} drawdownFirst=${formatRates(row.drawdownFirstRates)}`,
  );
}

function formatQuoteBudget(
  quoteBudget: ResearchAggregateReport["crossRun"]["quoteBudget"],
): string {
  if (!quoteBudget) {
    return "  unavailable (pre-Phase 9.4D archive)";
  }

  return `  riskCycles=${quoteBudget.riskCycleCount} plannerEnabledCycles=${quoteBudget.plannerEnabledCycleCount} selected=${quoteBudget.selectedCount} notSelected=${quoteBudget.notSelectedCount} skippedLiveCallsEstimate=${quoteBudget.skippedLiveCallsEstimate}`;
}

function formatCalibrationFilterRows(
  report: ResearchAggregateReport,
  filterName: string,
): readonly string[] {
  const rows = report.shadowCalibration.filterAnalysis
    .filter((row) => row.label === "ALL" && row.filterName === filterName)
    .slice(0, 10);

  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.bucket}: n=${row.count} avgBest=${formatOptional(
        row.averageBestReturnPct,
      )}% avgWorst=${formatOptional(row.averageWorstReturnPct)}% hits=${formatRates(
        row.targetHitRates,
      )} drawdownFirst=${formatRates(row.drawdownFirstRates)}`,
  );
}

function formatScenarioPortfolioRows(report: ResearchAggregateReport): readonly string[] {
  const rows = report.shadowCalibration.scenarioPortfolioGrid
    .filter((row) => row.label === "ALL")
    .slice(0, 10);

  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  target=${formatNumber(row.targetPct)}% stop=${formatNumber(row.stopPct)}% hold=${
        row.maxHoldMinutes
      }m evaluated=${row.evaluatedCount} target=${row.targetHitCount} stop=${
        row.stopHitCount
      } pnl=${formatSigned(row.simulatedPnlSol)} SOL (${formatSigned(
        row.simulatedPnlPct,
      )}%) drawdown=${formatNumber(row.maxDrawdownPct)}% goal=${row.goalReached ? "yes" : "no"}`,
  );
}

function formatProviderPressure(
  providers: readonly ResearchProviderPressureSummary[],
): readonly string[] {
  if (providers.length === 0) {
    return ["  none"];
  }

  return providers.map(
    (provider) =>
      `  ${provider.provider}: total=${provider.total} ok=${formatNumber(
        provider.okPercent,
      )}% degraded=${formatNumber(provider.degradedPercent)}% liveRateLimited=${formatNumber(
        provider.liveRateLimitedPercent,
      )}% combinedRateLimited=${formatNumber(
        provider.combinedRateLimitedPercent,
      )}% cacheHits=${provider.routerCacheHits} cooldownSkips=${
        provider.routerCooldownSkips
      } cooldownSkip=${formatNumber(provider.routerCooldownSkipPercent)}% avoided=${
        provider.liveQuoteCallsAvoidedEstimate
      } schedulerWaitMs=${provider.quoteSchedulerWaitMsTotal} singleFlightJoins=${
        provider.quoteSingleFlightJoinCount
      } negativeCacheHits=${provider.quoteNegativeCacheHitCount} error=${formatNumber(
        provider.errorPercent,
      )}%${formatCountsSuffix(" quoteSourceTypes", provider.quoteSourceTypeCounts)}${formatCountsSuffix(
        " fallbackReasons",
        provider.quoteFallbackReasonCounts,
      )}${formatCountsSuffix(" quoteDemand", provider.quoteDemandActionCounts)}${formatCountsSuffix(
        " jupiterDemand",
        provider.jupiterDemandActionCounts,
      )}${formatCountsSuffix(
        " jupiterPriority",
        provider.jupiterDemandPriorityCounts,
      )} jupiterAllowed=${provider.jupiterLiveAllowedCount} jupiterDeferred=${
        provider.jupiterDemandDeferredCount
      } jupiterObserved429=${provider.jupiterControllerRateLimitObservedCount} jupiterIntervalMs=${formatNumber(
        provider.jupiterEffectiveIntervalMsAverage,
      )} jupiterAdaptiveMax=${provider.jupiterAdaptiveLevelMax} jupiterWindowUsageMax=${
        provider.jupiterSharedWindowUsageMax
      }${formatCountsSuffix(
        " negativeCacheReasons",
        provider.quoteNegativeCacheReasonCounts,
      )}${formatCountsSuffix(
        " raydiumVenueGuard",
        provider.raydiumVenueGuardDecisionCounts,
      )}${formatCountsSuffix(
        " raydiumVenueReasons",
        provider.raydiumVenueGuardReasonCounts,
      )}${formatCountsSuffix(
        " authoritySources",
        provider.authorityEvidenceSourceCounts,
      )}${formatCountsSuffix(
        " mintAuthority",
        provider.mintAuthorityStateCounts,
      )}${formatCountsSuffix(
        " freezeAuthority",
        provider.freezeAuthorityStateCounts,
      )}${formatCountsSuffix(" rpcCache", provider.rpcCacheStatusCounts)}${formatCountsSuffix(
        " rpcFailures",
        provider.rpcFailureCategoryCounts,
      )}${formatCountsSuffix(" dasProviders", provider.dasProviderCounts)}${formatCountsSuffix(
        " dasFailures",
        provider.dasFailureCategoryCounts,
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

function formatShadowEntryReadiness(report: ResearchAggregateReport): readonly string[] {
  const rows = bestReadinessRows(report.shadowEntries.readinessByProfile)
    .filter((row) => row.label === "ALL")
    .slice(0, 12);

  if (rows.length === 0) {
    return ["  none"];
  }

  return rows.map(
    (row) =>
      `  ${row.profileKey}: status=${row.status} confidence=${row.confidence} stability=${row.signalStability} marketWindowWinConcentration=${formatNumber(
        row.maxMarketWindowWinConcentrationPct,
      )}%`,
  );
}

type ShadowEntryReadinessRow =
  ResearchAggregateReport["shadowEntries"]["readinessByProfile"][number];

function bestReadinessRows(
  rows: readonly ShadowEntryReadinessRow[],
): readonly ShadowEntryReadinessRow[] {
  const byProfile = new Map<string, ShadowEntryReadinessRow>();

  for (const row of rows) {
    const existing = byProfile.get(row.profileKey);

    if (!existing || compareReadinessRows(row, existing) < 0) {
      byProfile.set(row.profileKey, row);
    }
  }

  return [...byProfile.values()].sort(compareReadinessRows);
}

function compareReadinessRows(
  left: ShadowEntryReadinessRow,
  right: ShadowEntryReadinessRow,
): number {
  return (
    readinessRank(right.status) - readinessRank(left.status) ||
    confidenceRank(right.confidence) - confidenceRank(left.confidence) ||
    left.maxMarketWindowWinConcentrationPct - right.maxMarketWindowWinConcentrationPct ||
    left.profileKey.localeCompare(right.profileKey)
  );
}

function readinessRank(status: string): number {
  if (status === "CANDIDATE_FOR_PROMOTION") {
    return 3;
  }

  if (status === "PROMISING_RESEARCH") {
    return 2;
  }

  return 1;
}

function confidenceRank(confidence: string): number {
  if (confidence === "HIGH") {
    return 3;
  }

  if (confidence === "MEDIUM") {
    return 2;
  }

  return 1;
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
