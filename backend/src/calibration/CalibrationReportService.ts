import { nowMs } from "../db/utils/timestamps.js";
import type { CalibrationRuntimeConfig } from "./CalibrationConfig.js";
import type {
  CalibrationDatasetCounts,
  CalibrationDatasetReport,
  CalibrationDecisionAnalysis,
  CalibrationReport,
  CalibrationSessionSummary,
  FalsePositiveBuyRow,
  ForwardReturnSummary,
  MissedOpportunityCalibrationRow,
  ReturnGroupSummary,
  ScoreAttributionRuleSummary,
  ScoreAttributionSummary,
  ScoreDistributionRow,
  TargetSimulationRow,
  TargetSimulationSummary,
} from "./CalibrationTypes.js";
import { ForwardReturnAnalyzer } from "./ForwardReturnAnalyzer.js";
import { ProviderImpactAnalyzer } from "./ProviderImpactAnalyzer.js";
import type { CalibrationRepository } from "./CalibrationRepository.js";
import { ScoreAttributionService } from "./ScoreAttributionService.js";
import { ThresholdComparisonService } from "./ThresholdComparisonService.js";

export interface CalibrationReportServiceOptions {
  readonly config: CalibrationRuntimeConfig;
  readonly repositories: readonly CalibrationRepository[];
  readonly clock?: () => number;
}

export class CalibrationReportService {
  private readonly clock: () => number;
  private readonly scoreAttribution = new ScoreAttributionService();
  private readonly providerImpact = new ProviderImpactAnalyzer();
  private readonly thresholdComparison = new ThresholdComparisonService();

  constructor(private readonly options: CalibrationReportServiceOptions) {
    this.clock = options.clock ?? nowMs;
  }

  generate(): CalibrationReport {
    const generatedAtMs = this.clock();
    const fromMs = generatedAtMs - this.options.config.sinceHours * 60 * 60 * 1000;
    const datasets = this.options.repositories.map((repository) =>
      this.buildDatasetReport(repository, generatedAtMs, fromMs),
    );

    return {
      generatedAtMs,
      datasets,
      recommendations: buildRecommendations(datasets),
    };
  }

  private buildDatasetReport(
    repository: CalibrationRepository,
    generatedAtMs: number,
    fromMs: number,
  ): CalibrationDatasetReport {
    const raw = repository.load(this.options.config);
    const selectedDecisions = raw.strategyDecisions
      .filter((decision) => decision.decidedAtMs >= fromMs)
      .filter((decision) => this.options.config.sourceDecisions.includes(decision.decision))
      .filter((decision) => (decision.score ?? -1) >= this.options.config.minScore)
      .slice(0, this.options.config.limit);
    const observationsByDecision = groupBy(raw.watchlistReturns, (row) => row.strategyDecisionId);
    const forwardReturnAnalyzer = new ForwardReturnAnalyzer({
      horizonsMinutes: this.options.config.horizonsMinutes,
      maxHoldMinutes: this.options.config.maxHoldMinutes,
      targetPcts: this.options.config.targetPcts,
      drawdownPcts: this.options.config.drawdownPcts,
    });
    const analyses = selectedDecisions.map((decision) => ({
      datasetLabel: raw.label,
      decisionId: decision.id,
      mintAddress: decision.mintAddress,
      decidedAtMs: decision.decidedAtMs,
      decision: decision.decision,
      score: decision.score,
      reason: decision.reason,
      attribution: this.scoreAttribution.explain(decision),
      returns: forwardReturnAnalyzer.analyze(observationsByDecision.get(decision.id) ?? []),
    }));

    return {
      label: raw.label,
      path: raw.path,
      session: {
        id: raw.session.id,
        mode: raw.session.mode,
        status: raw.session.status,
        startedAtMs: raw.session.startedAtMs,
        currentCashLamports: raw.session.currentCashLamports,
        realizedPnlLamports: raw.session.realizedPnlLamports,
        unrealizedPnlLamports: raw.session.unrealizedPnlLamports,
      } satisfies CalibrationSessionSummary,
      counts: {
        tokenRadarRows: raw.tokenRadar.length,
        uniqueRadarMints: uniqueCount(raw.tokenRadar.map((row) => row.mintAddress)),
        strategyRows: selectedDecisions.length,
        uniqueStrategyMints: uniqueCount(selectedDecisions.map((row) => row.mintAddress)),
        observedReturnRows: raw.watchlistReturns.filter((row) => row.status === "OBSERVED").length,
        riskRows: raw.riskAssessments.length,
        providerHealthRows: raw.providerHealth.length,
      } satisfies CalibrationDatasetCounts,
      scoreDistribution: buildScoreDistribution(analyses, this.options.config.scoreBucketSize),
      scoreAttribution: buildScoreAttributionSummary(analyses),
      forwardReturns: buildForwardReturnSummary(
        analyses,
        this.options.config.targetPcts,
        this.options.config.scoreBucketSize,
      ),
      targetSimulation: buildTargetSimulation(
        analyses,
        this.options.config.targetPcts,
        this.options.config.drawdownPcts,
        this.options.config.maxHoldMinutes,
      ),
      missedOpportunities: buildMissedOpportunities(analyses, this.options.config.limit),
      falsePositiveBuys: buildFalsePositiveBuys(
        analyses,
        this.options.config.targetPcts[0] ?? 10,
        this.options.config.limit,
      ),
      providerImpact: this.providerImpact.analyze(raw.providerHealth, analyses),
      thresholdComparison: this.thresholdComparison.compare(
        analyses,
        this.options.config.thresholdScenarios,
        this.options.config.targetPcts,
      ),
    };
  }
}

