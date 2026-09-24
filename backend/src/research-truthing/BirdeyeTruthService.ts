import type { ProviderHealthRecord, SystemLogRecord } from "../db/schema/index.js";
import { parseJson } from "../db/utils/json.js";
import type { ShadowCalibrationRawRun } from "../shadow-calibration/ShadowCalibrationTypes.js";
import type { ResearchInterpretationCandidate } from "../research-interpretation/ResearchInterpretationTypes.js";
import type {
  ResearchTruthingBirdeyeSummary,
  ResearchTruthingOutcomeSummary,
} from "./ResearchTruthingTypes.js";

export class BirdeyeTruthService {
  summarize(input: {
    readonly runs: readonly ShadowCalibrationRawRun[];
    readonly candidates: readonly ResearchInterpretationCandidate[];
  }): ResearchTruthingBirdeyeSummary {
    const birdeyeRows = input.runs.flatMap((run) =>
      run.providerHealth.filter((row) => row.provider.toUpperCase() === "BIRDEYE"),
    );
    const endpointCounts: Record<string, number> = {};
    const selectionReasonCounts: Record<string, number> = {};
    const cacheStatusCounts: Record<string, number> = {};
    const failureCounts: Record<string, number> = {};
    const estimatedCuByEndpoint: Record<string, number> = {};
    const reportedCumulativeCuByRun: Record<string, number> = {};
    let liveCalls = 0;
    let livePriceCalls = 0;
    let liveOverviewCalls = 0;
    let cacheHits = 0;
    let cachedPriceRows = 0;
    let cachedOverviewRows = 0;
    let budgetSkipCount = 0;
    let budgetSkippedPriceRows = 0;
    let budgetSkippedOverviewRows = 0;
    let providerFailureCount = 0;

    for (const run of input.runs) {
      for (const row of run.providerHealth.filter(
        (providerRow) => providerRow.provider.toUpperCase() === "BIRDEYE",
      )) {
        const context = readContext(row);
        const endpoint = readString(context.birdeyeEndpoint) ?? "UNKNOWN_ENDPOINT";
        const cacheStatus = readString(context.birdeyeCacheStatus) ?? "UNKNOWN_CACHE";
        const failure = readString(context.birdeyeFailureCategory) ?? "UNKNOWN_FAILURE";
        const selectionReason = readString(context.birdeyeSelectionReason) ?? "UNKNOWN_REASON";
        const cuCost = readNumber(context.birdeyeCuCost) ?? 0;
        const cumulativeCu = readNumber(context.birdeyeCuUsed);

        increment(endpointCounts, endpoint);
        increment(selectionReasonCounts, selectionReason);
        increment(cacheStatusCounts, cacheStatus);
        increment(failureCounts, failure);

        if (cacheStatus === "HIT") {
          cacheHits += 1;
          incrementEndpointCounter({
            endpoint,
            price: () => {
              cachedPriceRows += 1;
            },
            overview: () => {
              cachedOverviewRows += 1;
            },
          });
        } else if (failure !== "BIRDEYE_CU_BUDGET_EXHAUSTED") {
          liveCalls += 1;
          estimatedCuByEndpoint[endpoint] = (estimatedCuByEndpoint[endpoint] ?? 0) + cuCost;
          incrementEndpointCounter({
            endpoint,
            price: () => {
              livePriceCalls += 1;
            },
            overview: () => {
              liveOverviewCalls += 1;
            },
          });
        }

        if (failure === "BIRDEYE_CU_BUDGET_EXHAUSTED") {
          budgetSkipCount += 1;
          incrementEndpointCounter({
            endpoint,
            price: () => {
              budgetSkippedPriceRows += 1;
            },
            overview: () => {
              budgetSkippedOverviewRows += 1;
            },
          });
        } else if (failure !== "NONE" && row.status === "ERROR") {
          providerFailureCount += 1;
        }

        if (cumulativeCu !== undefined) {
          reportedCumulativeCuByRun[run.label] = Math.max(
            reportedCumulativeCuByRun[run.label] ?? 0,
            cumulativeCu,
          );
        }
      }
    }

    const enrichedMints = collectBirdeyeEnrichedMints(input.runs);
    const eligible = input.candidates.filter(isBirdeyeEligible);
    const enriched = input.candidates.filter((candidate) =>
      enrichedMints.has(candidate.mintAddress),
    );
    const eligibleControl = eligible.filter(
      (candidate) => !enrichedMints.has(candidate.mintAddress),
    );
    const notEligible = input.candidates.filter((candidate) => !isBirdeyeEligible(candidate));

    return {
      totalRows: birdeyeRows.length,
      liveCalls,
      livePriceCalls,
      liveOverviewCalls,
      cacheHits,
      cachedPriceRows,
      cachedOverviewRows,
      estimatedCuTotal: Object.values(estimatedCuByEndpoint).reduce(
        (total, value) => total + value,
        0,
      ),
      estimatedCuByEndpoint,
      reportedCumulativeCuByRun,
      endpointCounts,
      selectionReasonCounts,
      cacheStatusCounts,
      failureCounts,
      budgetSkipCount,
      budgetSkippedPriceRows,
      budgetSkippedOverviewRows,
      providerFailureCount,
      uniqueEnrichedMints: enrichedMints.size,
      enrichedCohort: summarizeOutcome("birdeye_enriched", enriched),
      eligibleControlCohort: summarizeOutcome("birdeye_eligible_not_enriched", eligibleControl),
      notEligibleCohort: summarizeOutcome("not_birdeye_eligible", notEligible),
      notes: buildNotes({
        enrichedMints: enrichedMints.size,
        budgetSkipCount,
        providerFailureCount,
      }),
    };
  }
}

