import { ForwardReturnAnalyzer } from "../calibration/ForwardReturnAnalyzer.js";
import { ScoreAttributionService } from "../calibration/ScoreAttributionService.js";
import type { ReturnPoint } from "../calibration/CalibrationTypes.js";
import { summarizeProviderPressureMetrics } from "../providers/ProviderPressureClassifier.js";
import type { ShadowCalibrationRuntimeConfig } from "./ShadowCalibrationConfig.js";
import type {
  CandidateFilterSummary,
  EntryConfirmationSummary,
  ShadowCalibrationDecisionAnalysis,
  ShadowCalibrationExitReason,
  ShadowCalibrationRawRun,
  ShadowCalibrationRecommendation,
  ShadowCalibrationReport,
  ShadowCalibrationRunSummary,
  ShadowDecisionOutcomeSummary,
  ShadowExitOutcome,
  ShadowScenario,
  ShadowScenarioPortfolioSummary,
  ShadowUniqueMintOutcomeSummary,
} from "./ShadowCalibrationTypes.js";

export interface ShadowCalibrationReportServiceInput {
  readonly config: ShadowCalibrationRuntimeConfig;
  readonly runs: readonly ShadowCalibrationRawRun[];
  readonly clock?: () => number;
}

interface ConfirmationOutcome {
  readonly confirmed: boolean;
  readonly noData: boolean;
  readonly missedFastMove: boolean;
  readonly rejected: boolean;
  readonly laterBestReturnPct?: number;
  readonly exitOutcome?: ShadowExitOutcome;
}

const ALL_LABEL = "ALL";

export class ShadowCalibrationReportService {
  private readonly config: ShadowCalibrationRuntimeConfig;
  private readonly runs: readonly ShadowCalibrationRawRun[];
  private readonly clock: () => number;
  private readonly attributions = new ScoreAttributionService();

  constructor(input: ShadowCalibrationReportServiceInput) {
    this.config = input.config;
    this.runs = input.runs;
    this.clock = input.clock ?? Date.now;
  }

  generate(): ShadowCalibrationReport {
    const analyses = this.runs.flatMap((run) => this.analyzeRun(run));
    const databaseRuns = this.runs.filter((run) => run.sourceKind === "database");

    return {
      generatedAtMs: this.clock(),
      config: this.config,
      runs: this.runs.map((run) => this.summarizeRun(run, analyses)),
      aggregate: {
        runCount: this.runs.length,
        databaseRunCount: databaseRuns.length,
        reportOnlyRunCount: this.runs.length - databaseRuns.length,
        observedDecisionCount: analyses.filter((analysis) => analysis.observedPoints.length > 0)
          .length,
        uniqueMintCount: new Set(analyses.map((analysis) => analysis.mintAddress)).size,
        orderCount: sum(this.runs.map((run) => run.orderCount)),
        fillCount: sum(this.runs.map((run) => run.fillCount)),
        positionCount: sum(this.runs.map((run) => run.positionCount)),
      },
      decisionOutcomes: this.summarizeDecisionOutcomes(analyses),
      uniqueMintOutcomes: this.summarizeUniqueMintOutcomes(analyses),
      scenarioPortfolioGrid: this.buildScenarioPortfolioGrid(analyses),
      confirmationResults: this.buildConfirmationResults(analyses),
      filterAnalysis: this.buildFilterAnalysis(analyses),
      recommendations: this.buildRecommendations(analyses),
      nextTestPlan: this.buildNextTestPlan(),
    };
  }

  private analyzeRun(run: ShadowCalibrationRawRun): readonly ShadowCalibrationDecisionAnalysis[] {
    if (run.sourceKind !== "database") {
      return [];
    }

    const observationsByDecisionId = groupBy(
      run.watchlistReturns,
      (observation) => observation.strategyDecisionId,
    );
    const horizons = [
      ...new Set([
        ...run.watchlistReturns.map((observation) => observation.horizonMinutes),
        ...this.config.maxHoldMinutes,
      ]),
    ].sort((left, right) => left - right);
    const analyzer = new ForwardReturnAnalyzer({
      horizonsMinutes: horizons,
      maxHoldMinutes: Math.max(...this.config.maxHoldMinutes),
      targetPcts: this.config.targetPcts,
      drawdownPcts: this.config.stopPcts,
    });

    return run.strategyDecisions
      .filter((decision) => this.config.sourceDecisions.includes(decision.decision))
      .filter((decision) => (decision.score ?? -1) >= this.config.minScore)
      .map((decision) => {
        const attribution = this.attributions.explain(decision);
        const returns = analyzer.analyze(observationsByDecisionId.get(decision.id) ?? []);

        return {
          runLabel: run.label,
          decisionId: decision.id,
          mintAddress: decision.mintAddress,
          decidedAtMs: decision.decidedAtMs,
          decision: decision.decision,
          score: decision.score,
          attribution,
          observedPoints: returns.observedPoints,
          ...(returns.bestReturnPct !== undefined
            ? {
                bestReturnPct: returns.bestReturnPct,
                bestHorizonMinutes: returns.bestHorizonMinutes,
              }
            : {}),
          ...(returns.worstReturnPct !== undefined
            ? {
                worstReturnPct: returns.worstReturnPct,
                worstHorizonMinutes: returns.worstHorizonMinutes,
              }
            : {}),
        };
      });
  }

