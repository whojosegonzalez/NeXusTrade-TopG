import { ScoreAttributionService } from "../calibration/ScoreAttributionService.js";
import type { ReturnPoint } from "../calibration/CalibrationTypes.js";
import { defaultShadowCalibrationConfig } from "../shadow-calibration/ShadowCalibrationConfig.js";
import { loadShadowCalibrationRuns } from "../shadow-calibration/ShadowRunLoader.js";
import type { LoadedShadowCalibrationRuns } from "../shadow-calibration/ShadowRunLoader.js";
import type { ShadowCalibrationRawRun } from "../shadow-calibration/ShadowCalibrationTypes.js";
import type { ShadowEntryRuntimeConfig } from "./ShadowEntryConfig.js";
import type { ShadowEntryCandidate } from "./ShadowEntryTypes.js";

export interface LoadedShadowEntryRuns {
  readonly runs: readonly ShadowCalibrationRawRun[];
  readonly candidates: readonly ShadowEntryCandidate[];
  readonly close: () => void;
}

export function loadShadowEntryRuns(config: ShadowEntryRuntimeConfig): LoadedShadowEntryRuns {
  const calibrationConfig = {
    ...defaultShadowCalibrationConfig(),
    dbSources: config.dbSources,
    sourceDecisions: config.sourceDecisions,
    minScore: config.minScore,
    targetPcts: config.targetPcts,
    stopPcts: config.stopPcts,
    maxHoldMinutes: config.maxHoldMinutes,
    ...(config.sessionId ? { sessionId: config.sessionId } : {}),
  };
  const loaded = loadShadowCalibrationRuns({
    ...calibrationConfig,
  });

  try {
    return {
      runs: loaded.runs,
      candidates: loadCandidates(loaded.runs, config),
      close: loaded.close,
    };
  } catch (error) {
    loaded.close();
    throw error;
  }
}

export function loadCandidates(
  runs: readonly ShadowCalibrationRawRun[],
  config: ShadowEntryRuntimeConfig,
): readonly ShadowEntryCandidate[] {
  const attributionService = new ScoreAttributionService();
  const candidates: ShadowEntryCandidate[] = [];

  for (const run of runs) {
    if (run.sourceKind !== "database") {
      continue;
    }

    const observationsByDecisionId = groupBy(
      run.watchlistReturns,
      (observation) => observation.strategyDecisionId,
    );
    const repeatedMints = findRepeatedMints(
      run.strategyDecisions.map((decision) => ({
        mintAddress: decision.mintAddress,
        decisionId: decision.id,
      })),
    );
    const attentionStatsByMint = buildAttentionStatsByMint(
      run.strategyDecisions.map((decision) => ({
        mintAddress: decision.mintAddress,
        decidedAtMs: decision.decidedAtMs,
      })),
    );

    for (const decision of run.strategyDecisions) {
      if (!config.sourceDecisions.includes(decision.decision)) {
        continue;
      }

      if ((decision.score ?? -1) < config.minScore) {
        continue;
      }

      const attribution = attributionService.explain(decision);
      const observedPoints = toReturnPoints(observationsByDecisionId.get(decision.id) ?? []);
      const bestPoint = [...observedPoints].sort(
        (left, right) => right.returnPct - left.returnPct,
      )[0];
      const worstPoint = [...observedPoints].sort(
        (left, right) => left.returnPct - right.returnPct,
      )[0];
      const repeatedAttention = describeRepeatedAttention({
        duplicateBuyBlocked: attribution.duplicateBuyBlocked,
        stats: attentionStatsByMint.get(decision.mintAddress) ?? {
          sourceCount: 1,
          firstAttentionAtMs: decision.decidedAtMs,
          lastAttentionAtMs: decision.decidedAtMs,
        },
      });

      candidates.push({
        runLabel: run.label,
        ...(run.session ? { sessionId: run.session.id } : {}),
        decisionId: decision.id,
        mintAddress: decision.mintAddress,
        decidedAtMs: decision.decidedAtMs,
        decision: decision.decision,
        score: decision.score,
        ...(attribution.symbol ? { symbol: attribution.symbol } : {}),
        attribution,
        observedPoints,
        ...(bestPoint ? { bestReturnPct: bestPoint.returnPct } : {}),
        ...(worstPoint ? { worstReturnPct: worstPoint.returnPct } : {}),
        duplicateBuyBlocked: attribution.duplicateBuyBlocked,
        repeatedMintDecision: repeatedMints.has(decision.mintAddress),
        repeatedAttentionStrength: repeatedAttention.repeatedAttentionStrength,
        repeatedAttentionReasons: repeatedAttention.repeatedAttentionReasons,
        repeatedAttentionSourceCount: repeatedAttention.repeatedAttentionSourceCount,
        ...(repeatedAttention.firstAttentionAtMs !== undefined
          ? { firstAttentionAtMs: repeatedAttention.firstAttentionAtMs }
          : {}),
        ...(repeatedAttention.lastAttentionAtMs !== undefined
          ? { lastAttentionAtMs: repeatedAttention.lastAttentionAtMs }
          : {}),
        ...(repeatedAttention.timeBetweenAttentionSignalsMinutes !== undefined
          ? {
              timeBetweenAttentionSignalsMinutes:
                repeatedAttention.timeBetweenAttentionSignalsMinutes,
            }
          : {}),
        missingQuote: attribution.missingQuote,
      });
    }
  }

  return candidates.sort((left, right) => left.decidedAtMs - right.decidedAtMs);
}

