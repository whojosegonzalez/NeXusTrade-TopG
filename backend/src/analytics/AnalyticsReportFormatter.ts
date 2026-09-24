import type { AnalyticsReport } from "./AnalyticsReportService.js";

export function formatAnalyticsReport(report: AnalyticsReport): string {
  const lines: string[] = [];

  lines.push("NeXusTrade Analytics Report");
  lines.push(`Generated: ${new Date(report.generatedAtMs).toISOString()}`);
  lines.push("");
  lines.push("Session");
  lines.push(`  id: ${report.session.id}`);
  lines.push(`  mode: ${report.session.mode}`);
  lines.push(`  status: ${report.session.status}`);
  lines.push(`  currentCashLamports: ${report.session.currentCashLamports}`);
  lines.push(`  realizedPnlLamports: ${report.session.realizedPnlLamports}`);
  lines.push(`  unrealizedPnlLamports: ${report.session.unrealizedPnlLamports}`);
  lines.push(`  terminationReason: ${report.session.terminationReason}`);
  lines.push("");
  lines.push("Funnel");
  lines.push(`  TokenRadar total: ${report.funnel.tokenRadarTotal}`);
  lines.push(`  TokenRadar by status: ${formatCounts(report.funnel.tokenRadarByStatus)}`);
  lines.push(`  Risk total: ${report.funnel.riskAssessmentTotal}`);
  lines.push(`  Risk by result: ${formatCounts(report.funnel.riskByResult)}`);
  lines.push(`  Strategy total: ${report.funnel.strategyDecisionTotal}`);
  lines.push(`  Strategy by decision: ${formatCounts(report.funnel.strategyByDecision)}`);
  lines.push(`  Orders total: ${report.funnel.orderTotal}`);
  lines.push(`  Orders by status: ${formatCounts(report.funnel.ordersByStatus)}`);
  lines.push(`  Fills total: ${report.funnel.fillTotal}`);
  lines.push(`  Positions by status: ${formatCounts(report.funnel.positionsByStatus)}`);
  lines.push(`  Equity snapshots: ${report.funnel.equitySnapshotTotal}`);
  lines.push(`  Watchlist returns total: ${report.funnel.watchlistReturnTotal}`);
  lines.push(
    `  Watchlist returns by status: ${formatCounts(report.funnel.watchlistReturnsByStatus)}`,
  );
  lines.push("");
  lines.push("Quote Budget Allocation");
  lines.push(
    `  assessments=${report.quoteBudget.assessmentsWithPlan} selected=${report.quoteBudget.selectedCount} notSelected=${report.quoteBudget.notSelectedCount} selectedWithQuote=${report.quoteBudget.quoteSuccessCount} skippedLiveCallsEstimate=${report.quoteBudget.skippedLiveCallsEstimate}`,
  );
  lines.push(`  reasons=${formatCounts(report.quoteBudget.selectionReasonCounts) || "none"}`);
  lines.push(`  signals=${formatCounts(report.quoteBudget.signalCounts) || "none"}`);
  lines.push(`  ranks=${formatCounts(report.quoteBudget.rankBucketCounts) || "none"}`);
  lines.push("");
  lines.push("Score Buckets");

  if (report.scoreBuckets.length === 0) {
    lines.push("  none");
  } else {
    for (const bucket of report.scoreBuckets) {
      lines.push(
        `  ${bucket.bucket}: total=${bucket.total} BUY=${bucket.buyCount} WATCH=${bucket.watchCount} SKIP=${bucket.skipCount}`,
      );
    }
  }

  lines.push("");
  lines.push("Near Misses");

  if (report.nearMisses.length === 0) {
    lines.push("  none");
  } else {
    for (const nearMiss of report.nearMisses.slice(0, 20)) {
      lines.push(
        `  ${nearMiss.mintAddress} ${nearMiss.symbol ?? ""} decision=${nearMiss.decision} score=${nearMiss.score ?? "n/a"} risk=${nearMiss.riskResult ?? "n/a"} blockers=${nearMiss.blockingFactors.join("|") || "none"}`,
      );
      lines.push(`    reason=${nearMiss.reason}`);
    }
  }

  lines.push("");
  lines.push("Missed Opportunities");

  if (report.missedOpportunities.length === 0) {
    lines.push("  none");
  } else {
    for (const opportunity of report.missedOpportunities) {
      lines.push(
        `  ${opportunity.mintAddress} ${opportunity.symbol ?? ""} decision=${opportunity.decision} score=${opportunity.score ?? "n/a"} best=${opportunity.bestReturnPct}%@${opportunity.bestHorizonMinutes}m`,
      );
      lines.push(`    returns=${formatCounts(opportunity.returnsByHorizon)}`);
      lines.push(`    blockers=${opportunity.blockingFactors.join("|") || "none"}`);
    }
  }

  lines.push("");
  lines.push("Provider Health");

  if (report.providerHealth.length === 0) {
    lines.push("  none");
  } else {
    for (const provider of report.providerHealth) {
      lines.push(
        `  ${provider.provider}${provider.operation ? `:${provider.operation}` : ""} total=${provider.total} live=${provider.liveRows} router=${provider.routerRows} statuses=${formatCounts(provider.statusCounts)} liveRateLimited=${provider.liveRateLimitedPercent.toFixed(2)}% combinedRateLimited=${provider.combinedRateLimitedPercent.toFixed(2)}% cacheHits=${provider.routerCacheHits} cooldownSkips=${provider.routerCooldownSkips} avoided=${provider.liveQuoteCallsAvoidedEstimate} schedulerWaitMs=${provider.quoteSchedulerWaitMsTotal} singleFlightJoins=${provider.quoteSingleFlightJoinCount} negativeCacheHits=${provider.quoteNegativeCacheHitCount} jupiterDeferred=${provider.jupiterDemandDeferredCount} jupiterAllowed=${provider.jupiterLiveAllowedCount} jupiter429Observed=${provider.jupiterControllerRateLimitObservedCount} jupiterIntervalAvgMs=${provider.jupiterEffectiveIntervalMsAverage.toFixed(0)} jupiterAdaptiveMax=${provider.jupiterAdaptiveLevelMax} jupiterWindowUsageMax=${provider.jupiterSharedWindowUsageMax}${formatCountsSuffix(" quoteSourceTypes", provider.quoteSourceTypeCounts)}${formatCountsSuffix(" fallbackReasons", provider.quoteFallbackReasonCounts)}${formatCountsSuffix(" quoteDemand", provider.quoteDemandActionCounts)}${formatCountsSuffix(" jupiterDemand", provider.jupiterDemandActionCounts)}${formatCountsSuffix(" jupiterOperations", provider.jupiterDemandOperationCounts)}${formatCountsSuffix(" jupiterPriorities", provider.jupiterDemandPriorityCounts)}${formatCountsSuffix(" negativeCacheReasons", provider.quoteNegativeCacheReasonCounts)}${formatCountsSuffix(" raydiumVenueGuard", provider.raydiumVenueGuardDecisionCounts)}${formatCountsSuffix(" raydiumVenueReasons", provider.raydiumVenueGuardReasonCounts)}${formatCountsSuffix(" authoritySources", provider.authorityEvidenceSourceCounts)}${formatCountsSuffix(" mintAuthority", provider.mintAuthorityStateCounts)}${formatCountsSuffix(" freezeAuthority", provider.freezeAuthorityStateCounts)}${formatCountsSuffix(" rpcCache", provider.rpcCacheStatusCounts)}${formatCountsSuffix(" rpcFailures", provider.rpcFailureCategoryCounts)}${formatCountsSuffix(" dasProviders", provider.dasProviderCounts)}${formatCountsSuffix(" dasFailures", provider.dasFailureCategoryCounts)}${formatCountsSuffix(" raydiumFailures", provider.raydiumFailureCategoryCounts)}${formatCountsSuffix(" raydiumPreflight", provider.raydiumPreflightStatusCounts)}${formatCountsSuffix(" heliusSources", provider.heliusEvidenceSourceCounts)}${formatCountsSuffix(" heliusCache", provider.heliusCacheStatusCounts)}${formatCountsSuffix(" birdeyeEndpoints", provider.birdeyeEndpointCounts)}${formatCountsSuffix(" birdeyeCache", provider.birdeyeCacheStatusCounts)}${formatCountsSuffix(" birdeyeFailures", provider.birdeyeFailureCategoryCounts)}${formatCountsSuffix(" birdeyeReasons", provider.birdeyeSelectionReasonCounts)}${formatCountsSuffix(" birdeyeBudget", provider.birdeyeBudgetReasonCounts)} latest=${provider.latestStatus ?? "n/a"}`,
      );
    }
  }

  if (report.jupiterRateLimitSummary) {
    lines.push("");
    lines.push("Jupiter Rate Limit Summary");
    lines.push(
      `  total=${report.jupiterRateLimitSummary.total} liveRateLimited=${report.jupiterRateLimitSummary.liveRateLimitedPercent.toFixed(2)}% combinedRateLimited=${report.jupiterRateLimitSummary.combinedRateLimitedPercent.toFixed(2)}% cacheHits=${report.jupiterRateLimitSummary.routerCacheHits} cooldownSkips=${report.jupiterRateLimitSummary.routerCooldownSkips}`,
    );
  }

  lines.push("");
  lines.push("Recommended Next Run");
  lines.push("  pnpm risk:evaluate --once");
  lines.push("  pnpm strategy:evaluate --once --buy-score-threshold=75");
  lines.push("  pnpm watchlist:returns --once");
  lines.push("  pnpm analytics:report --once");

  return lines.join("\n");
}

function formatCountsSuffix(label: string, counts: Readonly<Record<string, number>>): string {
  const formatted = formatCounts(counts);

  return formatted ? `${label}=${formatted}` : "";
}

export function formatAnalyticsJson(report: AnalyticsReport): string {
  return JSON.stringify(report, null, 2);
}

function formatCounts(counts: Readonly<Record<string, number | string>>): string {
  return Object.entries(counts)
    .filter(([, value]) => value !== 0 && value !== "0")
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}
