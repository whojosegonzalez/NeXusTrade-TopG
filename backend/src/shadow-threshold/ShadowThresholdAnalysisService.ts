import type { ReturnPoint, ScoreAttribution } from "../calibration/CalibrationTypes.js";
import { ScoreAttributionService } from "../calibration/ScoreAttributionService.js";
import type { StrategyDecisionRecord } from "../db/schema/index.js";
import type { ResearchArchiveMetadata } from "../research/ResearchAggregateTypes.js";
import type { ShadowCalibrationRawRun } from "../shadow-calibration/ShadowCalibrationTypes.js";
import type {
  ShadowThresholdClassification,
  ShadowThresholdControlSummary,
  ShadowThresholdHorizonOutcome,
  ShadowThresholdRace,
  ShadowThresholdRaceOutcome,
  ShadowThresholdRecommendation,
  ShadowThresholdReport,
  ShadowThresholdScenarioSummary,
  ShadowThresholdSelectedCandidate,
  ShadowThresholdSourceRow,
} from "./ShadowThresholdTypes.js";
import { shadowThresholdProfile } from "./ShadowThresholdTypes.js";

const scoreMin = 65;
const scoreMax = 69;
const targetPcts = [10, 15, 25] as const;
const stopPcts = [10, 15, 25] as const;
const maxHoldMinutes = [15, 30, 60] as const;
const requiredFactorNames = [
  "risk_eligibility",
  "liquidity_attractiveness",
  "volume_1h_attractiveness",
  "pair_age_attractiveness",
  "price_impact_attractiveness",
] as const;
const classifications: readonly ShadowThresholdClassification[] = [
  "SELECTED",
  "NOT_SCORE_BAND",
  "NOT_BASELINE_SKIP",
  "THRESHOLD_SNAPSHOT_MISMATCH",
  "MISSING_OR_INVALID_SCORE_SNAPSHOT",
  "HARD_GATE_BLOCKED",
  "MISSING_QUOTE_OR_PRICE_IMPACT",
  "DUPLICATE_ATTENTION_SUPPRESSED",
  "NO_FORWARD_OBSERVATION",
];

interface ClassifiedCandidate extends ShadowThresholdSourceRow {
  readonly preliminarilyEligible: boolean;
}

export class ShadowThresholdAnalysisService {
  constructor(
    private readonly options: {
      readonly archives: readonly ResearchArchiveMetadata[];
      readonly runs: readonly ShadowCalibrationRawRun[];
      readonly clock?: () => number;
    },
  ) {}

