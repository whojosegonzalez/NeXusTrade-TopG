import type { WatchlistReturnObservationRecord } from "../db/schema/index.js";
import type { ResearchArchiveMetadata } from "../research/ResearchAggregateTypes.js";
import type { ShadowCalibrationRawRun } from "../shadow-calibration/ShadowCalibrationTypes.js";
import { FastShadowCandidateSelector } from "./FastShadowCandidateSelector.js";
import { FAST_SHADOW_HORIZONS, FAST_SHADOW_MAX_LATE_MINUTES } from "./FastShadowTypes.js";
import type {
  FastShadowCandidateOutcome,
  FastShadowCoverageSummary,
  FastShadowExitOutcome,
  FastShadowRecommendation,
  FastShadowScenario,
  FastShadowScenarioSummary,
  FastShadowValidationReport,
} from "./FastShadowValidationTypes.js";

const scenarios: readonly FastShadowScenario[] = [
  { name: "PRIMARY", targetPct: 10, stopPct: 15, maxHoldMinutes: 15 },
  { name: "SECONDARY_10_10_15", targetPct: 10, stopPct: 10, maxHoldMinutes: 15 },
  { name: "SECONDARY_10_15_5", targetPct: 10, stopPct: 15, maxHoldMinutes: 5 },
  { name: "SECONDARY_10_10_5", targetPct: 10, stopPct: 10, maxHoldMinutes: 5 },
];

export class FastShadowValidationService {
  constructor(
    private readonly options: {
      readonly archives: readonly ResearchArchiveMetadata[];
      readonly runs: readonly ShadowCalibrationRawRun[];
      readonly clock?: () => number;
    },
  ) {}

  generate(): FastShadowValidationReport {
    const rows = this.options.runs.flatMap((run) => this.selectRun(run));
    const selected = rows.filter((row) => row.classification === "SELECTED");
    const scenarioRows = scenarios.map((scenario) => summarizeScenario(selected, scenario));
    const primary = scenarioRows[0]!;
    const concentration = summarizeConcentration(selected, primary);
    const runSummaries = this.options.runs.map((run) => summarizeRun(run, selected));
    const coverage = FAST_SHADOW_HORIZONS.map((horizonMinutes) =>
      summarizeCoverage(selected, horizonMinutes),
    );
    const sampleQuality = sampleQualityFor({ selected, runSummaries, concentration, primary });
    const decision = decideRecommendation(sampleQuality, primary);

    return {
      generatedAtMs: (this.options.clock ?? Date.now)(),
      profile: {
        id: "F65E",
        version: "v1",
        key: "F65E@v1",
        sourceDecision: "SKIP",
        scoreRange: "65-69",
        observationHorizonsMinutes: FAST_SHADOW_HORIZONS,
        maxLateMinutes: FAST_SHADOW_MAX_LATE_MINUTES,
        selectionMode: "FIRST_ELIGIBLE_PER_MINT_PER_RUN_CAP_10",
      },
      archives: this.options.archives,
      safety: {
        databaseAccess: "READ_ONLY_ARCHIVES",
        providerCalls: false,
        databaseWrites: false,
        sessionCreation: false,
        paperExecution: false,
        walletLoaded: false,
        transactionSigning: false,
        transactionSubmission: false,
      },
      runs: runSummaries,
      aggregate: {
        selectedCount: selected.length,
        selectedWith15mCoverageCount: selected.filter((row) => hasExactOnTime(row, 15)).length,
        uniqueMintCount: new Set(selected.map((row) => row.mintAddress)).size,
        classificationCounts: countClassifications(rows),
        coverage,
        orderCount: sum(this.options.runs.map((run) => run.orderCount)),
        fillCount: sum(this.options.runs.map((run) => run.fillCount)),
        positionCount: sum(this.options.runs.map((run) => run.positionCount)),
      },
      controls: Object.entries(countClassifications(rows))
        .filter(([classification]) => classification !== "SELECTED")
        .map(([classification, count]) => ({
          classification: classification as FastShadowCandidateOutcome["classification"],
          count,
        })),
      scenarios: scenarioRows,
      concentration,
      sampleQuality,
      recommendation: decision.recommendation,
      recommendationReason: decision.reason,
      candidates: rows,
      limitations: [
        "F65E@v1 is an archived PAPER shadow study; it cannot model executable fills, fees, slippage, latency, MEV, or intra-interval paths.",
        "Only exact on-time 3/5/15-minute observations are eligible for fast-exit calculations; late observations are retained as coverage diagnostics.",
        "PREPARE_SEPARATE_PROMOTION_REVIEW authorizes only a later review and never enables paper BUY or live execution.",
      ],
    };
  }

