import type {
  CounterfactualCandidateAnalysis,
  CounterfactualOutcome,
  CounterfactualScenarioId,
  CounterfactualScenarioSummary,
} from "./CounterfactualTypes.js";

const outcomes: readonly CounterfactualOutcome[] = [
  "UNCHANGED",
  "PROMOTED_TO_WATCH",
  "PROMOTED_TO_BUY",
  "DEMOTED_TO_SKIP",
  "BLOCKED_BY_ANOTHER_GATE",
  "NOT_EVALUABLE",
];

export function summarizeCounterfactualScenarios(input: {
  readonly analyses: readonly CounterfactualCandidateAnalysis[];
  readonly targetPcts: readonly number[];
  readonly stopPcts: readonly number[];
  readonly maxHoldMinutes: readonly number[];
}): readonly CounterfactualScenarioSummary[] {
  const groups = new Map<CounterfactualScenarioId, CounterfactualCandidateAnalysis[]>();

  for (const analysis of input.analyses) {
    for (const scenario of analysis.scenarios) {
      const entries = groups.get(scenario.scenarioId) ?? [];
      entries.push(analysis);
      groups.set(scenario.scenarioId, entries);
    }
  }

  return [...groups.entries()]
    .map(([scenarioId, entries]) => summarizeScenario(scenarioId, entries, input))
    .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
}

function summarizeScenario(
  scenarioId: CounterfactualScenarioId,
  entries: readonly CounterfactualCandidateAnalysis[],
  config: {
    readonly targetPcts: readonly number[];
    readonly stopPcts: readonly number[];
    readonly maxHoldMinutes: readonly number[];
  },
): CounterfactualScenarioSummary {
  const rows = entries
    .map((analysis) => ({
      analysis,
      scenario: analysis.scenarios.find((item) => item.scenarioId === scenarioId),
    }))
    .filter(
      (
        item,
      ): item is {
        analysis: CounterfactualCandidateAnalysis;
        scenario: NonNullable<typeof item.scenario>;
      } => item.scenario !== undefined,
    );
  const first = rows[0]?.scenario;
  const promotions = rows.filter(
    (item) =>
      item.scenario.outcome === "PROMOTED_TO_BUY" || item.scenario.outcome === "PROMOTED_TO_WATCH",
  );
  const observedPromotions = promotions.filter(
    (item) => item.analysis.candidate.observedPoints.length > 0,
  );
  const bestReturns = observedPromotions
    .map((item) => item.analysis.candidate.bestReturnPct)
    .filter((value): value is number => value !== undefined);
  const worstReturns = observedPromotions
    .map((item) => item.analysis.candidate.worstReturnPct)
    .filter((value): value is number => value !== undefined);
  const averagePromotedBestReturnPct = average(bestReturns);
  const averagePromotedWorstReturnPct = average(worstReturns);
  const scoreBucketCounts = countBy(promotions, (item) =>
    scoreBucket(item.analysis.candidate.score),
  );
  const targetFirstRates = ratesFor(promotions, config, "target");
  const drawdownFirstRates = ratesFor(promotions, config, "drawdown");
  const outcomeCounts = Object.fromEntries(outcomes.map((outcome) => [outcome, 0])) as Record<
    CounterfactualOutcome,
    number
  >;

  for (const row of rows) {
    outcomeCounts[row.scenario.outcome] += 1;
  }

  return {
    scenarioId: first?.scenarioId ?? scenarioId,
    scenarioLabel: first?.scenarioLabel ?? scenarioId,
    category: first?.category ?? "thresholds",
    evaluatedCount: rows.length,
    uniqueMintCount: new Set(rows.map((item) => item.analysis.candidate.mintAddress)).size,
    outcomeCounts,
    directEvidenceCount: rows.filter((item) => item.scenario.evidenceQuality === "DIRECT").length,
    gateOverrideEvidenceCount: rows.filter(
      (item) => item.scenario.evidenceQuality === "GATE_OVERRIDE",
    ).length,
    promotedToWatchCount: outcomeCounts.PROMOTED_TO_WATCH,
    promotedToBuyCount: outcomeCounts.PROMOTED_TO_BUY,
    observedPromotedCount: observedPromotions.length,
    scoreBucketCounts,
    targetFirstRates,
    drawdownFirstRates,
    maxMintPromotionSharePct: maxShare(promotions, (item) => item.analysis.candidate.mintAddress),
    maxRunPromotionSharePct: maxShare(promotions, (item) => item.analysis.candidate.runLabel),
    ...(averagePromotedBestReturnPct !== undefined ? { averagePromotedBestReturnPct } : {}),
    ...(averagePromotedWorstReturnPct !== undefined ? { averagePromotedWorstReturnPct } : {}),
  };
}

function average(values: readonly number[]): number | undefined {
  return values.length === 0
    ? undefined
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratesFor(
  promotions: readonly { readonly analysis: CounterfactualCandidateAnalysis }[],
  config: {
    readonly targetPcts: readonly number[];
    readonly stopPcts: readonly number[];
    readonly maxHoldMinutes: readonly number[];
  },
  kind: "target" | "drawdown",
): Readonly<Record<string, number>> {
  const maxHoldMinutes = Math.max(...config.maxHoldMinutes);
  const observed = promotions.filter((item) => item.analysis.candidate.observedPoints.length > 0);
  const rates: Record<string, number> = {};

  for (const targetPct of config.targetPcts) {
    const stopPct = config.stopPcts.includes(targetPct)
      ? targetPct
      : (config.stopPcts[0] as number);
    const matching = observed.filter((item) => {
      const ordering = targetStopOrdering(
        item.analysis.candidate.observedPoints,
        targetPct,
        stopPct,
        maxHoldMinutes,
      );

      return kind === "target" ? ordering === "TARGET_FIRST" : ordering === "STOP_FIRST";
    });

    rates[String(targetPct)] =
      observed.length === 0 ? 0 : (matching.length / observed.length) * 100;
  }

  return rates;
}

function targetStopOrdering(
  points: readonly { readonly horizonMinutes: number; readonly returnPct: number }[],
  targetPct: number,
  stopPct: number,
  maxHoldMinutes: number,
): "TARGET_FIRST" | "STOP_FIRST" | "NEITHER" | "AMBIGUOUS" {
  const withinHold = points.filter((point) => point.horizonMinutes <= maxHoldMinutes);
  const target = withinHold.find((point) => point.returnPct >= targetPct);
  const stop = withinHold.find((point) => point.returnPct <= -stopPct);

  if (!target && !stop) {
    return "NEITHER";
  }

  if (target && !stop) {
    return "TARGET_FIRST";
  }

  if (!target && stop) {
    return "STOP_FIRST";
  }

  if (target?.horizonMinutes === stop?.horizonMinutes) {
    return "AMBIGUOUS";
  }

  return (target?.horizonMinutes ?? Number.POSITIVE_INFINITY) <
    (stop?.horizonMinutes ?? Number.POSITIVE_INFINITY)
    ? "TARGET_FIRST"
    : "STOP_FIRST";
}

function countBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const item of items) {
    const name = key(item);
    counts[name] = (counts[name] ?? 0) + 1;
  }

  return counts;
}

function scoreBucket(score: number | null): string {
  if (score === null) {
    return "unknown";
  }

  const start = Math.floor(score / 5) * 5;

  return `${start}-${start + 4}`;
}

function maxShare<T>(items: readonly T[], key: (item: T) => string): number {
  if (items.length === 0) {
    return 0;
  }

  return (Math.max(...Object.values(countBy(items, key))) / items.length) * 100;
}
