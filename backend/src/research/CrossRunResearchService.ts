import type { ReturnPoint } from "../calibration/CalibrationTypes.js";
import type { ShadowCalibrationRunSummary } from "../shadow-calibration/ShadowCalibrationTypes.js";
import type { ShadowEntryCandidate } from "../shadow-entry/ShadowEntryTypes.js";
import type {
  ProviderPressureProviderSummary,
  ProviderPressureSummary,
  TerminalRunSummary,
} from "../terminal-runner/TerminalRunSummary.js";
import { mergeProviderPressureSummaries } from "../terminal-runner/TerminalRunSummary.js";
import type {
  ResearchAggregateServiceInput,
  ResearchConcentrationSummary,
  ResearchCrossRunSummary,
  ResearchProviderPressureSummary,
  ResearchQuoteBudgetSummary,
  ResearchRunValidation,
  ResearchThresholdComparison,
  ResearchThresholdRunSummary,
} from "./ResearchAggregateTypes.js";

type TargetStopOrdering = "TARGET_FIRST" | "STOP_FIRST" | "AMBIGUOUS" | "NEITHER";

export class CrossRunResearchService {
  generate(input: ResearchAggregateServiceInput): {
    readonly runValidations: readonly ResearchRunValidation[];
    readonly crossRun: ResearchCrossRunSummary;
  } {
    const runValidations = this.buildRunValidations(input);

    return {
      runValidations,
      crossRun: {
        runCount: input.archives.length,
        validRunCount: runValidations.filter((run) => run.validForPromotion).length,
        observedDecisionCount: input.shadowEntries.aggregate.observedDecisionCount,
        uniqueMintCount: input.shadowEntries.aggregate.uniqueMintCount,
        orderCount: input.shadowEntries.aggregate.orderCount,
        fillCount: input.shadowEntries.aggregate.fillCount,
        positionCount: input.shadowEntries.aggregate.positionCount,
        thresholdComparisons: input.config.thresholdProfiles.map((profile) =>
          this.buildThresholdComparison(input.candidates, profile, input),
        ),
        providerPressure: buildProviderPressure(
          input.archives.map((archive) => archive.terminalSummary),
        ),
        quoteBudget: buildQuoteBudget(input.archives.map((archive) => archive.terminalSummary)),
        concentration: buildConcentration(
          input.candidates,
          input.config.targetPcts[0] ?? 10,
          input.config.stopPcts[0] ?? 10,
        ),
      },
    };
  }

  private buildRunValidations(
    input: ResearchAggregateServiceInput,
  ): readonly ResearchRunValidation[] {
    const shadowRunsByLabel = new Map(
      input.shadowCalibration.runs.map((run) => [run.label, run] as const),
    );

    return input.archives.map((archive) => {
      const shadowRun = shadowRunsByLabel.get(archive.label);
      const terminalSessionId = archive.terminalSummary.sessionId;
      const uniqueStageSessionIds = collectStageSessionIds(archive.terminalSummary);
      const oneSession =
        terminalSessionId !== undefined &&
        uniqueStageSessionIds.length > 0 &&
        uniqueStageSessionIds.every((sessionId) => sessionId === terminalSessionId);
      const warnings = [
        ...archive.warnings,
        ...buildValidationWarnings({
          terminalSummary: archive.terminalSummary,
          shadowRun,
          terminalSessionId,
          uniqueStageSessionIds,
          oneSession,
        }),
      ];
      const validForPromotion =
        archive.terminalSummary.safetyStatus === "PASS" &&
        oneSession &&
        shadowRun !== undefined &&
        shadowRun.mechanicallyValid &&
        shadowRun.sessionId === terminalSessionId;

      return {
        label: archive.label,
        runId: archive.terminalSummary.runId,
        databasePath: archive.databasePath,
        ...(terminalSessionId ? { terminalSessionId } : {}),
        ...(shadowRun?.sessionId ? { databaseSessionId: shadowRun.sessionId } : {}),
        safetyStatus: archive.terminalSummary.safetyStatus,
        cycleCount: archive.terminalSummary.cycleCount,
        oneSession,
        uniqueStageSessionIds,
        scannerStoredCount: sumStageCount(archive.terminalSummary, "scanner", "stored"),
        strategyWrittenCount: sumStageCount(archive.terminalSummary, "strategy", "written"),
        validForPromotion,
        warnings,
      };
    });
  }