function buildScoreDistribution(
  analyses: readonly CalibrationDecisionAnalysis[],
  bucketSize: number,
): readonly ScoreDistributionRow[] {
  const buckets = new Map<number, CalibrationDecisionAnalysis[]>();

  for (const analysis of analyses) {
    if (analysis.score === null) {
      continue;
    }

    const bucketStart = Math.floor(analysis.score / bucketSize) * bucketSize;
    buckets.set(bucketStart, [...(buckets.get(bucketStart) ?? []), analysis]);
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([bucketStart, rows]) => {
      const bucketEnd = Math.min(100, bucketStart + bucketSize - 1);

      return {
        bucket: `${bucketStart}-${bucketEnd}`,
        total: rows.length,
        buyCount: rows.filter((row) => row.decision === "BUY").length,
        watchCount: rows.filter((row) => row.decision === "WATCH").length,
        skipCount: rows.filter((row) => row.decision === "SKIP").length,
        uniqueMints: uniqueCount(rows.map((row) => row.mintAddress)),
      };
    });
}

function buildScoreAttributionSummary(
  analyses: readonly CalibrationDecisionAnalysis[],
): ScoreAttributionSummary {
  const scores = analyses
    .map((analysis) => analysis.score)
    .filter((score): score is number => score !== null);
  const ruleRows = analyses.flatMap((analysis) => analysis.attribution.factors);
  const byRule = groupBy(ruleRows, (factor) => factor.ruleName);
  const ruleSummaries: ScoreAttributionRuleSummary[] = [...byRule.entries()]
    .map(([ruleName, factors]) => ({
      ruleName,
      count: factors.length,
      averagePoints: average(factors.map((factor) => factor.points)) ?? 0,
      zeroPointCount: factors.filter((factor) => factor.points === 0).length,
      failedCount: factors.filter((factor) => !factor.passed).length,
      warningCount: factors.filter((factor) => factor.warnings.length > 0).length,
    }))
    .sort((left, right) => left.ruleName.localeCompare(right.ruleName));

  return {
    maxObservedScore: scores.length > 0 ? Math.max(...scores) : null,
    averageScore: average(scores),
    storedScoreMismatchCount: analyses.filter(
      (analysis) =>
        analysis.score !== null &&
        analysis.attribution.factors.length > 0 &&
        analysis.score !== analysis.attribution.factorTotal,
    ).length,
    missingSnapshotCount: analyses.filter((analysis) => analysis.attribution.factors.length === 0)
      .length,
    missingQuoteCount: analyses.filter((analysis) => analysis.attribution.missingQuote).length,
    missingAuthorityEvidenceCount: analyses.filter(
      (analysis) => analysis.attribution.missingAuthorityEvidence,
    ).length,
    missingPriceImpactCount: analyses.filter((analysis) => analysis.attribution.missingPriceImpact)
      .length,
    ruleSummaries,
  };
}