function toReturnPoints(
  observations: NonNullable<LoadedShadowCalibrationRuns["runs"][number]["watchlistReturns"]>,
): readonly ReturnPoint[] {
  return observations
    .filter((observation) => observation.status === "OBSERVED")
    .map((observation) => {
      const returnPct = Number(observation.returnPctSol ?? observation.returnPctUsd);

      return Number.isFinite(returnPct)
        ? {
            horizonMinutes: observation.horizonMinutes,
            returnPct,
          }
        : undefined;
    })
    .filter((point): point is ReturnPoint => point !== undefined)
    .sort((left, right) => left.horizonMinutes - right.horizonMinutes);
}

function describeRepeatedAttention(input: {
  readonly duplicateBuyBlocked: boolean;
  readonly stats: {
    readonly sourceCount: number;
    readonly firstAttentionAtMs: number;
    readonly lastAttentionAtMs: number;
  };
}): Pick<
  ShadowEntryCandidate,
  | "repeatedAttentionStrength"
  | "repeatedAttentionReasons"
  | "repeatedAttentionSourceCount"
  | "firstAttentionAtMs"
  | "lastAttentionAtMs"
  | "timeBetweenAttentionSignalsMinutes"
> {
  const reasons: string[] = [];
  const timeBetweenAttentionSignalsMinutes =
    input.stats.sourceCount > 1
      ? (input.stats.lastAttentionAtMs - input.stats.firstAttentionAtMs) / 60_000
      : undefined;

  if (input.duplicateBuyBlocked) {
    reasons.push("duplicate BUY prevention");
  }

  if (input.stats.sourceCount > 1) {
    reasons.push(`repeated strategy decisions=${input.stats.sourceCount}`);
  }

  if (input.duplicateBuyBlocked || input.stats.sourceCount >= 3) {
    return {
      repeatedAttentionStrength: "HIGH",
      repeatedAttentionReasons: reasons,
      repeatedAttentionSourceCount: input.stats.sourceCount,
      firstAttentionAtMs: input.stats.firstAttentionAtMs,
      lastAttentionAtMs: input.stats.lastAttentionAtMs,
      ...(timeBetweenAttentionSignalsMinutes !== undefined
        ? { timeBetweenAttentionSignalsMinutes }
        : {}),
    };
  }

  if (input.stats.sourceCount === 2) {
    return {
      repeatedAttentionStrength: "MEDIUM",
      repeatedAttentionReasons: reasons,
      repeatedAttentionSourceCount: input.stats.sourceCount,
      firstAttentionAtMs: input.stats.firstAttentionAtMs,
      lastAttentionAtMs: input.stats.lastAttentionAtMs,
      ...(timeBetweenAttentionSignalsMinutes !== undefined
        ? { timeBetweenAttentionSignalsMinutes }
        : {}),
    };
  }

  return {
    repeatedAttentionStrength: "NONE",
    repeatedAttentionReasons: [],
    repeatedAttentionSourceCount: input.stats.sourceCount,
    firstAttentionAtMs: input.stats.firstAttentionAtMs,
    lastAttentionAtMs: input.stats.lastAttentionAtMs,
  };
}

function findRepeatedMints(
  decisions: readonly { readonly mintAddress: string; readonly decisionId: string }[],
): ReadonlySet<string> {
  const counts = new Map<string, number>();

  for (const decision of decisions) {
    counts.set(decision.mintAddress, (counts.get(decision.mintAddress) ?? 0) + 1);
  }

  return new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([mintAddress]) => mintAddress),
  );
}

function buildAttentionStatsByMint(
  decisions: readonly { readonly mintAddress: string; readonly decidedAtMs: number }[],
): ReadonlyMap<
  string,
  {
    readonly sourceCount: number;
    readonly firstAttentionAtMs: number;
    readonly lastAttentionAtMs: number;
  }
> {
  const stats = new Map<
    string,
    {
      sourceCount: number;
      firstAttentionAtMs: number;
      lastAttentionAtMs: number;
    }
  >();

  for (const decision of decisions) {
    const existing = stats.get(decision.mintAddress);

    if (existing) {
      existing.sourceCount += 1;
      existing.firstAttentionAtMs = Math.min(existing.firstAttentionAtMs, decision.decidedAtMs);
      existing.lastAttentionAtMs = Math.max(existing.lastAttentionAtMs, decision.decidedAtMs);
    } else {
      stats.set(decision.mintAddress, {
        sourceCount: 1,
        firstAttentionAtMs: decision.decidedAtMs,
        lastAttentionAtMs: decision.decidedAtMs,
      });
    }
  }

  return stats;
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