function collectBirdeyeEnrichedMints(
  runs: readonly ShadowCalibrationRawRun[],
): ReadonlySet<string> {
  const mints = new Set<string>();

  for (const log of runs.flatMap((run) => run.systemLogs)) {
    if (!/Birdeye selective candidate/.test(log.message)) {
      continue;
    }

    const context = readLogContext(log);
    const mintAddress = readString(context.mintAddress);
    const priceOk = readBoolean(context.priceOk);
    const overviewOk = readBoolean(context.overviewOk);

    if (mintAddress && (priceOk || overviewOk)) {
      mints.add(mintAddress);
    }
  }

  return mints;
}

function isBirdeyeEligible(candidate: ResearchInterpretationCandidate): boolean {
  return (
    candidate.decision === "WATCH" ||
    (candidate.score ?? -1) >= 50 ||
    candidate.riskResult === "PASS" ||
    (candidate.missingQuote &&
      ((candidate.liquidityUsd ?? 0) >= 10_000 ||
        (candidate.volume1hUsd ?? 0) >= 50_000 ||
        (candidate.volume5mUsd ?? 0) >= 5_000))
  );
}

function summarizeOutcome(
  label: string,
  candidates: readonly ResearchInterpretationCandidate[],
): ResearchTruthingOutcomeSummary {
  const observed = candidates.filter((candidate) => candidate.observedPoints.length > 0);

  return {
    label,
    count: candidates.length,
    uniqueMints: new Set(candidates.map((candidate) => candidate.mintAddress)).size,
    observedCount: observed.length,
    observedCoveragePct: percent(observed.length, candidates.length),
    outcomeComparisonStatus: outcomeComparisonStatus(observed.length, candidates.length),
    ...optionalAverage(
      "averageScore",
      candidates.map((candidate) => candidate.score),
    ),
    ...optionalAverage(
      "averageBestReturnPct",
      observed.map((candidate) => candidate.bestReturnPct),
    ),
    ...optionalAverage(
      "averageWorstReturnPct",
      observed.map((candidate) => candidate.worstReturnPct),
    ),
  };
}

function buildNotes(input: {
  readonly enrichedMints: number;
  readonly budgetSkipCount: number;
  readonly providerFailureCount: number;
}): readonly string[] {
  const notes: string[] = [];

  if (input.budgetSkipCount > 0) {
    notes.push(
      `${input.budgetSkipCount} Birdeye rows were budget guardrail skips and should not be interpreted as external provider outages.`,
    );
  }

  if (input.enrichedMints === 0) {
    notes.push(
      "No successful Birdeye-enriched mint could be recovered from archived system logs; candidate-level enrichment attribution is incomplete.",
    );
  }

  if (input.providerFailureCount === 0) {
    notes.push("No non-budget Birdeye provider failures were observed in the truthing input.");
  }

  return notes;
}

function incrementEndpointCounter(input: {
  readonly endpoint: string;
  readonly price: () => void;
  readonly overview: () => void;
}): void {
  if (input.endpoint === "/defi/price") {
    input.price();
  }

  if (input.endpoint === "/defi/token_overview") {
    input.overview();
  }
}

function outcomeComparisonStatus(
  observedCount: number,
  candidateCount: number,
): ResearchTruthingOutcomeSummary["outcomeComparisonStatus"] {
  if (observedCount < 5) {
    return "NOT_COMPARABLE";
  }

  return percent(observedCount, candidateCount) < 20 ? "LOW_COVERAGE" : "SUFFICIENT";
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function readContext(row: ProviderHealthRecord): Readonly<Record<string, unknown>> {
  if (!row.contextJson) {
    return {};
  }

  try {
    const parsed = parseJson<unknown>(row.contextJson);

    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readLogContext(row: SystemLogRecord): Readonly<Record<string, unknown>> {
  if (!row.contextJson) {
    return {};
  }

  try {
    const parsed = parseJson<unknown>(row.contextJson);

    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function optionalAverage<Key extends string>(
  key: Key,
  values: readonly (number | null | undefined)[],
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