  private summarizeRun(
    run: ShadowCalibrationRawRun,
    analyses: readonly ShadowCalibrationDecisionAnalysis[],
  ): ShadowCalibrationRunSummary {
    const runAnalyses = analyses.filter((analysis) => analysis.runLabel === run.label);
    const mechanicallyValid =
      run.orderCount === 0 && run.fillCount === 0 && run.positionCount === 0;
    const scannerLogs = run.systemLogs.filter((log) => log.scope === "SCANNER");
    const scannerCycleCount = scannerLogs.filter((log) =>
      log.message.toLowerCase().includes("cycle"),
    ).length;
    const scannerRuntimeMinutes = calculateRuntimeMinutes(
      scannerLogs.map((log) => log.timestampMs),
    );
    const jupiterRows = run.providerHealth.filter(
      (row) => row.provider.toUpperCase() === "JUPITER",
    );
    const jupiterPressure = summarizeProviderPressureMetrics(jupiterRows);
    const jupiterRateLimitedPercent =
      jupiterRows.length === 0 ? undefined : jupiterPressure.liveRateLimitedPct;

    return {
      label: run.label,
      path: run.path,
      sourceKind: run.sourceKind,
      ...(run.session ? { sessionId: run.session.id } : {}),
      mechanicallyValid,
      warnings: [
        ...run.warnings,
        ...(mechanicallyValid
          ? []
          : [
              `Run contains paper execution rows: orders=${run.orderCount} fills=${run.fillCount} positions=${run.positionCount}.`,
            ]),
      ],
      ...(scannerRuntimeMinutes !== undefined ? { scannerRuntimeMinutes } : {}),
      ...(scannerCycleCount > 0 ? { scannerCycleCount } : {}),
      riskSummaryCount: countLogs(run.systemLogs, "RISK"),
      strategySummaryCount: countLogs(run.systemLogs, "STRATEGY"),
      tokenRadarRows: run.tokenRadar.length || run.reportOnlySummary?.radarRows || 0,
      ...(run.tokenRadar.length > 0
        ? { uniqueRadarMints: new Set(run.tokenRadar.map((row) => row.mintAddress)).size }
        : {}),
      riskRows: run.riskAssessments.length,
      strategyRows: run.strategyDecisions.length || run.reportOnlySummary?.strategyRows || 0,
      ...(run.strategyDecisions.length > 0
        ? {
            uniqueStrategyMints: new Set(run.strategyDecisions.map((row) => row.mintAddress)).size,
          }
        : {}),
      observedReturnRows:
        run.watchlistReturns.length || run.reportOnlySummary?.observedReturnRows || 0,
      ...(runAnalyses.length > 0
        ? {
            observedDecisionCount: runAnalyses.filter(
              (analysis) => analysis.observedPoints.length > 0,
            ).length,
          }
        : {}),
      providerHealthRows:
        run.providerHealth.length || run.reportOnlySummary?.providerHealthRows || 0,
      ...(jupiterRateLimitedPercent !== undefined ? { jupiterRateLimitedPercent } : {}),
      orderCount: run.orderCount,
      fillCount: run.fillCount,
      positionCount: run.positionCount,
    };
  }

  private summarizeDecisionOutcomes(
    analyses: readonly ShadowCalibrationDecisionAnalysis[],
  ): readonly ShadowDecisionOutcomeSummary[] {
    return summarizeByLabelsAndDecisions(analyses, (label, group, items) =>
      summarizeOutcomeGroup(label, group, items, this.config.targetPcts, this.config.stopPcts),
    );
  }