  private buildThresholdComparison(
    candidates: readonly ShadowEntryCandidate[],
    profile: ResearchThresholdComparisonProfile,
    input: ResearchAggregateServiceInput,
  ): ResearchThresholdComparison {
    const buys = candidates.filter((candidate) => isSimulatedBuy(candidate, profile));
    const observedBuys = buys.filter((candidate) => candidate.observedPoints.length > 0);
    const byRun = input.archives.map((archive) =>
      buildThresholdRunSummary(
        archive.label,
        observedBuys.filter((candidate) => candidate.runLabel === archive.label),
        input.config.targetPcts,
        input.config.stopPcts,
      ),
    );

    return {
      profileId: profile.id,
      profileVersion: profile.version,
      label: profile.label,
      buyScoreThreshold: profile.buyScoreThreshold,
      watchScoreThreshold: profile.watchScoreThreshold,
      simulatedBuyCount: buys.length,
      observedBuyCount: observedBuys.length,
      uniqueBuyMints: uniqueCount(observedBuys.map((candidate) => candidate.mintAddress)),
      ...buildReturnMetrics(observedBuys, input.config.targetPcts, input.config.stopPcts),
      byRun,
    };
  }
}

function buildQuoteBudget(summaries: readonly TerminalRunSummary[]): ResearchQuoteBudgetSummary {
  let riskCycleCount = 0;
  let plannerEnabledCycleCount = 0;
  let selectedCount = 0;
  let notSelectedCount = 0;

  for (const summary of summaries) {
    for (const cycle of summary.cycles) {
      const risk = cycle.stages.find((stage) => stage.name === "risk");

      if (!risk) {
        continue;
      }

      riskCycleCount += 1;
      if (risk.counts.quoteBudgetEnabled === true) {
        plannerEnabledCycleCount += 1;
      }
      selectedCount += readNumericStageCount(risk.counts.quoteBudgetSelected);
      notSelectedCount += readNumericStageCount(risk.counts.quoteBudgetNotSelected);
    }
  }

  return {
    riskCycleCount,
    plannerEnabledCycleCount,
    selectedCount,
    notSelectedCount,
    skippedLiveCallsEstimate: notSelectedCount,
  };
}

function readNumericStageCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type ResearchThresholdComparisonProfile =
  ResearchAggregateServiceInput["config"]["thresholdProfiles"][number];

function buildValidationWarnings(input: {
  readonly terminalSummary: TerminalRunSummary;
  readonly shadowRun: ShadowCalibrationRunSummary | undefined;
  readonly terminalSessionId: string | undefined;
  readonly uniqueStageSessionIds: readonly string[];
  readonly oneSession: boolean;
}): readonly string[] {
  const warnings: string[] = [];

  if (input.terminalSummary.safetyStatus !== "PASS") {
    warnings.push(`TerminalRunner safety status is ${input.terminalSummary.safetyStatus}.`);
  }

  if (!input.terminalSessionId) {
    warnings.push("TerminalRunner JSON has no top-level sessionId; likely a pre-patch run.");
  }

  if (!input.oneSession) {
    warnings.push(
      `TerminalRunner stages were not all tied to one session (${input.uniqueStageSessionIds.join(
        ", ",
      )}).`,
    );
  }

  if (!input.shadowRun) {
    warnings.push("Archived DB did not produce a matching shadow calibration run summary.");
  } else {
    if (!input.shadowRun.mechanicallyValid) {
      warnings.push(
        `Archived DB contains paper execution rows: orders=${input.shadowRun.orderCount} fills=${input.shadowRun.fillCount} positions=${input.shadowRun.positionCount}.`,
      );
    }

    if (input.terminalSessionId && input.shadowRun.sessionId !== input.terminalSessionId) {
      warnings.push(
        `Terminal session ${input.terminalSessionId} does not match DB session ${
          input.shadowRun.sessionId ?? "n/a"
        }.`,
      );
    }
  }

  return warnings;
}

function collectStageSessionIds(summary: TerminalRunSummary): readonly string[] {
  const sessionIds = new Set<string>();

  for (const cycle of summary.cycles) {
    for (const stage of cycle.stages) {
      const sessionId = stage.counts.sessionId;

      if (typeof sessionId === "string" && sessionId.length > 0) {
        sessionIds.add(sessionId);
      }
    }
  }

  return [...sessionIds].sort((left, right) => left.localeCompare(right));
}

function sumStageCount(summary: TerminalRunSummary, stageName: string, countName: string): number {
  let total = 0;

  for (const cycle of summary.cycles) {
    for (const stage of cycle.stages) {
      if (stage.name !== stageName) {
        continue;
      }

      const value = stage.counts[countName];

      if (typeof value === "number" && Number.isFinite(value)) {
        total += value;
      }
    }
  }

  return total;
}