  generate(): ShadowThresholdReport {
    const sourceRows = this.classifySourceRows();
    const selection = selectFirstEligibleCandidates(sourceRows);
    const classifiedRows = sourceRows.map((row) => {
      const override = selection.classificationByDecisionId.get(row.decisionId);

      return override
        ? { ...row, classification: override.classification, classificationReason: override.reason }
        : row;
    });
    const selectedCandidates = selection.selectedCandidates;
    const selectedObserved = selectedCandidates.filter(
      (candidate) => candidate.classification === "SELECTED",
    );
    const runSummaries = this.options.runs.map((run) => summarizeRun(run, selectedCandidates));
    const scenarioSummaries = summarizeScenarios(selectedCandidates);
    const primaryScenario = scenarioSummaries.find(
      (scenario) =>
        scenario.targetPct === 10 && scenario.stopPct === 10 && scenario.maxHoldMinutes === 60,
    );
    const concentration = summarizeConcentration(selectedObserved, primaryScenario);
    const sampleQuality = summarizeSampleQuality({
      archives: this.options.archives,
      selectedCandidates,
      selectedObserved,
      concentration,
      runSummaries,
    });
    const recommendation = decideRecommendation({
      sampleQuality,
      primaryScenario,
    });

    return {
      generatedAtMs: (this.options.clock ?? Date.now)(),
      config: {
        profileId: shadowThresholdProfile.id,
        profileVersion: shadowThresholdProfile.version,
        profileKey: shadowThresholdProfile.key,
        sourceDecision: "SKIP",
        scoreMin,
        scoreMax,
        originalBuyScoreThreshold: 90,
        originalWatchScoreThreshold: 70,
        targetPcts,
        stopPcts,
        maxHoldMinutes,
        selectionMode: "FIRST_ELIGIBLE_PER_MINT_PER_RUN",
      },
      archives: this.options.archives,
      safety: {
        databaseAccess: "READ_ONLY_ARCHIVES",
        providerCalls: false,
        databaseWrites: false,
        sessionCreation: false,
        strategyDefaultsChanged: false,
        paperExecution: false,
        walletLoaded: false,
        transactionSigning: false,
        transactionSubmission: false,
      },
      runs: runSummaries,
      aggregate: {
        sourceDecisionCount: sourceRows.length,
        scoreBandCount: sourceRows.filter(
          (row) => row.decision === "SKIP" && row.score !== null && isInScoreBand(row.score),
        ).length,
        thresholdOnlyEligibleCount: sourceRows.filter((row) => row.preliminarilyEligible).length,
        selectedCount: selectedCandidates.length,
        selectedObservedCount: selectedObserved.length,
        selectedWith60mObservationCount: selectedObserved.filter((candidate) =>
          candidate.outcomes.some(
            (outcome) => outcome.maxHoldMinutes === 60 && outcome.observedPointCount > 0,
          ),
        ).length,
        uniqueSelectedMintCount: new Set(
          selectedCandidates.map((candidate) => candidate.mintAddress),
        ).size,
        runsWithSelectedCandidateCount: new Set(
          selectedCandidates.map((candidate) => candidate.runLabel),
        ).size,
        classificationCounts: countClassifications(classifiedRows),
        orderCount: sum(this.options.runs.map((run) => run.orderCount)),
        fillCount: sum(this.options.runs.map((run) => run.fillCount)),
        positionCount: sum(this.options.runs.map((run) => run.positionCount)),
      },
      selectedCandidates,
      controls: summarizeControls(classifiedRows),
      scenarios: scenarioSummaries,
      concentration,
      sampleQuality,
      recommendation: recommendation.value,
      recommendationReason: recommendation.reason,
      limitations: [
        "T65N@v1 evaluates archived SKIP decisions only and does not alter the production 90/70 strategy defaults.",
        "Selections use stored decision-time snapshots and the earliest eligible decision per mint per run; future returns never decide inclusion.",
        "Forward returns do not model fills, fees, sell liquidity, transaction latency, or live execution capacity.",
        "This command never creates sessions, writes to a database, invokes providers, loads a wallet, signs, or submits transactions.",
      ],
    };
  }

  private classifySourceRows(): readonly ClassifiedCandidate[] {
    const attributionService = new ScoreAttributionService();
    const rows: ClassifiedCandidate[] = [];

    for (const run of this.options.runs) {
      if (run.sourceKind !== "database") {
        continue;
      }

      const observationsByDecision = groupByDecision(run);
      const attentionCounts = countByMint(run.strategyDecisions);

      for (const decision of run.strategyDecisions) {
        const attribution = attributionService.explain(decision);
        const classification = classifyDecision(decision, attribution);
        const attentionCount = attentionCounts.get(decision.mintAddress) ?? 1;
        const baseRow: ShadowThresholdSourceRow = {
          profileId: shadowThresholdProfile.id,
          profileVersion: shadowThresholdProfile.version,
          profileKey: shadowThresholdProfile.key,
          runLabel: run.label,
          decisionId: decision.id,
          mintAddress: decision.mintAddress,
          ...(attribution.symbol ? { symbol: attribution.symbol } : {}),
          decidedAtMs: decision.decidedAtMs,
          decision: decision.decision,
          reason: decision.reason,
          score: decision.score,
          attribution,
          observedPoints: observationsByDecision.get(decision.id) ?? [],
          repeatedAttentionCount: attentionCount,
          repeatedAttentionStrength: attentionStrength(attentionCount),
          classification: classification.value,
          classificationReason: classification.reason,
        };

        rows.push({
          ...baseRow,
          preliminarilyEligible: classification.preliminarilyEligible,
        });
      }
    }

    return rows.sort(
      (left, right) =>
        left.decidedAtMs - right.decidedAtMs || left.decisionId.localeCompare(right.decisionId),
    );
  }
}