  private summarizeUniqueMintOutcomes(
    analyses: readonly ShadowCalibrationDecisionAnalysis[],
  ): readonly ShadowUniqueMintOutcomeSummary[] {
    return summarizeByLabelsAndDecisions(analyses, (label, group, items) => ({
      ...summarizeOutcomeGroup(
        label,
        group,
        dedupeAnalyses(items, this.config.dedupeMode),
        this.config.targetPcts,
        this.config.stopPcts,
      ),
      dedupeMode: this.config.dedupeMode,
    }));
  }

  private buildScenarioPortfolioGrid(
    analyses: readonly ShadowCalibrationDecisionAnalysis[],
  ): readonly ShadowScenarioPortfolioSummary[] {
    const scenarios = buildScenarios(this.config);
    const groups = buildLabelGroups(analyses);
    const summaries: ShadowScenarioPortfolioSummary[] = [];

    for (const [label, items] of groups) {
      const selected = [...dedupeAnalyses(items, this.config.dedupeMode)].sort(
        (left, right) => left.decidedAtMs - right.decidedAtMs,
      );

      for (const scenario of scenarios) {
        const outcomes = selected.map((analysis) =>
          simulateScenario(analysis.observedPoints, scenario),
        );
        const returns = outcomes
          .map((outcome) => outcome.exitReturnPct)
          .filter((value): value is number => value !== undefined);
        const portfolio = simulatePortfolio(
          outcomes,
          this.config.portfolioStartingSol,
          this.config.portfolioPositionSizeSol,
          this.config.portfolioMaxPositions,
        );

        summaries.push({
          label,
          targetPct: scenario.targetPct,
          stopPct: scenario.stopPct,
          maxHoldMinutes: scenario.maxHoldMinutes,
          evaluatedCount: outcomes.length,
          targetHitCount: countExitReason(outcomes, "TARGET_HIT"),
          stopHitCount: countExitReason(outcomes, "STOP_HIT"),
          maxHoldCount: countExitReason(outcomes, "MAX_HOLD"),
          noObservationCount: countExitReason(outcomes, "NO_OBSERVATION"),
          ambiguousCount: countExitReason(outcomes, "AMBIGUOUS"),
          ...(returns.length > 0 ? { averageExitReturnPct: average(returns) } : {}),
          ...(returns.length > 0 ? { medianExitReturnPct: median(returns) } : {}),
          winRatePct: outcomes.length === 0 ? 0 : percentage(countWins(outcomes), outcomes.length),
          lossRatePct:
            outcomes.length === 0 ? 0 : percentage(countLosses(outcomes), outcomes.length),
          simulatedEndingSol: portfolio.endingSol,
          simulatedPnlSol: portfolio.pnlSol,
          simulatedPnlPct: portfolio.pnlPct,
          maxDrawdownPct: portfolio.maxDrawdownPct,
          goalReached:
            portfolio.endingSol >=
            this.config.portfolioStartingSol * (1 + this.config.portfolioGoalPct / 100),
        });
      }
    }

    return summaries.sort(
      (left, right) =>
        Number(right.goalReached) - Number(left.goalReached) ||
        right.simulatedPnlPct - left.simulatedPnlPct ||
        left.maxDrawdownPct - right.maxDrawdownPct,
    );
  }

