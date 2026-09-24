import type { ResearchInterpretationCandidate } from "../research-interpretation/ResearchInterpretationTypes.js";
import type {
  ResearchTruthingConcentrationRow,
  ResearchTruthingConcentrationSummary,
  ResearchTruthingLeaveOneOutRow,
} from "./ResearchTruthingTypes.js";

export class ConcentrationTruthService {
  summarize(input: {
    readonly candidates: readonly ResearchInterpretationCandidate[];
    readonly limit: number;
  }): ResearchTruthingConcentrationSummary {
    const observedCount = countObserved(input.candidates);
    const targetFirstWins = countTargetFirst(input.candidates);
    const totalRunGroups = new Set(input.candidates.map((candidate) => candidate.runLabel)).size;
    const totalMintGroups = new Set(input.candidates.map((candidate) => candidate.mintAddress))
      .size;
    const byRun = summarizeGroups({
      candidates: input.candidates,
      observedCount,
      targetFirstWins,
      getKey: (candidate) => candidate.runLabel,
      limit: input.limit,
    });
    const byMint = summarizeGroups({
      candidates: input.candidates,
      observedCount,
      targetFirstWins,
      getKey: (candidate) => candidate.mintAddress,
      getLabel: (candidate) => candidate.symbol,
      limit: input.limit,
    });

    return {
      totalRunGroups,
      totalMintGroups,
      byRun,
      byMint,
      leaveOneRunOut: buildLeaveOneOut(input.candidates, (candidate) => candidate.runLabel),
      leaveOneMintOut: [...buildLeaveOneOut(input.candidates, (candidate) => candidate.mintAddress)]
        .sort(
          (left: ResearchTruthingLeaveOneOutRow, right: ResearchTruthingLeaveOneOutRow) =>
            input.candidates.filter((candidate) => candidate.mintAddress === right.omittedKey)
              .length -
            input.candidates.filter((candidate) => candidate.mintAddress === left.omittedKey)
              .length,
        )
        .slice(0, input.limit),
      notes: buildNotes(byRun, byMint),
    };
  }
}

function summarizeGroups(input: {
  readonly candidates: readonly ResearchInterpretationCandidate[];
  readonly observedCount: number;
  readonly targetFirstWins: number;
  readonly getKey: (candidate: ResearchInterpretationCandidate) => string;
  readonly getLabel?: (candidate: ResearchInterpretationCandidate) => string | undefined;
  readonly limit: number;
}): readonly ResearchTruthingConcentrationRow[] {
  return [...groupBy(input.candidates, input.getKey).entries()]
    .map(([key, candidates]) => {
      const targetFirst = countTargetFirst(candidates);
      const first = candidates[0];
      const label = first ? input.getLabel?.(first) : undefined;

      return {
        key,
        ...(label ? { label } : {}),
        decisionCount: candidates.length,
        observedCount: countObserved(candidates),
        targetFirstWins: targetFirst,
        shareOfObservedPct: percent(countObserved(candidates), input.observedCount),
        shareOfTargetFirstWinsPct: percent(targetFirst, input.targetFirstWins),
        ...optionalAverage(
          "averageBestReturnPct",
          candidates.map((candidate) => candidate.bestReturnPct),
        ),
        ...optionalAverage(
          "averageWorstReturnPct",
          candidates.map((candidate) => candidate.worstReturnPct),
        ),
      };
    })
    .sort(
      (left, right) =>
        right.shareOfTargetFirstWinsPct - left.shareOfTargetFirstWinsPct ||
        right.observedCount - left.observedCount ||
        left.key.localeCompare(right.key),
    )
    .slice(0, input.limit);
}

function buildLeaveOneOut(
  candidates: readonly ResearchInterpretationCandidate[],
  getKey: (candidate: ResearchInterpretationCandidate) => string,
): readonly ResearchTruthingLeaveOneOutRow[] {
  return [...new Set(candidates.map(getKey))]
    .map((key) => {
      const remaining = candidates.filter((candidate) => getKey(candidate) !== key);
      const omitted = candidates.find((candidate) => getKey(candidate) === key);
      const omittedLabel = omitted?.symbol;

      return {
        omittedKey: key,
        ...(omittedLabel ? { omittedLabel } : {}),
        remainingDecisionCount: remaining.length,
        remainingUniqueMints: new Set(remaining.map((candidate) => candidate.mintAddress)).size,
        remainingObservedCount: countObserved(remaining),
        ...optionalAverage(
          "averageBestReturnPct",
          remaining.map((candidate) => candidate.bestReturnPct),
        ),
        ...optionalAverage(
          "averageWorstReturnPct",
          remaining.map((candidate) => candidate.worstReturnPct),
        ),
        quoteMissingPct: percent(
          remaining.filter((candidate) => candidate.missingQuote).length,
          remaining.length,
        ),
        targetFirstWins: countTargetFirst(remaining),
      };
    })
    .sort((left, right) => left.omittedKey.localeCompare(right.omittedKey));
}

function buildNotes(
  byRun: readonly ResearchTruthingConcentrationRow[],
  byMint: readonly ResearchTruthingConcentrationRow[],
): readonly string[] {
  const notes: string[] = [];
  const dominantRun = byRun[0];
  const dominantMint = byMint[0];

  if (dominantRun && dominantRun.shareOfTargetFirstWinsPct > 40) {
    notes.push(
      `Dominant run ${dominantRun.key} accounts for ${formatNumber(
        dominantRun.shareOfTargetFirstWinsPct,
      )}% of target-first wins.`,
    );
  }

  if (dominantMint && dominantMint.shareOfTargetFirstWinsPct > 40) {
    notes.push(
      `Dominant mint ${dominantMint.label ?? dominantMint.key} accounts for ${formatNumber(
        dominantMint.shareOfTargetFirstWinsPct,
      )}% of target-first wins.`,
    );
  }

  return notes;
}

function countObserved(candidates: readonly ResearchInterpretationCandidate[]): number {
  return candidates.filter((candidate) => candidate.observedPoints.length > 0).length;
}

function countTargetFirst(candidates: readonly ResearchInterpretationCandidate[]): number {
  return candidates.filter((candidate) =>
    candidate.targetStopOutcomes.some((outcome) => outcome.ordering === "TARGET_FIRST"),
  ).length;
}

function groupBy<T>(items: readonly T[], getKey: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = getKey(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return groups;
}

function optionalAverage<Key extends string>(
  key: Key,
  values: readonly (number | undefined)[],
): Record<Key, number> | Record<string, never> {
  const numericValues = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );

  if (numericValues.length === 0) {
    return {};
  }

  return {
    [key]: numericValues.reduce((total, value) => total + value, 0) / numericValues.length,
  } as Record<Key, number>;
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toString()
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