  private selectRun(run: ShadowCalibrationRawRun): readonly FastShadowCandidateOutcome[] {
    if (run.sourceKind !== "database") return [];
    const selection = new FastShadowCandidateSelector().select(run.strategyDecisions);
    const observationsByDecision = new Map<string, WatchlistReturnObservationRecord[]>();
    for (const observation of run.watchlistReturns) {
      if (!FAST_SHADOW_HORIZONS.includes(observation.horizonMinutes as 3 | 5 | 15)) continue;
      observationsByDecision.set(observation.strategyDecisionId, [
        ...(observationsByDecision.get(observation.strategyDecisionId) ?? []),
        observation,
      ]);
    }
    return selection.candidates.map((candidate) => {
      const observations = observationsByDecision.get(candidate.decision.id) ?? [];
      const coverage = FAST_SHADOW_HORIZONS.map((horizonMinutes) =>
        coverageFor(observations, horizonMinutes),
      );
      const points = observedPoints(observations);
      return {
        runLabel: run.label,
        decisionId: candidate.decision.id,
        mintAddress: candidate.decision.mintAddress,
        ...(candidate.attribution.symbol ? { symbol: candidate.attribution.symbol } : {}),
        score: candidate.decision.score,
        decidedAtMs: candidate.decision.decidedAtMs,
        classification: candidate.classification,
        classificationReason: candidate.reason,
        coverage,
        outcomes: scenarios.map((scenario) => outcomeFor(points, scenario)),
      };
    });
  }
}

function coverageFor(
  observations: readonly WatchlistReturnObservationRecord[],
  horizonMinutes: 3 | 5 | 15,
): FastShadowCoverageSummary {
  const row = observations
    .filter((observation) => observation.horizonMinutes === horizonMinutes)
    .sort(
      (left, right) =>
        (left.observedAtMs ?? Number.MAX_SAFE_INTEGER) -
        (right.observedAtMs ?? Number.MAX_SAFE_INTEGER),
    )[0];
  const returnValue = row ? observedReturn(row) : undefined;
  const onTime =
    row?.status === "OBSERVED" &&
    returnValue !== undefined &&
    row.observedAtMs !== null &&
    row.observedAtMs <= row.dueAtMs + FAST_SHADOW_MAX_LATE_MINUTES * 60_000;
  const late = row?.status === "OBSERVED" && returnValue !== undefined && !onTime;
  return {
    horizonMinutes,
    exactOnTimeCount: onTime ? 1 : 0,
    lateCount: late ? 1 : 0,
    missingCount: onTime || late ? 0 : 1,
  };
}

function observedPoints(
  observations: readonly WatchlistReturnObservationRecord[],
): readonly { readonly horizonMinutes: number; readonly returnPct: number }[] {
  return observations
    .filter((observation) => observation.status === "OBSERVED")
    .filter(
      (observation) =>
        observation.observedAtMs !== null &&
        observation.observedAtMs <= observation.dueAtMs + FAST_SHADOW_MAX_LATE_MINUTES * 60_000,
    )
    .map((observation) => ({
      horizonMinutes: observation.horizonMinutes,
      returnPct: observedReturn(observation),
    }))
    .filter(
      (point): point is { readonly horizonMinutes: number; readonly returnPct: number } =>
        point.returnPct !== undefined,
    )
    .sort((left, right) => left.horizonMinutes - right.horizonMinutes);
}

