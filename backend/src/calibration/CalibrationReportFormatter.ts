import type {
  CalibrationDatasetReport,
  CalibrationReport,
  ProviderStatusSummary,
  ReturnGroupSummary,
  ThresholdScenarioSummary,
} from "./CalibrationTypes.js";

export function formatCalibrationJson(report: CalibrationReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatCalibrationReport(report: CalibrationReport): string {
  const lines: string[] = [];

  lines.push("NeXusTrade Calibration Report");
  lines.push(`Generated: ${new Date(report.generatedAtMs).toISOString()}`);
  lines.push("");

  for (const dataset of report.datasets) {
    lines.push(...formatDataset(dataset));
    lines.push("");
  }

  lines.push("Recommendations");

  for (const recommendation of report.recommendations) {
    lines.push(`  - ${recommendation}`);
  }

  return lines.join("\n").trimEnd();
}

function formatDataset(dataset: CalibrationDatasetReport): string[] {
  const lines: string[] = [];

  lines.push(`Dataset: ${dataset.label}`);
  lines.push(`  path: ${dataset.path}`);
  lines.push(
    `  session: ${dataset.session.id} (${dataset.session.mode}/${dataset.session.status})`,
  );
  lines.push(
    `  counts: radar=${dataset.counts.tokenRadarRows} strategy=${dataset.counts.strategyRows} observedReturns=${dataset.counts.observedReturnRows} providerHealth=${dataset.counts.providerHealthRows}`,
  );
  lines.push("");
  lines.push("Score Distribution");

  if (dataset.scoreDistribution.length === 0) {
    lines.push("  none");
  } else {
    for (const bucket of dataset.scoreDistribution) {
      lines.push(
        `  ${bucket.bucket}: total=${bucket.total} uniqueMints=${bucket.uniqueMints} BUY=${bucket.buyCount} WATCH=${bucket.watchCount} SKIP=${bucket.skipCount}`,
      );
    }
  }

  lines.push("");
  lines.push("Score Attribution");
  lines.push(`  maxObservedScore: ${formatNullable(dataset.scoreAttribution.maxObservedScore)}`);
  lines.push(`  averageScore: ${formatNullable(dataset.scoreAttribution.averageScore)}`);
  lines.push(`  storedScoreMismatchCount: ${dataset.scoreAttribution.storedScoreMismatchCount}`);
  lines.push(`  missingSnapshotCount: ${dataset.scoreAttribution.missingSnapshotCount}`);
  lines.push(`  missingQuoteCount: ${dataset.scoreAttribution.missingQuoteCount}`);
  lines.push(
    `  missingAuthorityEvidenceCount: ${dataset.scoreAttribution.missingAuthorityEvidenceCount}`,
  );
  lines.push(`  missingPriceImpactCount: ${dataset.scoreAttribution.missingPriceImpactCount}`);

  for (const rule of dataset.scoreAttribution.ruleSummaries) {
    lines.push(
      `  ${rule.ruleName}: avg=${rule.averagePoints.toFixed(2)} zero=${rule.zeroPointCount} failed=${rule.failedCount} warnings=${rule.warningCount}`,
    );
  }

  lines.push("");
  lines.push("Forward Returns");
  lines.push(`  analyzedDecisionCount: ${dataset.forwardReturns.analyzedDecisionCount}`);
  lines.push(`  observedDecisionCount: ${dataset.forwardReturns.observedDecisionCount}`);
  lines.push("  by decision:");
  lines.push(...formatReturnGroups(dataset.forwardReturns.byDecision));
  lines.push("  by score bucket:");
  lines.push(...formatReturnGroups(dataset.forwardReturns.byScoreBucket));

  lines.push("");
  lines.push("Target Simulation");

  for (const row of dataset.targetSimulation.rows) {
    lines.push(
      `  target=${row.targetPct}% drawdown=${row.drawdownPct}% evaluated=${row.evaluatedCount} targetFirst=${row.targetBeforeDrawdownCount} drawdownFirst=${row.drawdownBeforeTargetCount} ambiguous=${row.ambiguousCount} neither=${row.neitherCount}`,
    );
  }

  lines.push("");
  lines.push("Missed Opportunities");

  if (dataset.missedOpportunities.length === 0) {
    lines.push("  none");
  } else {
    for (const row of dataset.missedOpportunities.slice(0, 20)) {
      lines.push(
        `  ${row.symbol ?? row.mintAddress} decision=${row.decision} score=${row.score ?? "n/a"} best=${row.bestReturnPct.toFixed(2)}%@${row.bestHorizonMinutes}m worst=${formatNullable(row.worstReturnPct)} missingQuote=${row.missingQuote}`,
      );
    }
  }

  lines.push("");
  lines.push("False Positive BUYs");

  if (dataset.falsePositiveBuys.length === 0) {
    lines.push("  none");
  } else {
    for (const row of dataset.falsePositiveBuys.slice(0, 20)) {
      lines.push(
        `  ${row.symbol ?? row.mintAddress} score=${row.score ?? "n/a"} best=${row.bestReturnPct.toFixed(2)}%@${row.bestHorizonMinutes}m failedTarget=${row.failedTargetPct}%`,
      );
    }
  }

  lines.push("");
  lines.push("Provider Impact");

  for (const provider of dataset.providerImpact.providers) {
    lines.push(formatProvider(provider));
  }

  lines.push(
    `  strategyRows=${dataset.providerImpact.strategyRows} missingQuote=${dataset.providerImpact.missingQuoteCount} missingAuthority=${dataset.providerImpact.missingAuthorityEvidenceCount} missingImpact=${dataset.providerImpact.missingPriceImpactCount}`,
  );
  lines.push(
    `  avgScoreWithQuote=${formatNullable(dataset.providerImpact.averageScoreWithQuote)} avgScoreWithoutQuote=${formatNullable(dataset.providerImpact.averageScoreWithoutQuote)}`,
  );
  lines.push(
    `  target10HitWithQuote=${formatNullable(dataset.providerImpact.target10HitRateWithQuote)}% target10HitWithoutQuote=${formatNullable(dataset.providerImpact.target10HitRateWithoutQuote)}%`,
  );

  lines.push("");
  lines.push("Threshold Comparison");

  for (const scenario of dataset.thresholdComparison) {
    lines.push(formatThresholdScenario(scenario));
  }

  return lines;
}

function formatReturnGroups(groups: readonly ReturnGroupSummary[]): string[] {
  if (groups.length === 0) {
    return ["    none"];
  }

  return groups.map(
    (group) =>
      `    ${group.label}: n=${group.count} avgBest=${formatNullable(group.averageBestReturnPct)} avgWorst=${formatNullable(group.averageWorstReturnPct)} hits=${formatRates(group.hitRatesByTargetPct)}`,
  );
}

function formatProvider(provider: ProviderStatusSummary): string {
  return `  ${provider.provider}: total=${provider.total} ok=${provider.okPercent.toFixed(
    2,
  )}% degraded=${provider.degradedPercent.toFixed(2)}% liveRateLimited=${provider.liveRateLimitedPercent.toFixed(
    2,
  )}% combinedRateLimited=${provider.combinedRateLimitedPercent.toFixed(
    2,
  )}% cacheHits=${provider.routerCacheHits} cooldownSkips=${provider.routerCooldownSkips} error=${provider.errorPercent.toFixed(
    2,
  )}%${formatCountsSuffix(" quoteSourceTypes", provider.quoteSourceTypeCounts)}${formatCountsSuffix(
    " fallbackReasons",
    provider.quoteFallbackReasonCounts,
  )}${formatCountsSuffix(
    " authoritySources",
    provider.authorityEvidenceSourceCounts,
  )}${formatCountsSuffix(" mintAuthority", provider.mintAuthorityStateCounts)}${formatCountsSuffix(
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
  )}${formatCountsSuffix(" heliusSources", provider.heliusEvidenceSourceCounts)}${formatCountsSuffix(
    " heliusCache",
    provider.heliusCacheStatusCounts,
  )}${formatCountsSuffix(" birdeyeEndpoints", provider.birdeyeEndpointCounts)}${formatCountsSuffix(
    " birdeyeCache",
    provider.birdeyeCacheStatusCounts,
  )}${formatCountsSuffix(
    " birdeyeFailures",
    provider.birdeyeFailureCategoryCounts,
  )}${formatCountsSuffix(
    " birdeyeReasons",
    provider.birdeyeSelectionReasonCounts,
  )}${formatCountsSuffix(" birdeyeBudget", provider.birdeyeBudgetReasonCounts)}`;
}

function formatCountsSuffix(label: string, counts: Readonly<Record<string, number>>): string {
  const formatted = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");

  return formatted ? `${label}=${formatted}` : "";
}

function formatThresholdScenario(scenario: ThresholdScenarioSummary): string {
  return `  BUY>=${scenario.buyScoreThreshold} WATCH>=${scenario.watchScoreThreshold}: BUY=${scenario.buyCount} WATCH=${scenario.watchCount} SKIP=${scenario.skipCount} uniqueBuyMints=${scenario.uniqueBuyMints} avgBuyBest=${formatNullable(
    scenario.averageBuyBestReturnPct,
  )} avgBuyWorst=${formatNullable(scenario.averageBuyWorstReturnPct)} hitRates=${formatRates(
    scenario.targetHitRatesByPct,
  )} observedBUY=${scenario.observedBuyCount}`;
}

function formatRates(rates: Readonly<Record<string, number>>): string {
  return Object.entries(rates)
    .map(([target, rate]) => `+${target}%:${rate.toFixed(2)}%`)
    .join(" ");
}

function formatNullable(value: number | null | undefined): string {
  return value === null || value === undefined ? "n/a" : value.toFixed(2);
}