function buildForwardReturnSummary(
  analyses: readonly CalibrationDecisionAnalysis[],
  targetPcts: readonly number[],
  bucketSize: number,
): ForwardReturnSummary {
  const observed = analyses.filter((analysis) => analysis.returns.bestReturnPct !== undefined);

  return {
    analyzedDecisionCount: analyses.length,
    observedDecisionCount: observed.length,
    byDecision: [...groupBy(observed, (analysis) => analysis.decision).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([decision, rows]) => buildReturnGroupSummary(decision, rows, targetPcts)),
    byScoreBucket: [
      ...groupBy(observed, (analysis) => scoreBucket(analysis.score, bucketSize)).entries(),
    ]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bucket, rows]) => buildReturnGroupSummary(bucket, rows, targetPcts)),
  };
}

function buildReturnGroupSummary(
  label: string,
  rows: readonly CalibrationDecisionAnalysis[],
  targetPcts: readonly number[],
): ReturnGroupSummary {
  return {
    label,
    count: rows.length,
    averageBestReturnPct: average(
      rows
        .map((row) => row.returns.bestReturnPct)
        .filter((value): value is number => value !== undefined),
    ),
    averageWorstReturnPct: average(
      rows
        .map((row) => row.returns.worstReturnPct)
        .filter((value): value is number => value !== undefined),
    ),
    hitRatesByTargetPct: Object.fromEntries(
      targetPcts.map((targetPct) => [`${targetPct}`, hitRate(rows, targetPct)]),
    ),
  };
}

function buildTargetSimulation(
  analyses: readonly CalibrationDecisionAnalysis[],
  targetPcts: readonly number[],
  drawdownPcts: readonly number[],
  maxHoldMinutes: number,
): TargetSimulationSummary {
  const observed = analyses.filter((analysis) => analysis.returns.observedPoints.length > 0);
  const rows: TargetSimulationRow[] = [];

  for (const targetPct of targetPcts) {
    for (const drawdownPct of drawdownPcts) {
      let targetBeforeDrawdownCount = 0;
      let drawdownBeforeTargetCount = 0;
      let ambiguousCount = 0;
      let neitherCount = 0;

      for (const analysis of observed) {
        const targetHit = analysis.returns.targetHits.find(
          (event) => event.thresholdPct === targetPct,
        );
        const drawdownBreach = analysis.returns.drawdownBreaches.find(
          (event) => event.thresholdPct === drawdownPct,
        );

        if (
          targetHit &&
          drawdownBreach &&
          targetHit.horizonMinutes === drawdownBreach.horizonMinutes
        ) {
          ambiguousCount += 1;
        } else if (
          targetHit &&
          (!drawdownBreach || targetHit.horizonMinutes < drawdownBreach.horizonMinutes)
        ) {
          targetBeforeDrawdownCount += 1;
        } else if (
          drawdownBreach &&
          (!targetHit || drawdownBreach.horizonMinutes < targetHit.horizonMinutes)
        ) {
          drawdownBeforeTargetCount += 1;
        } else {
          neitherCount += 1;
        }
      }

      rows.push({
        targetPct,
        drawdownPct,
        evaluatedCount: observed.length,
        targetBeforeDrawdownCount,
        drawdownBeforeTargetCount,
        ambiguousCount,
        neitherCount,
      });
    }
  }

  return {
    maxHoldMinutes,
    targetPcts,
    drawdownPcts,
    rows,
  };
}

function buildMissedOpportunities(
  analyses: readonly CalibrationDecisionAnalysis[],
  limit: number,
): readonly MissedOpportunityCalibrationRow[] {
  return analyses
    .filter((analysis) => analysis.decision !== "BUY")
    .filter((analysis) => (analysis.returns.bestReturnPct ?? 0) > 0)
    .sort((left, right) => (right.returns.bestReturnPct ?? 0) - (left.returns.bestReturnPct ?? 0))
    .slice(0, limit)
    .map(toOpportunityRow);
}

function buildFalsePositiveBuys(
  analyses: readonly CalibrationDecisionAnalysis[],
  targetPct: number,
  limit: number,
): readonly FalsePositiveBuyRow[] {
  return analyses
    .filter((analysis) => analysis.decision === "BUY")
    .filter((analysis) => (analysis.returns.bestReturnPct ?? -Infinity) < targetPct)
    .sort(
      (left, right) =>
        (left.returns.bestReturnPct ?? -Infinity) - (right.returns.bestReturnPct ?? -Infinity),
    )
    .slice(0, limit)
    .map((analysis) => ({
      ...toOpportunityRow(analysis),
      failedTargetPct: targetPct,
    }));
}