function observedReturn(observation: WatchlistReturnObservationRecord): number | undefined {
  const raw = observation.returnPctSol ?? observation.returnPctUsd;
  const value = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function outcomeFor(
  allPoints: readonly { readonly horizonMinutes: number; readonly returnPct: number }[],
  scenario: FastShadowScenario,
): FastShadowCandidateOutcome["outcomes"][number] {
  const points = allPoints.filter((point) => point.horizonMinutes <= scenario.maxHoldMinutes);
  const exactExitPoint = points.find((point) => point.horizonMinutes === scenario.maxHoldMinutes);
  const target = points.find((point) => point.returnPct >= scenario.targetPct);
  const stop = points.find((point) => point.returnPct <= -scenario.stopPct);
  let outcome: FastShadowExitOutcome;
  let exitReturnPct: number | undefined;
  if (target && stop) {
    if (target.horizonMinutes === stop.horizonMinutes) outcome = "AMBIGUOUS";
    else if (target.horizonMinutes < stop.horizonMinutes) {
      outcome = "TARGET_FIRST";
      exitReturnPct = scenario.targetPct;
    } else {
      outcome = "STOP_FIRST";
      exitReturnPct = -scenario.stopPct;
    }
  } else if (target) {
    outcome = "TARGET_FIRST";
    exitReturnPct = scenario.targetPct;
  } else if (stop) {
    outcome = "STOP_FIRST";
    exitReturnPct = -scenario.stopPct;
  } else if (exactExitPoint) {
    outcome = "MAX_HOLD";
    exitReturnPct = exactExitPoint.returnPct;
  } else {
    outcome = "NO_OBSERVATION";
  }
  const returns = points.map((point) => point.returnPct);
  return {
    scenario,
    outcome,
    ...(returns.length ? { mfePct: Math.max(...returns), maePct: Math.min(...returns) } : {}),
    ...(exitReturnPct === undefined ? {} : { exitReturnPct }),
  };
}

function summarizeScenario(
  candidates: readonly FastShadowCandidateOutcome[],
  scenario: FastShadowScenario,
): FastShadowScenarioSummary {
  const outcomes = candidates.map((candidate) =>
    candidate.outcomes.find((outcome) => outcome.scenario.name === scenario.name),
  );
  const count = (name: FastShadowExitOutcome) =>
    outcomes.filter((outcome) => outcome?.outcome === name).length;
  const evaluable = outcomes.filter((outcome) => outcome && outcome.outcome !== "NO_OBSERVATION");
  const mfes = evaluable.flatMap((outcome) =>
    outcome?.mfePct === undefined ? [] : [outcome.mfePct],
  );
  const maes = evaluable.flatMap((outcome) =>
    outcome?.maePct === undefined ? [] : [outcome.maePct],
  );
  const exits = evaluable.flatMap((outcome) =>
    outcome?.exitReturnPct === undefined ? [] : [outcome.exitReturnPct],
  );
  return {
    scenario,
    candidateCount: candidates.length,
    evaluableCount: evaluable.length,
    targetFirstCount: count("TARGET_FIRST"),
    stopFirstCount: count("STOP_FIRST"),
    maxHoldCount: count("MAX_HOLD"),
    noObservationCount: count("NO_OBSERVATION"),
    ambiguousCount: count("AMBIGUOUS"),
    targetFirstRatePct: percentage(count("TARGET_FIRST"), evaluable.length),
    stopFirstRatePct: percentage(count("STOP_FIRST"), evaluable.length),
    ...(mfes.length ? { averageMfePct: average(mfes), medianMfePct: median(mfes) } : {}),
    ...(maes.length ? { averageMaePct: average(maes), medianMaePct: median(maes) } : {}),
    ...(exits.length
      ? { averageExitReturnPct: average(exits), medianExitReturnPct: median(exits) }
      : {}),
  };
}

function summarizeRun(
  run: ShadowCalibrationRawRun,
  selected: readonly FastShadowCandidateOutcome[],
) {
  const candidates = selected.filter((candidate) => candidate.runLabel === run.label);
  return {
    label: run.label,
    mechanicallyValid: run.orderCount === 0 && run.fillCount === 0 && run.positionCount === 0,
    selectedCount: candidates.length,
    selectedWith15mCoverageCount: candidates.filter((candidate) => hasExactOnTime(candidate, 15))
      .length,
    orderCount: run.orderCount,
    fillCount: run.fillCount,
    positionCount: run.positionCount,
    warnings: run.warnings,
  };
}

function summarizeCoverage(
  candidates: readonly FastShadowCandidateOutcome[],
  horizonMinutes: 3 | 5 | 15,
): FastShadowCoverageSummary {
  const coverage = candidates.map((candidate) =>
    candidate.coverage.find((row) => row.horizonMinutes === horizonMinutes),
  );
  return {
    horizonMinutes,
    exactOnTimeCount: sum(coverage.map((row) => row?.exactOnTimeCount ?? 0)),
    lateCount: sum(coverage.map((row) => row?.lateCount ?? 0)),
    missingCount: sum(coverage.map((row) => row?.missingCount ?? 0)),
  };
}

function hasExactOnTime(
  candidate: FastShadowCandidateOutcome,
  horizonMinutes: 3 | 5 | 15,
): boolean {
  return candidate.coverage.some(
    (coverage) => coverage.horizonMinutes === horizonMinutes && coverage.exactOnTimeCount === 1,
  );
}

function countClassifications(candidates: readonly FastShadowCandidateOutcome[]) {
  const counts: Record<FastShadowCandidateOutcome["classification"], number> = {
    SELECTED: 0,
    NOT_BASELINE_SKIP: 0,
    SCORE_BAND_MISMATCH: 0,
    THRESHOLD_SNAPSHOT_MISMATCH: 0,
    INVALID_SNAPSHOT: 0,
    HARD_GATE_BLOCKED: 0,
    MISSING_PRICE_OR_QUOTE_EVIDENCE: 0,
    MISSING_BASELINE_PRICE: 0,
    DUPLICATE_MINT_SUPPRESSED: 0,
    SESSION_CAP_SUPPRESSED: 0,
  };
  for (const candidate of candidates) counts[candidate.classification] += 1;
  return counts;
}

function summarizeConcentration(
  selected: readonly FastShadowCandidateOutcome[],
  primary: FastShadowScenarioSummary,
) {
  const winners = selected.filter(
    (candidate) =>
      candidate.outcomes.find((outcome) => outcome.scenario.name === primary.scenario.name)
        ?.outcome === "TARGET_FIRST",
  );
  const direction = primary.targetFirstCount > primary.stopFirstCount;
  return {
    maxSelectedMintSharePct: maxShare(
      selected.map((candidate) => candidate.mintAddress),
      selected.length,
    ),
    maxSelectedRunSharePct: maxShare(
      selected.map((candidate) => candidate.runLabel),
      selected.length,
    ),
    maxPrimaryWinnerMintSharePct: maxShare(
      winners.map((candidate) => candidate.mintAddress),
      winners.length,
    ),
    maxPrimaryWinnerRunSharePct: maxShare(
      winners.map((candidate) => candidate.runLabel),
      winners.length,
    ),
    leaveOneMintOutStable: leaveOneOutStable(selected, "mint", direction),
    leaveOneRunOutStable: leaveOneOutStable(selected, "run", direction),
  };
}

function leaveOneOutStable(
  selected: readonly FastShadowCandidateOutcome[],
  dimension: "mint" | "run",
  expectedDirection: boolean,
): boolean {
  const values = [
    ...new Set(
      selected.map((candidate) =>
        dimension === "mint" ? candidate.mintAddress : candidate.runLabel,
      ),
    ),
  ];
  if (values.length < 2) return false;
  return values.every((value) => {
    const remaining = selected.filter(
      (candidate) => (dimension === "mint" ? candidate.mintAddress : candidate.runLabel) !== value,
    );
    const target = remaining.filter(
      (candidate) =>
        candidate.outcomes.find((outcome) => outcome.scenario.name === "PRIMARY")?.outcome ===
        "TARGET_FIRST",
    ).length;
    const stop = remaining.filter(
      (candidate) =>
        candidate.outcomes.find((outcome) => outcome.scenario.name === "PRIMARY")?.outcome ===
        "STOP_FIRST",
    ).length;
    return target > stop === expectedDirection;
  });
}

function sampleQualityFor(input: {
  readonly selected: readonly FastShadowCandidateOutcome[];
  readonly runSummaries: readonly FastShadowValidationReport["runs"][number][];
  readonly concentration: FastShadowValidationReport["concentration"];
  readonly primary: FastShadowScenarioSummary;
}) {
  const failed: string[] = [];
  const validRuns = input.runSummaries.filter((run) => run.mechanicallyValid).length;
  const covered = input.selected.filter((candidate) => hasExactOnTime(candidate, 15));
  if (validRuns < 3) failed.push("at least 3 mechanically valid fresh runs are required");
  if (covered.length < 20)
    failed.push(
      "at least 20 selected candidates with exact on-time 15-minute coverage are required",
    );
  if (new Set(input.selected.map((candidate) => candidate.mintAddress)).size < 15)
    failed.push("at least 15 unique selected mints are required");
  if (input.concentration.maxSelectedMintSharePct > 40)
    failed.push("no selected mint may exceed 40% of the cohort");
  if (input.concentration.maxSelectedRunSharePct > 40)
    failed.push("no selected run may exceed 40% of the cohort");
  if (!input.concentration.leaveOneMintOutStable)
    failed.push("leave-one-mint-out direction must remain stable");
  if (!input.concentration.leaveOneRunOutStable)
    failed.push("leave-one-run-out direction must remain stable");
  if (input.primary.targetFirstRatePct < 55)
    failed.push("primary target-first rate must be at least 55%");
  if (input.primary.stopFirstRatePct > 25)
    failed.push("primary stop-first rate must be at most 25%");
  if (input.primary.targetFirstRatePct - input.primary.stopFirstRatePct < 20)
    failed.push("primary target-first minus stop-first rate must be at least 20 percentage points");
  if ((input.primary.medianMfePct ?? -Infinity) < 10)
    failed.push("primary median MFE must be at least +10%");
  if ((input.primary.medianMaePct ?? -Infinity) <= -15)
    failed.push("primary median MAE must remain above -15%");
  return { passed: failed.length === 0, failedRequirements: failed };
}

function decideRecommendation(
  sampleQuality: FastShadowValidationReport["sampleQuality"],
  primary: FastShadowScenarioSummary,
): { readonly recommendation: FastShadowRecommendation; readonly reason: string } {
  if (sampleQuality.passed) {
    return {
      recommendation: "PREPARE_SEPARATE_PROMOTION_REVIEW",
      reason:
        "all pre-registered sample and primary-profile gates passed; this is review authorization only",
    };
  }
  if (primary.evaluableCount < 20 || primary.candidateCount < 20) {
    return {
      recommendation: "COLLECT_MORE_INDEPENDENT_DATA",
      reason: "the pre-registered fast cohort has insufficient exact 15-minute evidence",
    };
  }
  if (primary.targetFirstRatePct < 55 || primary.stopFirstRatePct > 25) {
    return {
      recommendation: "REJECT_FAST_EXIT_PROFILE",
      reason: "the primary 10/15/15 fast-exit outcome failed its target/stop quality gate",
    };
  }
  return {
    recommendation: "CONTINUE_SHADOW_RESEARCH",
    reason:
      "the primary direction is not rejected, but sample quality or stability gates remain unmet",
  };
}

function maxShare(values: readonly string[], total: number): number {
  if (total === 0) return 0;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return (Math.max(0, ...counts.values()) / total) * 100;
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
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}