function classifyDecision(
  decision: StrategyDecisionRecord,
  attribution: ScoreAttribution,
): {
  readonly value: ShadowThresholdClassification;
  readonly reason: string;
  readonly preliminarilyEligible: boolean;
} {
  if (decision.decision !== "SKIP") {
    return {
      value: "NOT_BASELINE_SKIP",
      reason: "recorded decision is not SKIP",
      preliminarilyEligible: false,
    };
  }

  if (
    decision.score === null ||
    !Number.isInteger(decision.score) ||
    attribution.factors.length === 0
  ) {
    return {
      value: "MISSING_OR_INVALID_SCORE_SNAPSHOT",
      reason: "stored score or score-factor snapshot is missing or invalid",
      preliminarilyEligible: false,
    };
  }

  if (!isInScoreBand(decision.score)) {
    return {
      value: "NOT_SCORE_BAND",
      reason: "score is outside the inclusive 65-69 band",
      preliminarilyEligible: false,
    };
  }

  if (
    attribution.buyScoreThreshold !== 90 ||
    attribution.watchScoreThreshold !== 70 ||
    attribution.rawDecision !== "SKIP"
  ) {
    return {
      value: "THRESHOLD_SNAPSHOT_MISMATCH",
      reason: "snapshot does not record the immutable 90/70 baseline as SKIP",
      preliminarilyEligible: false,
    };
  }

  const factors = new Map(attribution.factors.map((factor) => [factor.ruleName, factor]));
  const missingOrFailedPriceImpact =
    attribution.missingQuote ||
    attribution.missingPriceImpact ||
    !factors.get("price_impact_attractiveness")?.passed;

  if (missingOrFailedPriceImpact) {
    return {
      value: "MISSING_QUOTE_OR_PRICE_IMPACT",
      reason: "quote or price-impact evidence is absent or the price-impact gate did not pass",
      preliminarilyEligible: false,
    };
  }

  const failedHardGate = requiredFactorNames
    .filter((name) => name !== "price_impact_attractiveness")
    .find((name) => !factors.get(name)?.passed);

  if (!attribution.buyEligible || failedHardGate) {
    return {
      value: "HARD_GATE_BLOCKED",
      reason: failedHardGate
        ? `hard gate did not pass: ${failedHardGate}`
        : "snapshot does not mark the candidate buy-eligible",
      preliminarilyEligible: false,
    };
  }

  return {
    value: "SELECTED",
    reason: "meets the immutable T65N@v1 score and hard-gate contract",
    preliminarilyEligible: true,
  };
}