function toOpportunityRow(analysis: CalibrationDecisionAnalysis): MissedOpportunityCalibrationRow {
  return {
    datasetLabel: analysis.datasetLabel,
    ...(analysis.attribution.symbol ? { symbol: analysis.attribution.symbol } : {}),
    mintAddress: analysis.mintAddress,
    decision: analysis.decision,
    score: analysis.score,
    bestReturnPct: analysis.returns.bestReturnPct ?? 0,
    bestHorizonMinutes: analysis.returns.bestHorizonMinutes ?? 0,
    ...(analysis.returns.worstReturnPct !== undefined
      ? { worstReturnPct: analysis.returns.worstReturnPct }
      : {}),
    riskFlags: analysis.attribution.riskFlags,
    blockingFactors: analysis.attribution.blockingFactors,
    ...(analysis.attribution.liquidityUsd !== undefined
      ? { liquidityUsd: analysis.attribution.liquidityUsd }
      : {}),
    ...(analysis.attribution.volume1hUsd !== undefined
      ? { volume1hUsd: analysis.attribution.volume1hUsd }
      : {}),
    ...(analysis.attribution.ageSeconds !== undefined
      ? { ageSeconds: analysis.attribution.ageSeconds }
      : {}),
    missingQuote: analysis.attribution.missingQuote,
  };
}

function buildRecommendations(datasets: readonly CalibrationDatasetReport[]): readonly string[] {
  const recommendations: string[] = [];
  const allThresholdBuys = datasets.flatMap((dataset) =>
    dataset.thresholdComparison.filter((scenario) => scenario.buyScoreThreshold <= 65),
  );
  const jupiterRateLimited = datasets.some((dataset) =>
    dataset.providerImpact.providers.some(
      (provider) => provider.provider === "JUPITER" && provider.liveRateLimitedPercent >= 50,
    ),
  );
  const anyScoreMismatch = datasets.some(
    (dataset) => dataset.scoreAttribution.storedScoreMismatchCount > 0,
  );
  const scoreCeilingLow = datasets.every(
    (dataset) =>
      dataset.scoreAttribution.maxObservedScore !== null &&
      dataset.scoreAttribution.maxObservedScore <= 75,
  );

  if (jupiterRateLimited) {
    recommendations.push(
      "Jupiter live-provider rate limiting is materially high; treat quote availability as confidence evidence and keep measuring provider impact before paying for higher limits.",
    );
  }

  if (scoreCeilingLow) {
    recommendations.push(
      "Observed scores are capped at or below 75; do not expect the default 90 BUY threshold to trigger until risk PASS or scoring weights change.",
    );
  }

  if (allThresholdBuys.some((scenario) => scenario.buyCount > 0)) {
    recommendations.push(
      "Use BUY 65 / WATCH 60 only as a research or small paper threshold until target-hit and drawdown evidence improves.",
    );
  }

  if (anyScoreMismatch) {
    recommendations.push(
      "Some stored scores do not equal factor totals; inspect score snapshots before changing weights.",
    );
  }

  recommendations.push(
    "Proceed to Phase 9 only in shadow mode unless Phase 8.8 reports a positive target-before-drawdown profile for the selected threshold.",
  );

  return recommendations;
}

function scoreBucket(score: number | null, bucketSize: number): string {
  if (score === null) {
    return "n/a";
  }

  const bucketStart = Math.floor(score / bucketSize) * bucketSize;
  const bucketEnd = Math.min(100, bucketStart + bucketSize - 1);

  return `${bucketStart}-${bucketEnd}`;
}

function hitRate(rows: readonly CalibrationDecisionAnalysis[], targetPct: number): number {
  if (rows.length === 0) {
    return 0;
  }

  return (
    (rows.filter((row) => (row.returns.bestReturnPct ?? -Infinity) >= targetPct).length /
      rows.length) *
    100
  );
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function uniqueCount(values: readonly string[]): number {
  return new Set(values).size;
}

function groupBy<T>(rows: readonly T[], getKey: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const row of rows) {
    const key = getKey(row);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return grouped;
}