  private buildConfirmationResults(
    analyses: readonly ShadowCalibrationDecisionAnalysis[],
  ): readonly EntryConfirmationSummary[] {
    const targetPct = this.config.targetPcts[0] ?? 10;
    const stopPct = this.config.stopPcts[0] ?? 10;
    const maxHoldMinutes = this.config.maxHoldMinutes[0] ?? 60;
    const groups = buildLabelGroups(analyses);
    const results: EntryConfirmationSummary[] = [];

    for (const [label, items] of groups) {
      for (const horizonMinutes of this.config.confirmationHorizonsMinutes) {
        for (const minReturnPct of this.config.confirmationMinReturnPcts) {
          for (const maxDrawdownPct of this.config.confirmationMaxDrawdownPcts) {
            const outcomes = items.map((analysis) =>
              simulateEntryConfirmation(analysis, {
                horizonMinutes,
                minReturnPct,
                maxDrawdownPct,
                targetPct,
                stopPct,
                maxHoldMinutes,
              }),
            );
            const confirmed = outcomes.filter((outcome) => outcome.confirmed);
            const confirmedReturns = confirmed
              .map((outcome) => outcome.exitOutcome?.exitReturnPct)
              .filter((value): value is number => value !== undefined);

            results.push({
              label,
              horizonMinutes,
              minReturnPct,
              maxDrawdownPct,
              targetPct,
              stopPct,
              maxHoldMinutes,
              consideredCount: items.length,
              confirmedCount: confirmed.length,
              rejectedCount: outcomes.filter((outcome) => outcome.rejected).length,
              noDataCount: outcomes.filter((outcome) => outcome.noData).length,
              missedFastMoveCount: outcomes.filter((outcome) => outcome.missedFastMove).length,
              targetHitCount: confirmed.filter(
                (outcome) => outcome.exitOutcome?.exitReason === "TARGET_HIT",
              ).length,
              stopHitCount: confirmed.filter(
                (outcome) => outcome.exitOutcome?.exitReason === "STOP_HIT",
              ).length,
              ...(confirmedReturns.length > 0
                ? { averageConfirmedExitReturnPct: average(confirmedReturns) }
                : {}),
              falsePositiveBuysAvoided: outcomes.filter(
                (outcome, index) =>
                  items[index]?.decision === "BUY" && (outcome.rejected || outcome.noData),
              ).length,
              missedWinnersCausedByWaiting: outcomes.filter(
                (outcome) =>
                  (outcome.rejected || outcome.noData || outcome.missedFastMove) &&
                  (outcome.laterBestReturnPct ?? Number.NEGATIVE_INFINITY) >= targetPct,
              ).length,
            });
          }
        }
      }
    }

    return results.sort(
      (left, right) =>
        right.targetHitCount - left.targetHitCount ||
        left.stopHitCount - right.stopHitCount ||
        left.missedWinnersCausedByWaiting - right.missedWinnersCausedByWaiting,
    );
  }

  private buildFilterAnalysis(
    analyses: readonly ShadowCalibrationDecisionAnalysis[],
  ): readonly CandidateFilterSummary[] {
    const rows: CandidateFilterSummary[] = [];

    for (const [label, items] of buildLabelGroups(analyses)) {
      rows.push(...summarizeFilter(label, "decision", items, (analysis) => analysis.decision));
      rows.push(
        ...summarizeFilter(label, "score_bucket", items, (analysis) =>
          scoreBucket(analysis.score, this.config.scoreBucketSize),
        ),
      );
      rows.push(
        ...summarizeFilter(label, "quote", items, (analysis) =>
          analysis.attribution.missingQuote ? "missing_quote" : "quote_available",
        ),
      );
      rows.push(
        ...summarizeFilter(
          label,
          "risk",
          items,
          (analysis) => analysis.attribution.riskResult ?? "risk_unknown",
        ),
      );
      rows.push(
        ...summarizeFilter(label, "duplicate_buy", items, (analysis) =>
          analysis.attribution.duplicateBuyBlocked ? "duplicate_blocked" : "not_duplicate",
        ),
      );
    }

    return rows;
  }

