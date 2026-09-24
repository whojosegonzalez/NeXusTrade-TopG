import { providerStatusValues } from "../db/schema/index.js";
import type { ProviderHealthRecord } from "../db/schema/index.js";
import { summarizeProviderPressureMetrics } from "../providers/ProviderPressureClassifier.js";
import type {
  CalibrationDecisionAnalysis,
  ProviderImpactSummary,
  ProviderStatusSummary,
} from "./CalibrationTypes.js";

export class ProviderImpactAnalyzer {
  analyze(
    providerHealth: readonly ProviderHealthRecord[],
    decisions: readonly CalibrationDecisionAnalysis[],
  ): ProviderImpactSummary {
    const withQuote = decisions.filter((decision) => !decision.attribution.missingQuote);
    const withoutQuote = decisions.filter((decision) => decision.attribution.missingQuote);

    return {
      providers: buildProviderStatusSummaries(providerHealth),
      strategyRows: decisions.length,
      missingQuoteCount: withoutQuote.length,
      missingAuthorityEvidenceCount: decisions.filter(
        (decision) => decision.attribution.missingAuthorityEvidence,
      ).length,
      missingPriceImpactCount: decisions.filter(
        (decision) => decision.attribution.missingPriceImpact,
      ).length,
      averageScoreWithQuote: averageScore(withQuote),
      averageScoreWithoutQuote: averageScore(withoutQuote),
      target10HitRateWithQuote: targetHitRate(withQuote, 10),
      target10HitRateWithoutQuote: targetHitRate(withoutQuote, 10),
    };
  }
}

function buildProviderStatusSummaries(
  providerHealth: readonly ProviderHealthRecord[],
): readonly ProviderStatusSummary[] {
  const grouped = new Map<string, ProviderHealthRecord[]>();

  for (const row of providerHealth) {
    grouped.set(row.provider, [...(grouped.get(row.provider) ?? []), row]);
  }

  return [...grouped.entries()]
    .map(([provider, rows]) => {
      const statusCounts = Object.fromEntries(providerStatusValues.map((status) => [status, 0]));
      const pressure = summarizeProviderPressureMetrics(rows);

      for (const row of rows) {
        statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
      }

      return {
        provider,
        total: rows.length,
        statusCounts,
        okPercent: percent(statusCounts.OK ?? 0, rows.length),
        degradedPercent: percent(statusCounts.DEGRADED ?? 0, rows.length),
        rateLimitedPercent: percent(statusCounts.RATE_LIMITED ?? 0, rows.length),
        errorPercent: percent(statusCounts.ERROR ?? 0, rows.length),
        liveRows: pressure.liveRows,
        routerRows: pressure.routerRows,
        liveRateLimitedPercent: pressure.liveRateLimitedPct,
        liveErrorPercent: pressure.liveErrorPct,
        routerCacheHits: pressure.routerCacheHits,
        routerCooldownSkips: pressure.routerCooldownSkips,
        routerUnavailable: pressure.routerUnavailable,
        routerCooldownSkipPercent: pressure.routerCooldownSkipPct,
        combinedRateLimitedPercent: pressure.combinedRateLimitedPct,
        quoteSourceTypeCounts: pressure.quoteSourceTypeCounts,
        quoteFallbackReasonCounts: pressure.quoteFallbackReasonCounts,
        authorityEvidenceSourceCounts: pressure.authorityEvidenceSourceCounts,
        mintAuthorityStateCounts: pressure.mintAuthorityStateCounts,
        freezeAuthorityStateCounts: pressure.freezeAuthorityStateCounts,
        rpcCacheStatusCounts: pressure.rpcCacheStatusCounts,
        rpcFailureCategoryCounts: pressure.rpcFailureCategoryCounts,
        dasProviderCounts: pressure.dasProviderCounts,
        dasFailureCategoryCounts: pressure.dasFailureCategoryCounts,
        raydiumFailureCategoryCounts: pressure.raydiumFailureCategoryCounts,
        raydiumPreflightStatusCounts: pressure.raydiumPreflightStatusCounts,
        heliusEvidenceSourceCounts: pressure.heliusEvidenceSourceCounts,
        heliusCacheStatusCounts: pressure.heliusCacheStatusCounts,
        birdeyeEndpointCounts: pressure.birdeyeEndpointCounts,
        birdeyeCacheStatusCounts: pressure.birdeyeCacheStatusCounts,
        birdeyeFailureCategoryCounts: pressure.birdeyeFailureCategoryCounts,
        birdeyeSelectionReasonCounts: pressure.birdeyeSelectionReasonCounts,
        birdeyeBudgetReasonCounts: pressure.birdeyeBudgetReasonCounts,
      };
    })
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

function averageScore(decisions: readonly CalibrationDecisionAnalysis[]): number | null {
  const scores = decisions
    .map((decision) => decision.score)
    .filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return scores.reduce((total, score) => total + score, 0) / scores.length;
}

function targetHitRate(
  decisions: readonly CalibrationDecisionAnalysis[],
  targetPct: number,
): number | null {
  const observed = decisions.filter((decision) => decision.returns.bestReturnPct !== undefined);

  if (observed.length === 0) {
    return null;
  }

  const hits = observed.filter(
    (decision) => (decision.returns.bestReturnPct ?? -Infinity) >= targetPct,
  );

  return percent(hits.length, observed.length);
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}
