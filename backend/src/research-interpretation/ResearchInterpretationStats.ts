import type { StrategyDecision } from "../db/schema/index.js";
import type {
  ResearchGroupedOutcomeSummary,
  ResearchInterpretationCandidate,
  ResearchInterpretationTargetStopOutcome,
} from "./ResearchInterpretationTypes.js";

export function buildTargetStopOutcomes(input: {
  readonly observedPoints: ResearchInterpretationCandidate["observedPoints"];
  readonly targetPcts: readonly number[];
  readonly stopPcts: readonly number[];
  readonly maxHoldMinutes: readonly number[];
}): readonly ResearchInterpretationTargetStopOutcome[] {
  const outcomes: ResearchInterpretationTargetStopOutcome[] = [];
  const maxHold = Math.max(...input.maxHoldMinutes);
  const observedPoints = input.observedPoints.filter((point) => point.horizonMinutes <= maxHold);

  for (const targetPct of input.targetPcts) {
    for (const stopPct of input.stopPcts) {
      const targetPoint = observedPoints.find((point) => point.returnPct >= targetPct);
      const stopPoint = observedPoints.find((point) => point.returnPct <= -stopPct);

      if (!targetPoint && !stopPoint) {
        outcomes.push({
          targetPct,
          stopPct,
          ordering: "NEITHER",
        });
        continue;
      }

      if (targetPoint && !stopPoint) {
        outcomes.push({
          targetPct,
          stopPct,
          ordering: "TARGET_FIRST",
          targetHorizonMinutes: targetPoint.horizonMinutes,
        });
        continue;
      }

      if (!targetPoint && stopPoint) {
        outcomes.push({
          targetPct,
          stopPct,
          ordering: "STOP_FIRST",
          stopHorizonMinutes: stopPoint.horizonMinutes,
        });
        continue;
      }

      if (targetPoint && stopPoint && targetPoint.horizonMinutes < stopPoint.horizonMinutes) {
        outcomes.push({
          targetPct,
          stopPct,
          ordering: "TARGET_FIRST",
          targetHorizonMinutes: targetPoint.horizonMinutes,
          stopHorizonMinutes: stopPoint.horizonMinutes,
        });
        continue;
      }

      if (targetPoint && stopPoint && stopPoint.horizonMinutes < targetPoint.horizonMinutes) {
        outcomes.push({
          targetPct,
          stopPct,
          ordering: "STOP_FIRST",
          targetHorizonMinutes: targetPoint.horizonMinutes,
          stopHorizonMinutes: stopPoint.horizonMinutes,
        });
        continue;
      }

      outcomes.push({
        targetPct,
        stopPct,
        ordering: "AMBIGUOUS",
        ...(targetPoint ? { targetHorizonMinutes: targetPoint.horizonMinutes } : {}),
        ...(stopPoint ? { stopHorizonMinutes: stopPoint.horizonMinutes } : {}),
      });
    }
  }

  return outcomes;
}

export function summarizeCandidateGroup(
  label: string,
  candidates: readonly ResearchInterpretationCandidate[],
  targetPcts: readonly number[],
  stopPcts: readonly number[],
): ResearchGroupedOutcomeSummary {
  const observedCandidates = candidates.filter((candidate) => candidate.observedPoints.length > 0);
  const scores = candidates
    .map((candidate) => candidate.score)
    .filter((score): score is number => score !== null);

  return {
    label,
    count: candidates.length,
    uniqueMints: uniqueCount(candidates.map((candidate) => candidate.mintAddress)),
    observedCount: observedCandidates.length,
    ...(scores.length > 0 ? { averageScore: average(scores) } : {}),
    ...optionalAverage(
      "averageBestReturnPct",
      observedCandidates.map((candidate) => candidate.bestReturnPct),
    ),
    ...optionalAverage(
      "averageWorstReturnPct",
      observedCandidates.map((candidate) => candidate.worstReturnPct),
    ),
    targetHitRates: Object.fromEntries(
      targetPcts.map((targetPct) => [
        targetPct.toString(),
        percent(
          observedCandidates.filter((candidate) =>
            candidate.targetStopOutcomes.some(
              (outcome) => outcome.targetPct === targetPct && outcome.ordering === "TARGET_FIRST",
            ),
          ).length,
          observedCandidates.length,
        ),
      ]),
    ),
    drawdownFirstRates: Object.fromEntries(
      stopPcts.map((stopPct) => [
        stopPct.toString(),
        percent(
          observedCandidates.filter((candidate) =>
            candidate.targetStopOutcomes.some(
              (outcome) => outcome.stopPct === stopPct && outcome.ordering === "STOP_FIRST",
            ),
          ).length,
          observedCandidates.length,
        ),
      ]),
    ),
    exampleMints: [...new Set(candidates.map((candidate) => candidate.mintAddress))].slice(0, 5),
  };
}

export function countByDecision(
  candidates: readonly ResearchInterpretationCandidate[],
): Readonly<Record<string, number>> {
  const counts = new Map<StrategyDecision, number>();

  for (const candidate of candidates) {
    counts.set(candidate.decision, (counts.get(candidate.decision) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

export function uniqueCount(values: readonly string[]): number {
  return new Set(values).size;
}

function optionalAverage<Key extends string>(
  key: Key,
  values: readonly (number | undefined)[],
): Partial<Record<Key, number>> {
  const numericValues = values.filter((value): value is number => value !== undefined);

  return numericValues.length > 0
    ? ({ [key]: average(numericValues) } as Partial<Record<Key, number>>)
    : {};
}