  private buildRecommendations(
    analyses: readonly ShadowCalibrationDecisionAnalysis[],
  ): readonly ShadowCalibrationRecommendation[] {
    const recommendations: ShadowCalibrationRecommendation[] = [];
    const observed = analyses.filter((analysis) => analysis.observedPoints.length > 0);
    const buy = observed.filter((analysis) => analysis.decision === "BUY");
    const watch = observed.filter((analysis) => analysis.decision === "WATCH");
    const score55To64 = observed.filter(
      (analysis) => (analysis.score ?? -1) >= 55 && (analysis.score ?? -1) <= 64,
    );
    const target = this.config.targetPcts[0] ?? 10;
    const buyHitRate = hitRate(buy, target);
    const watchHitRate = hitRate(watch, target);
    const score55HitRate = hitRate(score55To64, target);
    const jupiterRates = this.runs
      .map((run) => {
        const rows = run.providerHealth.filter((row) => row.provider.toUpperCase() === "JUPITER");

        return rows.length === 0
          ? undefined
          : percentage(rows.filter((row) => row.status === "RATE_LIMITED").length, rows.length);
      })
      .filter((value): value is number => value !== undefined);
    const averageJupiterRateLimit = jupiterRates.length > 0 ? average(jupiterRates) : undefined;

    if (observed.length < 30) {
      recommendations.push({
        confidence: "LOW",
        category: "sample_size",
        recommendation:
          "Keep Phase 8.91 in diagnostics mode and gather more shadow observations before changing live scoring behavior.",
        evidence: [`Observed decisions available for full analysis: ${observed.length}.`],
      });
    }

    if (buy.length > 0 && buyHitRate < 50) {
      recommendations.push({
        confidence: buy.length >= 10 ? "MEDIUM" : "LOW",
        category: "buy_threshold",
        recommendation:
          "Do not lower real BUY thresholds yet; validate entry-confirmed WATCH/score-band candidates first.",
        evidence: [
          `BUY +${target}% hit rate: ${buyHitRate.toFixed(2)}% across ${buy.length} observed decisions.`,
        ],
      });
    }

    if (watch.length > 0 && watchHitRate > buyHitRate) {
      recommendations.push({
        confidence: watch.length >= 10 ? "MEDIUM" : "LOW",
        category: "watch_first",
        recommendation:
          "Consider a Phase 8.92 WATCH-first entry rule where promising WATCH candidates require short-horizon confirmation before simulated BUY.",
        evidence: [
          `WATCH +${target}% hit rate: ${watchHitRate.toFixed(2)}%; BUY +${target}% hit rate: ${buyHitRate.toFixed(2)}%.`,
        ],
      });
    }

    if (score55To64.length > 0 && score55HitRate >= buyHitRate) {
      recommendations.push({
        confidence: score55To64.length >= 10 ? "MEDIUM" : "LOW",
        category: "score_band",
        recommendation:
          "Treat score 55-64 as a shadow-confirmation band rather than an automatic BUY band.",
        evidence: [
          `Score 55-64 +${target}% hit rate: ${score55HitRate.toFixed(2)}% across ${score55To64.length} observed decisions.`,
        ],
      });
    }

    if (averageJupiterRateLimit !== undefined && averageJupiterRateLimit >= 25) {
      recommendations.push({
        confidence: "MEDIUM",
        category: "provider_load",
        recommendation:
          "Keep quote-failure penalties visible in reports, but avoid treating missing Jupiter quote as a hard strategy failure while rate limiting is elevated.",
        evidence: [
          `Average Jupiter RATE_LIMITED rate across archived database runs: ${averageJupiterRateLimit.toFixed(2)}%.`,
        ],
      });
    }

    recommendations.push({
      confidence: "HIGH",
      category: "phase_boundary",
      recommendation:
        "Keep Phase 8.91 read-only. Any scoring or entry-rule change should be implemented separately in Phase 8.92 with fresh A/B shadow tests.",
      evidence: [
        `Read-only diagnostics checked ${this.runs.length} run source(s) and ${observed.length} observed decision(s).`,
      ],
    });

    return recommendations;
  }

  private buildNextTestPlan(): readonly string[] {
    return [
      "Run one fresh 90-120 minute Phase 8.91 shadow window after any Phase 8.92 scoring proposal.",
      "Compare decision-level and unique-mint metrics before trusting any threshold change.",
      "Use the best 10/15/25 target-stop grid only as research evidence; do not enable real paper BUYs from this report alone.",
      "Capture another multi-hour run during a different market window if the top scenario result is driven by fewer than 10 observed decisions.",
    ];
  }
}

function summarizeByLabelsAndDecisions<T>(
  analyses: readonly ShadowCalibrationDecisionAnalysis[],
  summarize: (
    label: string,
    group: string,
    items: readonly ShadowCalibrationDecisionAnalysis[],
  ) => T,
): readonly T[] {
  const summaries: T[] = [];

  for (const [label, items] of buildLabelGroups(analyses)) {
    summaries.push(summarize(label, "ALL_DECISIONS", items));

    for (const decision of unique(items.map((analysis) => analysis.decision))) {
      summaries.push(
        summarize(
          label,
          decision,
          items.filter((analysis) => analysis.decision === decision),
        ),
      );
    }
  }

  return summaries;
}

