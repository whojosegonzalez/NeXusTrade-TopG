import type {
  ResearchArchiveMetadata,
  ResearchProviderPressureSummary,
  ResearchQuoteBudgetSummary,
} from "../research/ResearchAggregateTypes.js";
import { mergeProviderPressureSummaries } from "../terminal-runner/TerminalRunSummary.js";
import type {
  ResearchInterpretationCandidate,
  ResearchProviderInterpretation,
} from "./ResearchInterpretationTypes.js";
import { summarizeCandidateGroup } from "./ResearchInterpretationStats.js";

export class ProviderInterpretationService {
  summarize(input: {
    readonly archives: readonly ResearchArchiveMetadata[];
    readonly candidates: readonly ResearchInterpretationCandidate[];
    readonly targetPcts: readonly number[];
    readonly stopPcts: readonly number[];
  }): ResearchProviderInterpretation {
    const providerPressure = toResearchProviderPressure(
      mergeProviderPressureSummaries(
        input.archives.map((archive) => archive.terminalSummary.providerPressure),
      ),
    );
    const missingQuoteCandidates = input.candidates.filter((candidate) => candidate.missingQuote);
    const quoteAvailableCandidates = input.candidates.filter(
      (candidate) => !candidate.missingQuote,
    );

    return {
      providers: providerPressure,
      quoteBudget: buildQuoteBudget(input.archives),
      missingQuote: summarizeCandidateGroup(
        "missing_quote",
        missingQuoteCandidates,
        input.targetPcts,
        input.stopPcts,
      ),
      quoteAvailable: summarizeCandidateGroup(
        "quote_available",
        quoteAvailableCandidates,
        input.targetPcts,
        input.stopPcts,
      ),
      notes: buildNotes(providerPressure, missingQuoteCandidates.length, input.candidates.length),
    };
  }
}

function buildQuoteBudget(
  archives: readonly ResearchArchiveMetadata[],
): ResearchQuoteBudgetSummary {
  let riskCycleCount = 0;
  let plannerEnabledCycleCount = 0;
  let selectedCount = 0;
  let notSelectedCount = 0;

  for (const archive of archives) {
    for (const cycle of archive.terminalSummary.cycles) {
      const risk = cycle.stages.find((stage) => stage.name === "risk");

      if (!risk) {
        continue;
      }

      riskCycleCount += 1;
      plannerEnabledCycleCount += risk.counts.quoteBudgetEnabled === true ? 1 : 0;
      selectedCount += asNumber(risk.counts.quoteBudgetSelected);
      notSelectedCount += asNumber(risk.counts.quoteBudgetNotSelected);
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

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toResearchProviderPressure(
  summary: ReturnType<typeof mergeProviderPressureSummaries>,
): readonly ResearchProviderPressureSummary[] {
  return summary.providers.map((provider) => ({
    provider: provider.provider,
    total: provider.total,
    okPercent: percent(provider.statusCounts.OK, provider.total),
    degradedPercent: percent(provider.statusCounts.DEGRADED, provider.total),
    rateLimitedPercent: percent(provider.statusCounts.RATE_LIMITED, provider.total),
    errorPercent: percent(provider.statusCounts.ERROR, provider.total),
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
  }));
}

function buildNotes(
  providers: readonly ResearchProviderPressureSummary[],
  missingQuoteCount: number,
  candidateCount: number,
): readonly string[] {
  const notes: string[] = [];
  const jupiter = providers.find((provider) => provider.provider.toUpperCase() === "JUPITER");
  const raydium = providers.find((provider) => provider.provider.toUpperCase() === "RAYDIUM");
  const helius = providers.find((provider) => provider.provider.toUpperCase() === "HELIUS");
  const birdeye = providers.find((provider) => provider.provider.toUpperCase() === "BIRDEYE");

  if (jupiter) {
    notes.push(
      `Jupiter live rate limit=${formatNumber(jupiter.liveRateLimitedPercent)}% combined=${formatNumber(
        jupiter.combinedRateLimitedPercent,
      )}% cacheHits=${jupiter.routerCacheHits} cooldownSkips=${jupiter.routerCooldownSkips}.`,
    );
  }

  if (raydium) {
    notes.push(
      `Raydium failures=${formatCounts(raydium.raydiumFailureCategoryCounts)} preflight=${formatCounts(
        raydium.raydiumPreflightStatusCounts,
      )}.`,
    );
  }

  if (helius) {
    notes.push(
      `Helius evidence sources=${formatCounts(helius.heliusEvidenceSourceCounts)} cache=${formatCounts(
        helius.heliusCacheStatusCounts,
      )}.`,
    );
  }

  if (birdeye) {
    notes.push(
      `Birdeye endpoints=${formatCounts(birdeye.birdeyeEndpointCounts)} cache=${formatCounts(
        birdeye.birdeyeCacheStatusCounts,
      )} failures=${formatCounts(
        birdeye.birdeyeFailureCategoryCounts,
      )} reasons=${formatCounts(birdeye.birdeyeSelectionReasonCounts)}.`,
    );
  }

  notes.push(
    `Missing quote candidates=${missingQuoteCount}/${candidateCount} (${formatNumber(
      percent(missingQuoteCount, candidateCount),
    )}%).`,
  );

  return notes;
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toString()
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatCounts(counts: Readonly<Record<string, number>>): string {
  const formatted = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");

  return formatted || "none";
}