function buildThresholdRunSummary(
  label: string,
  observedBuys: readonly ShadowEntryCandidate[],
  targetPcts: readonly number[],
  stopPcts: readonly number[],
): ResearchThresholdRunSummary {
  return {
    label,
    observedBuyCount: observedBuys.length,
    uniqueBuyMints: uniqueCount(observedBuys.map((candidate) => candidate.mintAddress)),
    ...buildReturnMetrics(observedBuys, targetPcts, stopPcts),
  };
}

function buildReturnMetrics(
  candidates: readonly ShadowEntryCandidate[],
  targetPcts: readonly number[],
  stopPcts: readonly number[],
): Pick<
  ResearchThresholdComparison,
  "averageBestReturnPct" | "averageWorstReturnPct" | "targetHitRates" | "drawdownFirstRates"
> {
  const bestReturns = candidates
    .map((candidate) => candidate.bestReturnPct)
    .filter((value): value is number => value !== undefined);
  const worstReturns = candidates
    .map((candidate) => candidate.worstReturnPct)
    .filter((value): value is number => value !== undefined);

  return {
    ...(bestReturns.length > 0 ? { averageBestReturnPct: average(bestReturns) } : {}),
    ...(worstReturns.length > 0 ? { averageWorstReturnPct: average(worstReturns) } : {}),
    targetHitRates: Object.fromEntries(
      targetPcts.map((targetPct) => [
        `${targetPct}`,
        percentage(
          candidates.filter(
            (candidate) => (candidate.bestReturnPct ?? Number.NEGATIVE_INFINITY) >= targetPct,
          ).length,
          candidates.length,
        ),
      ]),
    ),
    drawdownFirstRates: Object.fromEntries(
      stopPcts.map((stopPct) => [
        `${stopPct}`,
        percentage(
          candidates.filter(
            (candidate) =>
              targetStopOrdering(candidate.observedPoints, stopPct, stopPct) === "STOP_FIRST",
          ).length,
          candidates.length,
        ),
      ]),
    ),
  };
}

function isSimulatedBuy(
  candidate: ShadowEntryCandidate,
  profile: ResearchThresholdComparisonProfile,
): boolean {
  const score = candidate.score ?? -1;

  return (
    score >= profile.buyScoreThreshold &&
    candidate.attribution.buyEligible &&
    !candidate.attribution.duplicateBuyBlocked &&
    !candidate.attribution.maxBuyCapBlocked
  );
}

function buildProviderPressure(
  summaries: readonly TerminalRunSummary[],
): readonly ResearchProviderPressureSummary[] {
  const merged = mergeProviderPressureSummaries(
    summaries.map((summary) => summary.providerPressure),
  );

  return merged.providers.map((provider) => formatProviderPressure(provider));
}

function formatProviderPressure(
  provider: ProviderPressureProviderSummary,
): ResearchProviderPressureSummary {
  return {
    provider: provider.provider,
    total: provider.total,
    okPercent: statusPercent(provider, "OK"),
    degradedPercent: statusPercent(provider, "DEGRADED"),
    rateLimitedPercent: statusPercent(provider, "RATE_LIMITED"),
    errorPercent: statusPercent(provider, "ERROR"),
    liveRows: provider.liveRows,
    routerRows: provider.routerRows,
    liveRateLimitedPercent: provider.liveRateLimitedPercent,
    liveErrorPercent: provider.liveErrorPercent,
    routerCacheHits: provider.routerCacheHits,
    routerCooldownSkips: provider.routerCooldownSkips,
    routerUnavailable: provider.routerUnavailable,
    routerCooldownSkipPercent: provider.routerCooldownSkipPercent,
    combinedRateLimitedPercent: provider.combinedRateLimitedPercent,
    quoteSourceTypeCounts: provider.quoteSourceTypeCounts,
    quoteFallbackReasonCounts: provider.quoteFallbackReasonCounts,
    quoteDemandActionCounts: provider.quoteDemandActionCounts ?? {},
    jupiterDemandActionCounts: provider.jupiterDemandActionCounts ?? {},
    jupiterDemandOperationCounts: provider.jupiterDemandOperationCounts ?? {},
    jupiterDemandPriorityCounts: provider.jupiterDemandPriorityCounts ?? {},
    jupiterDemandDeferredCount: provider.jupiterDemandDeferredCount ?? 0,
    jupiterLiveAllowedCount: provider.jupiterLiveAllowedCount ?? 0,
    jupiterControllerRateLimitObservedCount: provider.jupiterControllerRateLimitObservedCount ?? 0,
    jupiterEffectiveIntervalMsAverage: provider.jupiterEffectiveIntervalMsAverage ?? 0,
    jupiterAdaptiveLevelMax: provider.jupiterAdaptiveLevelMax ?? 0,
    jupiterSharedWindowUsageMax: provider.jupiterSharedWindowUsageMax ?? 0,
    quoteSchedulerWaitMsTotal: provider.quoteSchedulerWaitMsTotal ?? 0,
    quoteSingleFlightJoinCount: provider.quoteSingleFlightJoinCount ?? 0,
    quoteNegativeCacheHitCount: provider.quoteNegativeCacheHitCount ?? 0,
    quoteNegativeCacheReasonCounts: provider.quoteNegativeCacheReasonCounts ?? {},
    raydiumVenueGuardDecisionCounts: provider.raydiumVenueGuardDecisionCounts ?? {},
    raydiumVenueGuardReasonCounts: provider.raydiumVenueGuardReasonCounts ?? {},
    liveQuoteCallsAvoidedEstimate: provider.liveQuoteCallsAvoidedEstimate ?? 0,
    authorityEvidenceSourceCounts: provider.authorityEvidenceSourceCounts,
    mintAuthorityStateCounts: provider.mintAuthorityStateCounts,
    freezeAuthorityStateCounts: provider.freezeAuthorityStateCounts,
    rpcCacheStatusCounts: provider.rpcCacheStatusCounts,
    rpcFailureCategoryCounts: provider.rpcFailureCategoryCounts,
    dasProviderCounts: provider.dasProviderCounts,
    dasFailureCategoryCounts: provider.dasFailureCategoryCounts,
    raydiumFailureCategoryCounts: provider.raydiumFailureCategoryCounts,
    raydiumPreflightStatusCounts: provider.raydiumPreflightStatusCounts,
    heliusEvidenceSourceCounts: provider.heliusEvidenceSourceCounts,
    heliusCacheStatusCounts: provider.heliusCacheStatusCounts,
    birdeyeEndpointCounts: provider.birdeyeEndpointCounts,
    birdeyeCacheStatusCounts: provider.birdeyeCacheStatusCounts,
    birdeyeFailureCategoryCounts: provider.birdeyeFailureCategoryCounts,
    birdeyeSelectionReasonCounts: provider.birdeyeSelectionReasonCounts,
    birdeyeBudgetReasonCounts: provider.birdeyeBudgetReasonCounts,
  };
}