function summarizeOutcomeGroup(
  label: string,
  group: string,
  items: readonly ShadowCalibrationDecisionAnalysis[],
  targetPcts: readonly number[],
  stopPcts: readonly number[],
): ShadowDecisionOutcomeSummary {
  const bestReturns = items
    .map((analysis) => analysis.bestReturnPct)
    .filter((value): value is number => value !== undefined);
  const worstReturns = items
    .map((analysis) => analysis.worstReturnPct)
    .filter((value): value is number => value !== undefined);

  return {
    label,
    group,
    count: items.length,
    uniqueMints: new Set(items.map((analysis) => analysis.mintAddress)).size,
    ...(bestReturns.length > 0 ? { averageBestReturnPct: average(bestReturns) } : {}),
    ...(worstReturns.length > 0 ? { averageWorstReturnPct: average(worstReturns) } : {}),
    ...(bestReturns.length > 0 ? { medianBestReturnPct: median(bestReturns) } : {}),
    ...(worstReturns.length > 0 ? { medianWorstReturnPct: median(worstReturns) } : {}),
    targetHitRates: Object.fromEntries(
      targetPcts.map((targetPct) => [targetPct.toString(), hitRate(items, targetPct)]),
    ),
    drawdownFirstRates: Object.fromEntries(
      stopPcts.map((stopPct) => [
        stopPct.toString(),
        drawdownFirstRate(items, targetPcts[0] ?? 10, stopPct),
      ]),
    ),
  };
}

function buildLabelGroups(
  analyses: readonly ShadowCalibrationDecisionAnalysis[],
): ReadonlyMap<string, readonly ShadowCalibrationDecisionAnalysis[]> {
  const groups = new Map<string, readonly ShadowCalibrationDecisionAnalysis[]>();

  if (analyses.length === 0) {
    return groups;
  }

  const byRun = groupBy(analyses, (analysis) => analysis.runLabel);

  for (const [label, items] of byRun) {
    groups.set(label, items);
  }

  groups.set(ALL_LABEL, analyses);

  return groups;
}

function buildScenarios(config: ShadowCalibrationRuntimeConfig): readonly ShadowScenario[] {
  return config.targetPcts.flatMap((targetPct) =>
    config.stopPcts.flatMap((stopPct) =>
      config.maxHoldMinutes.map((maxHoldMinutes) => ({
        targetPct,
        stopPct,
        maxHoldMinutes,
      })),
    ),
  );
}

function simulateScenario(
  observedPoints: readonly ReturnPoint[],
  scenario: ShadowScenario,
): ShadowExitOutcome {
  const eligible = observedPoints.filter(
    (point) => point.horizonMinutes <= scenario.maxHoldMinutes,
  );

  if (eligible.length === 0) {
    return {
      scenario,
      exitReason: "NO_OBSERVATION",
    };
  }

  for (const point of eligible) {
    const targetHit = point.returnPct >= scenario.targetPct;
    const stopHit = point.returnPct <= -scenario.stopPct;

    if (targetHit && stopHit) {
      return {
        scenario,
        exitReason: "AMBIGUOUS",
        exitReturnPct: point.returnPct,
        exitHorizonMinutes: point.horizonMinutes,
      };
    }

    if (targetHit) {
      return {
        scenario,
        exitReason: "TARGET_HIT",
        exitReturnPct: scenario.targetPct,
        exitHorizonMinutes: point.horizonMinutes,
      };
    }

    if (stopHit) {
      return {
        scenario,
        exitReason: "STOP_HIT",
        exitReturnPct: -scenario.stopPct,
        exitHorizonMinutes: point.horizonMinutes,
      };
    }
  }

  const finalPoint = eligible[eligible.length - 1];

  if (!finalPoint) {
    return {
      scenario,
      exitReason: "NO_OBSERVATION",
    };
  }

  return {
    scenario,
    exitReason: "MAX_HOLD",
    exitReturnPct: finalPoint.returnPct,
    exitHorizonMinutes: finalPoint.horizonMinutes,
  };
}