function selectFirstEligibleCandidates(rows: readonly ClassifiedCandidate[]): {
  readonly selectedCandidates: readonly ShadowThresholdSelectedCandidate[];
  readonly classificationByDecisionId: ReadonlyMap<
    string,
    { readonly classification: ShadowThresholdClassification; readonly reason: string }
  >;
} {
  const grouped = new Map<string, ClassifiedCandidate[]>();

  for (const row of rows.filter((item) => item.preliminarilyEligible)) {
    const key = `${row.runLabel}:${row.mintAddress}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  const selectedCandidates: ShadowThresholdSelectedCandidate[] = [];
  const classificationByDecisionId = new Map<
    string,
    { readonly classification: ShadowThresholdClassification; readonly reason: string }
  >();

  for (const groupedRows of grouped.values()) {
    const chronological = [...groupedRows].sort(
      (left, right) =>
        left.decidedAtMs - right.decidedAtMs || left.decisionId.localeCompare(right.decisionId),
    );

    const [first, ...duplicates] = chronological;
    if (!first) {
      continue;
    }
    const classification: ShadowThresholdClassification =
      first.observedPoints.length === 0 ? "NO_FORWARD_OBSERVATION" : "SELECTED";
    const classificationReason =
      first.observedPoints.length === 0
        ? "eligible at decision time, but no observed forward return is archived"
        : first.classificationReason;
    classificationByDecisionId.set(first.decisionId, {
      classification,
      reason: classificationReason,
    });
    selectedCandidates.push({
      ...first,
      classification,
      classificationReason,
      selectedAtDecisionTime: true,
      outcomes: summarizeCandidateOutcomes(first.observedPoints),
    });

    for (const duplicate of duplicates) {
      classificationByDecisionId.set(duplicate.decisionId, {
        classification: "DUPLICATE_ATTENTION_SUPPRESSED",
        reason: "a prior eligible decision for this mint/run was selected at decision time",
      });
    }
  }

  return {
    selectedCandidates: selectedCandidates.sort(
      (left, right) =>
        left.decidedAtMs - right.decidedAtMs || left.decisionId.localeCompare(right.decisionId),
    ),
    classificationByDecisionId,
  };
}

function summarizeCandidateOutcomes(
  observedPoints: readonly ReturnPoint[],
): readonly ShadowThresholdHorizonOutcome[] {
  return maxHoldMinutes.map((maxHold) => {
    const points = observedPoints.filter((point) => point.horizonMinutes <= maxHold);
    const returns = points.map((point) => point.returnPct);

    return {
      maxHoldMinutes: maxHold,
      observedPointCount: points.length,
      hasExactHorizonObservation: points.some((point) => point.horizonMinutes === maxHold),
      ...(returns.length > 0
        ? {
            mfePct: Math.max(...returns),
            maePct: Math.min(...returns),
            averageReturnPct: average(returns),
            medianReturnPct: median(returns),
          }
        : {}),
      races: targetPcts.flatMap((targetPct) =>
        stopPcts.map((stopPct) => raceForPoints(points, targetPct, stopPct)),
      ),
    };
  });
}

function raceForPoints(
  points: readonly ReturnPoint[],
  targetPct: number,
  stopPct: number,
): ShadowThresholdRace {
  if (points.length === 0) {
    return { targetPct, stopPct, outcome: "NO_OBSERVATION" };
  }

  const target = points.find((point) => point.returnPct >= targetPct);
  const stop = points.find((point) => point.returnPct <= -stopPct);
  const outcome = determineRaceOutcome(target?.horizonMinutes, stop?.horizonMinutes);

  return {
    targetPct,
    stopPct,
    outcome,
    ...(target ? { targetHorizonMinutes: target.horizonMinutes } : {}),
    ...(stop ? { stopHorizonMinutes: stop.horizonMinutes } : {}),
  };
}

function determineRaceOutcome(
  targetHorizonMinutes: number | undefined,
  stopHorizonMinutes: number | undefined,
): ShadowThresholdRaceOutcome {
  if (targetHorizonMinutes === undefined && stopHorizonMinutes === undefined) {
    return "NEITHER";
  }
  if (targetHorizonMinutes === undefined) {
    return "STOP_FIRST";
  }
  if (stopHorizonMinutes === undefined) {
    return "TARGET_FIRST";
  }
  if (targetHorizonMinutes === stopHorizonMinutes) {
    return "AMBIGUOUS";
  }

  return targetHorizonMinutes < stopHorizonMinutes ? "TARGET_FIRST" : "STOP_FIRST";
}

function summarizeRun(
  run: ShadowCalibrationRawRun,
  candidates: readonly ShadowThresholdSelectedCandidate[],
) {
  const selected = candidates.filter((candidate) => candidate.runLabel === run.label);

  return {
    label: run.label,
    mechanicallyValid: run.orderCount === 0 && run.fillCount === 0 && run.positionCount === 0,
    sourceDecisionCount: run.strategyDecisions.length,
    selectedCount: selected.length,
    selectedObservedCount: selected.filter((candidate) => candidate.classification === "SELECTED")
      .length,
    uniqueSelectedMints: new Set(selected.map((candidate) => candidate.mintAddress)).size,
    orderCount: run.orderCount,
    fillCount: run.fillCount,
    positionCount: run.positionCount,
    warnings: run.warnings,
  };
}

function summarizeControls(
  rows: readonly ClassifiedCandidate[],
): readonly ShadowThresholdControlSummary[] {
  return classifications
    .filter((classification) => classification !== "SELECTED")
    .map((classification) => {
      const candidates = rows.filter((row) => row.classification === classification);
      const observed = candidates.filter((candidate) => candidate.observedPoints.length > 0);
      const best = observed.map((candidate) =>
        Math.max(...candidate.observedPoints.map((point) => point.returnPct)),
      );
      const worst = observed.map((candidate) =>
        Math.min(...candidate.observedPoints.map((point) => point.returnPct)),
      );

      return {
        classification,
        count: candidates.length,
        observedCount: observed.length,
        uniqueMints: new Set(candidates.map((candidate) => candidate.mintAddress)).size,
        ...(best.length > 0 ? { averageBestReturnPct: average(best) } : {}),
        ...(worst.length > 0 ? { averageWorstReturnPct: average(worst) } : {}),
      };
    });
}

function summarizeScenarios(
  candidates: readonly ShadowThresholdSelectedCandidate[],
): readonly ShadowThresholdScenarioSummary[] {
  return maxHoldMinutes.flatMap((maxHold) =>
    targetPcts.flatMap((targetPct) =>
      stopPcts.map((stopPct) => {
        const outcomes = candidates.map((candidate) =>
          candidate.outcomes.find((outcome) => outcome.maxHoldMinutes === maxHold),
        );
        const races = outcomes.map((outcome) =>
          outcome?.races.find((race) => race.targetPct === targetPct && race.stopPct === stopPct),
        );
        const observedOutcomes = outcomes.filter(
          (outcome): outcome is ShadowThresholdHorizonOutcome =>
            outcome !== undefined && outcome.observedPointCount > 0,
        );
        const counted = (outcome: ShadowThresholdRaceOutcome): number =>
          races.filter((race) => race?.outcome === outcome).length;
        const observedCount = observedOutcomes.length;
        const values = (key: "mfePct" | "maePct" | "averageReturnPct") =>
          observedOutcomes
            .map((outcome) => outcome[key])
            .filter((value): value is number => value !== undefined);

        const mfe = values("mfePct");
        const mae = values("maePct");
        const returns = values("averageReturnPct");

        return {
          targetPct,
          stopPct,
          maxHoldMinutes: maxHold,
          candidateCount: candidates.length,
          observedCount,
          targetFirstCount: counted("TARGET_FIRST"),
          stopFirstCount: counted("STOP_FIRST"),
          ambiguousCount: counted("AMBIGUOUS"),
          neitherCount: counted("NEITHER"),
          noObservationCount: counted("NO_OBSERVATION"),
          targetFirstRatePct: percentage(counted("TARGET_FIRST"), observedCount),
          stopFirstRatePct: percentage(counted("STOP_FIRST"), observedCount),
          ...(mfe.length > 0 ? { averageMfePct: average(mfe), medianMfePct: median(mfe) } : {}),
          ...(mae.length > 0 ? { averageMaePct: average(mae), medianMaePct: median(mae) } : {}),
          ...(returns.length > 0
            ? { averageReturnPct: average(returns), medianReturnPct: median(returns) }
            : {}),
        };
      }),
    ),
  );
}

function summarizeConcentration(
  selected: readonly ShadowThresholdSelectedCandidate[],
  primaryScenario: ShadowThresholdScenarioSummary | undefined,
) {
  const selectedByMint = countBy(selected, (candidate) => candidate.mintAddress);
  const selectedByRun = countBy(selected, (candidate) => candidate.runLabel);
  const primaryWinners = selected.filter(
    (candidate) => raceFor(candidate, 60, 10, 10) === "TARGET_FIRST",
  );
  const winnersByMint = countBy(primaryWinners, (candidate) => candidate.mintAddress);
  const winnersByRun = countBy(primaryWinners, (candidate) => candidate.runLabel);
  const direction = primaryScenario
    ? primaryScenario.targetFirstCount > primaryScenario.stopFirstCount
    : false;

  return {
    maxSelectedMintSharePct: maxShare(selectedByMint, selected.length),
    maxSelectedRunSharePct: maxShare(selectedByRun, selected.length),
    maxTargetFirstMintSharePct: maxShare(winnersByMint, primaryWinners.length),
    maxTargetFirstRunSharePct: maxShare(winnersByRun, primaryWinners.length),
    leaveOneRunOutStable: leaveOneOutStable(selected, "run", direction),
    leaveOneMintOutStable: leaveOneOutStable(selected, "mint", direction),
  };
}

function summarizeSampleQuality(input: {
  readonly archives: readonly ResearchArchiveMetadata[];
  readonly selectedCandidates: readonly ShadowThresholdSelectedCandidate[];
  readonly selectedObserved: readonly ShadowThresholdSelectedCandidate[];
  readonly concentration: ShadowThresholdReport["concentration"];
  readonly runSummaries: readonly ShadowThresholdReport["runs"][number][];
}) {
  const selectedWith60m = input.selectedObserved.filter((candidate) =>
    candidate.outcomes.some(
      (outcome) => outcome.maxHoldMinutes === 60 && outcome.observedPointCount > 0,
    ),
  );
  const failedRequirements: string[] = [];
  const validArchives = input.runSummaries.filter((run) => run.mechanicallyValid).length;
  const uniqueMintCount = new Set(
    input.selectedCandidates.map((candidate) => candidate.mintAddress),
  ).size;
  const runsWithCandidates = new Set(
    input.selectedCandidates.map((candidate) => candidate.runLabel),
  ).size;

  if (validArchives < 3)
    failedRequirements.push("at least 3 mechanically valid archive runs are required");
  if (selectedWith60m.length < 15)
    failedRequirements.push(
      "at least 15 selected candidates with 60-minute observations are required",
    );
  if (uniqueMintCount < 10)
    failedRequirements.push("at least 10 unique selected mints are required");
  if (runsWithCandidates < 3)
    failedRequirements.push("selected candidates must span at least 3 runs");
  if (input.concentration.maxSelectedMintSharePct > 40)
    failedRequirements.push("no selected mint may exceed 40% of selections");
  if (input.concentration.maxTargetFirstRunSharePct > 40)
    failedRequirements.push("no run may contribute more than 40% of target-first outcomes");
  if (!input.concentration.leaveOneRunOutStable)
    failedRequirements.push("leave-one-run-out direction must remain stable");
  if (!input.concentration.leaveOneMintOutStable)
    failedRequirements.push("leave-one-mint-out direction must remain stable");

  return {
    validArchiveCount: validArchives,
    selectedCount: input.selectedCandidates.length,
    selectedWith60mObservationCount: selectedWith60m.length,
    uniqueSelectedMintCount: uniqueMintCount,
    runsWithSelectedCandidateCount: runsWithCandidates,
    sampleGatePassed: failedRequirements.length === 0,
    failedRequirements,
  };
}

function decideRecommendation(input: {
  readonly sampleQuality: ShadowThresholdReport["sampleQuality"];
  readonly primaryScenario: ShadowThresholdScenarioSummary | undefined;
}): { readonly value: ShadowThresholdRecommendation; readonly reason: string } {
  if (!input.sampleQuality.sampleGatePassed) {
    return {
      value: "COLLECT_MORE_INDEPENDENT_DATA",
      reason: `The immutable sample gate has not passed: ${input.sampleQuality.failedRequirements.join("; ")}.`,
    };
  }

  if (!input.primaryScenario || input.primaryScenario.observedCount === 0) {
    return {
      value: "COLLECT_MORE_INDEPENDENT_DATA",
      reason: "The primary 10/10/60 scenario has no observed selected candidates.",
    };
  }

  if (
    input.primaryScenario.targetFirstCount <= input.primaryScenario.stopFirstCount ||
    (input.primaryScenario.medianMaePct !== undefined && input.primaryScenario.medianMaePct <= -10)
  ) {
    return {
      value: "REJECT_NARROW_THRESHOLD",
      reason:
        "The primary 10/10/60 scenario does not demonstrate a favorable target-first or adverse-excursion balance.",
    };
  }

  if (
    input.primaryScenario.targetFirstRatePct >= 55 &&
    input.primaryScenario.stopFirstRatePct <= 30 &&
    (input.primaryScenario.medianMfePct ?? Number.NEGATIVE_INFINITY) >= 10 &&
    (input.primaryScenario.medianMaePct ?? Number.NEGATIVE_INFINITY) > -10
  ) {
    return {
      value: "PREPARE_SEPARATE_PROMOTION_REVIEW",
      reason:
        "The primary 10/10/60 scenario clears the narrow research signal bar; any promotion remains a separate review.",
    };
  }

  return {
    value: "CONTINUE_SHADOW_RESEARCH",
    reason:
      "The sample gate passed, but the primary 10/10/60 evidence is not yet strong enough for a promotion review.",
  };
}

function groupByDecision(
  run: ShadowCalibrationRawRun,
): ReadonlyMap<string, readonly ReturnPoint[]> {
  const grouped = new Map<string, ReturnPoint[]>();

  for (const observation of run.watchlistReturns) {
    if (observation.status !== "OBSERVED") continue;
    const returnPct = Number(observation.returnPctSol ?? observation.returnPctUsd);
    if (!Number.isFinite(returnPct)) continue;

    grouped.set(observation.strategyDecisionId, [
      ...(grouped.get(observation.strategyDecisionId) ?? []),
      { horizonMinutes: observation.horizonMinutes, returnPct },
    ]);
  }

  return new Map(
    [...grouped.entries()].map(([decisionId, points]) => [
      decisionId,
      points.sort((left, right) => left.horizonMinutes - right.horizonMinutes),
    ]),
  );
}

function countByMint(decisions: readonly StrategyDecisionRecord[]): ReadonlyMap<string, number> {
  return countBy(decisions, (decision) => decision.mintAddress);
}

function countBy<T>(items: readonly T[], key: (item: T) => string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

function countClassifications(
  rows: readonly Pick<ShadowThresholdSourceRow, "classification">[],
): Readonly<Record<ShadowThresholdClassification, number>> {
  return Object.fromEntries(
    classifications.map((classification) => [
      classification,
      rows.filter((row) => row.classification === classification).length,
    ]),
  ) as Record<ShadowThresholdClassification, number>;
}

function raceFor(
  candidate: ShadowThresholdSelectedCandidate,
  maxHold: number,
  targetPct: number,
  stopPct: number,
): ShadowThresholdRaceOutcome | undefined {
  return candidate.outcomes
    .find((outcome) => outcome.maxHoldMinutes === maxHold)
    ?.races.find((race) => race.targetPct === targetPct && race.stopPct === stopPct)?.outcome;
}

function leaveOneOutStable(
  candidates: readonly ShadowThresholdSelectedCandidate[],
  mode: "run" | "mint",
  baselineDirection: boolean,
): boolean {
  const observed = candidates.filter(
    (candidate) => raceFor(candidate, 60, 10, 10) !== "NO_OBSERVATION",
  );
  const groups = new Set(
    observed.map((candidate) => (mode === "run" ? candidate.runLabel : candidate.mintAddress)),
  );

  if (groups.size < 2 || observed.length === 0) return false;

  return [...groups].every((excluded) => {
    const remaining = observed.filter(
      (candidate) => (mode === "run" ? candidate.runLabel : candidate.mintAddress) !== excluded,
    );
    const targetFirst = remaining.filter(
      (candidate) => raceFor(candidate, 60, 10, 10) === "TARGET_FIRST",
    ).length;
    const stopFirst = remaining.filter(
      (candidate) => raceFor(candidate, 60, 10, 10) === "STOP_FIRST",
    ).length;

    return remaining.length > 0 && targetFirst > stopFirst === baselineDirection;
  });
}

function attentionStrength(count: number): "NONE" | "LOW" | "MEDIUM" | "HIGH" {
  if (count >= 4) return "HIGH";
  if (count === 3) return "MEDIUM";
  if (count === 2) return "LOW";
  return "NONE";
}

function isInScoreBand(score: number): boolean {
  return score >= scoreMin && score <= scoreMax;
}

function average(values: readonly number[]): number {
  return sum(values) / values.length;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function maxShare(counts: ReadonlyMap<string, number>, total: number): number {
  return total === 0 ? 0 : percentage(Math.max(0, ...counts.values()), total);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