function buildConcentration(
  candidates: readonly ShadowEntryCandidate[],
  targetPct: number,
  stopPct: number,
): ResearchConcentrationSummary {
  const targetFirstCandidates = candidates.filter(
    (candidate) =>
      targetStopOrdering(candidate.observedPoints, targetPct, stopPct) === "TARGET_FIRST",
  );
  const runCounts = countBy(targetFirstCandidates, (candidate) => candidate.runLabel);
  const mintCounts = countBy(targetFirstCandidates, (candidate) => candidate.mintAddress);
  const dominantRun = maxEntry(runCounts);
  const dominantMint = maxEntry(mintCounts);

  return {
    targetPct,
    stopPct,
    targetFirstWinCount: targetFirstCandidates.length,
    maxSingleRunWinSharePct: dominantRun
      ? percentage(dominantRun[1], targetFirstCandidates.length)
      : 0,
    maxSingleMintWinSharePct: dominantMint
      ? percentage(dominantMint[1], targetFirstCandidates.length)
      : 0,
    ...(dominantRun ? { dominantRunLabel: dominantRun[0] } : {}),
    ...(dominantMint ? { dominantMintAddress: dominantMint[0] } : {}),
  };
}

function targetStopOrdering(
  points: readonly ReturnPoint[],
  targetPct: number,
  stopPct: number,
): TargetStopOrdering {
  const sorted = [...points].sort((left, right) => left.horizonMinutes - right.horizonMinutes);
  const target = sorted.find((point) => point.returnPct >= targetPct);
  const stop = sorted.find((point) => point.returnPct <= -stopPct);

  if (target && stop && target.horizonMinutes === stop.horizonMinutes) {
    return "AMBIGUOUS";
  }

  if (target && (!stop || target.horizonMinutes < stop.horizonMinutes)) {
    return "TARGET_FIRST";
  }

  if (stop && (!target || stop.horizonMinutes < target.horizonMinutes)) {
    return "STOP_FIRST";
  }

  return "NEITHER";
}

function countBy<T>(items: readonly T[], getKey: (item: T) => string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

function maxEntry(counts: ReadonlyMap<string, number>): readonly [string, number] | undefined {
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
}

function statusPercent(
  provider: ProviderPressureSummary["providers"][number],
  status: string,
): number {
  return percentage(
    provider.statusCounts[status as keyof typeof provider.statusCounts] ?? 0,
    provider.total,
  );
}

function percentage(count: number, total: number): number {
  return total === 0 ? 0 : (count / total) * 100;
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function uniqueCount(values: readonly string[]): number {
  return new Set(values).size;
}