function simulateEntryConfirmation(
  analysis: ShadowCalibrationDecisionAnalysis,
  input: {
    readonly horizonMinutes: number;
    readonly minReturnPct: number;
    readonly maxDrawdownPct: number;
    readonly targetPct: number;
    readonly stopPct: number;
    readonly maxHoldMinutes: number;
  },
): ConfirmationOutcome {
  const sorted = [...analysis.observedPoints].sort(
    (left, right) => left.horizonMinutes - right.horizonMinutes,
  );
  const throughConfirmation = sorted.filter(
    (point) => point.horizonMinutes <= input.horizonMinutes,
  );
  const confirmationPoint = sorted.find((point) => point.horizonMinutes >= input.horizonMinutes);
  const laterPoints = sorted.filter((point) => point.horizonMinutes > input.horizonMinutes);
  const laterBestReturnPct =
    laterPoints.length > 0
      ? Math.max(...laterPoints.map((point) => point.returnPct))
      : analysis.bestReturnPct;

  if (throughConfirmation.some((point) => point.returnPct >= input.targetPct)) {
    return {
      confirmed: false,
      noData: false,
      missedFastMove: true,
      rejected: false,
      ...(laterBestReturnPct !== undefined ? { laterBestReturnPct } : {}),
    };
  }

  if (!confirmationPoint) {
    return {
      confirmed: false,
      noData: true,
      missedFastMove: false,
      rejected: false,
      ...(laterBestReturnPct !== undefined ? { laterBestReturnPct } : {}),
    };
  }

  if (
    throughConfirmation.some((point) => point.returnPct <= -input.maxDrawdownPct) ||
    confirmationPoint.returnPct < input.minReturnPct
  ) {
    return {
      confirmed: false,
      noData: false,
      missedFastMove: false,
      rejected: true,
      ...(laterBestReturnPct !== undefined ? { laterBestReturnPct } : {}),
    };
  }

  const rebasedPoints = laterPoints.map((point) => ({
    horizonMinutes: point.horizonMinutes - input.horizonMinutes,
    returnPct: rebaseReturnPct(point.returnPct, confirmationPoint.returnPct),
  }));
  const exitOutcome = simulateScenario(rebasedPoints, {
    targetPct: input.targetPct,
    stopPct: input.stopPct,
    maxHoldMinutes: input.maxHoldMinutes,
  });

  return {
    confirmed: true,
    noData: false,
    missedFastMove: false,
    rejected: false,
    ...(laterBestReturnPct !== undefined ? { laterBestReturnPct } : {}),
    exitOutcome,
  };
}

function summarizeFilter(
  label: string,
  filterName: string,
  analyses: readonly ShadowCalibrationDecisionAnalysis[],
  getBucket: (analysis: ShadowCalibrationDecisionAnalysis) => string,
): readonly CandidateFilterSummary[] {
  return [...groupBy(analyses, getBucket)].map(([bucket, items]) => ({
    label,
    filterName,
    bucket,
    count: items.length,
    sampleWarning: items.length < 5,
    targetHitRates: Object.fromEntries(
      [10, 15, 25].map((targetPct) => [targetPct.toString(), hitRate(items, targetPct)]),
    ),
    drawdownFirstRates: Object.fromEntries(
      [10, 15, 25].map((stopPct) => [stopPct.toString(), drawdownFirstRate(items, 10, stopPct)]),
    ),
    ...optionalAverageBestWorst(items),
  }));
}

function optionalAverageBestWorst(
  items: readonly ShadowCalibrationDecisionAnalysis[],
): Pick<
  CandidateFilterSummary,
  "averageBestReturnPct" | "averageWorstReturnPct" | "medianBestReturnPct" | "medianWorstReturnPct"
> {
  const bestReturns = items
    .map((analysis) => analysis.bestReturnPct)
    .filter((value): value is number => value !== undefined);
  const worstReturns = items
    .map((analysis) => analysis.worstReturnPct)
    .filter((value): value is number => value !== undefined);

  return {
    ...(bestReturns.length > 0 ? { averageBestReturnPct: average(bestReturns) } : {}),
    ...(worstReturns.length > 0 ? { averageWorstReturnPct: average(worstReturns) } : {}),
    ...(bestReturns.length > 0 ? { medianBestReturnPct: median(bestReturns) } : {}),
    ...(worstReturns.length > 0 ? { medianWorstReturnPct: median(worstReturns) } : {}),
  };
}

function dedupeAnalyses(
  analyses: readonly ShadowCalibrationDecisionAnalysis[],
  mode: string,
): readonly ShadowCalibrationDecisionAnalysis[] {
  if (mode === "decision") {
    return analyses;
  }

  return [...groupBy(analyses, (analysis) => analysis.mintAddress).values()]
    .map((items) => pickDedupeWinner(items, mode))
    .filter((item): item is ShadowCalibrationDecisionAnalysis => item !== undefined);
}

function pickDedupeWinner(
  items: readonly ShadowCalibrationDecisionAnalysis[],
  mode: string,
): ShadowCalibrationDecisionAnalysis | undefined {
  if (items.length === 0) {
    return undefined;
  }

  if (mode === "mint_best_entry") {
    return [...items].sort(
      (left, right) =>
        (right.bestReturnPct ?? Number.NEGATIVE_INFINITY) -
          (left.bestReturnPct ?? Number.NEGATIVE_INFINITY) || right.decidedAtMs - left.decidedAtMs,
    )[0];
  }

  if (mode === "mint_latest_entry") {
    return [...items].sort((left, right) => right.decidedAtMs - left.decidedAtMs)[0];
  }

  return [...items].sort((left, right) => left.decidedAtMs - right.decidedAtMs)[0];
}

function simulatePortfolio(
  outcomes: readonly ShadowExitOutcome[],
  startingSol: number,
  positionSizeSol: number,
  maxPositions: number,
): {
  readonly endingSol: number;
  readonly pnlSol: number;
  readonly pnlPct: number;
  readonly maxDrawdownPct: number;
} {
  let balance = startingSol;
  let peak = startingSol;
  let maxDrawdownPct = 0;

  for (const outcome of outcomes.slice(0, maxPositions)) {
    if (outcome.exitReturnPct === undefined) {
      continue;
    }

    balance += positionSizeSol * (outcome.exitReturnPct / 100);
    peak = Math.max(peak, balance);
    maxDrawdownPct = Math.max(maxDrawdownPct, percentage(peak - balance, peak));
  }

  return {
    endingSol: balance,
    pnlSol: balance - startingSol,
    pnlPct: percentage(balance - startingSol, startingSol),
    maxDrawdownPct,
  };
}

function scoreBucket(score: number | null, bucketSize: number): string {
  if (score === null) {
    return "score_unknown";
  }

  const start = Math.floor(score / bucketSize) * bucketSize;
  const end = Math.min(100, start + bucketSize - 1);

  return `${start}-${end}`;
}

function hitRate(
  analyses: readonly ShadowCalibrationDecisionAnalysis[],
  targetPct: number,
): number {
  const observed = analyses.filter((analysis) => analysis.observedPoints.length > 0);

  if (observed.length === 0) {
    return 0;
  }

  return percentage(
    observed.filter((analysis) => (analysis.bestReturnPct ?? Number.NEGATIVE_INFINITY) >= targetPct)
      .length,
    observed.length,
  );
}

function drawdownFirstRate(
  analyses: readonly ShadowCalibrationDecisionAnalysis[],
  targetPct: number,
  stopPct: number,
): number {
  const observed = analyses.filter((analysis) => analysis.observedPoints.length > 0);

  if (observed.length === 0) {
    return 0;
  }

  const count = observed.filter((analysis) => {
    const outcome = simulateScenario(analysis.observedPoints, {
      targetPct,
      stopPct,
      maxHoldMinutes: Math.max(...analysis.observedPoints.map((point) => point.horizonMinutes)),
    });

    return outcome.exitReason === "STOP_HIT";
  }).length;

  return percentage(count, observed.length);
}

function countExitReason(
  outcomes: readonly ShadowExitOutcome[],
  reason: ShadowCalibrationExitReason,
): number {
  return outcomes.filter((outcome) => outcome.exitReason === reason).length;
}

function countWins(outcomes: readonly ShadowExitOutcome[]): number {
  return outcomes.filter((outcome) => (outcome.exitReturnPct ?? 0) > 0).length;
}

function countLosses(outcomes: readonly ShadowExitOutcome[]): number {
  return outcomes.filter((outcome) => (outcome.exitReturnPct ?? 0) < 0).length;
}

function rebaseReturnPct(laterReturnPct: number, entryReturnPct: number): number {
  return ((1 + laterReturnPct / 100) / (1 + entryReturnPct / 100) - 1) * 100;
}

function countLogs(runLogs: readonly { readonly scope: string }[], scope: string): number {
  return runLogs.filter((log) => log.scope === scope).length;
}

function calculateRuntimeMinutes(timestamps: readonly number[]): number | undefined {
  if (timestamps.length < 2) {
    return undefined;
  }

  return (Math.max(...timestamps) - Math.min(...timestamps)) / 60_000;
}

function groupBy<T>(
  items: readonly T[],
  getKey: (item: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = getKey(item);
    const group = groups.get(key);

    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  return groups;
}

function unique<T>(items: readonly T[]): readonly T[] {
  return [...new Set(items)];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: readonly number[]): number {
  return sum(values) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const middleValue = sorted[middle];

  if (middleValue === undefined) {
    return 0;
  }

  if (sorted.length % 2 === 1) {
    return middleValue;
  }

  const previousValue = sorted[middle - 1] ?? middleValue;

  return (previousValue + middleValue) / 2;
}

function percentage(count: number, total: number): number {
  return total === 0 ? 0 : (count / total) * 100;
}
