import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ProviderHealthRecord, ProviderStatus } from "../db/schema/index.js";
import { providerStatusValues } from "../db/schema/index.js";
import { getRepoRoot } from "../db/utils/paths.js";
import { summarizeProviderPressureMetrics } from "../providers/ProviderPressureClassifier.js";

export const TERMINAL_STAGE_NAMES = [
  "scanner",
  "risk",
  "strategy",
  "fast_shadow_observe",
  "birdeye_enrichment",
  "shadow_observe",
  "shadow_exits",
  "shadow_calibration",
  "shadow_entries",
  "watchlist_returns",
  "analytics_report",
  "calibration_report",
] as const;

export type TerminalStageName = (typeof TERMINAL_STAGE_NAMES)[number];
export type TerminalStageStatus = "SUCCESS" | "EMPTY" | "SKIPPED" | "FAILED";
export type TerminalCycleStatus = "SUCCESS" | "PARTIAL" | "FAILED";
export type TerminalSafetyStatus = "PASS" | "FAILED";

export interface ProviderPressureProviderSummary {
  readonly provider: string;
  readonly total: number;
  readonly statusCounts: Readonly<Record<ProviderStatus, number>>;
  readonly rateLimitedCount: number;
  readonly degradedCount: number;
  readonly errorCount: number;
  readonly liveRows: number;
  readonly routerRows: number;
  readonly liveRateLimitedCount: number;
  readonly liveErrorCount: number;
  readonly liveRateLimitedPercent: number;
  readonly liveErrorPercent: number;
  readonly routerCacheHits: number;
  readonly routerCooldownSkips: number;
  readonly routerUnavailable: number;
  readonly routerCooldownSkipPercent: number;
  readonly combinedRateLimitedPercent: number;
  readonly quoteSourceTypeCounts: Readonly<Record<string, number>>;
  readonly quoteFallbackReasonCounts: Readonly<Record<string, number>>;
  readonly quoteDemandActionCounts?: Readonly<Record<string, number>>;
  readonly quoteSchedulerWaitMsTotal?: number;
  readonly quoteSingleFlightJoinCount?: number;
  readonly quoteNegativeCacheHitCount?: number;
  readonly quoteNegativeCacheReasonCounts?: Readonly<Record<string, number>>;
  readonly raydiumVenueGuardDecisionCounts?: Readonly<Record<string, number>>;
  readonly raydiumVenueGuardReasonCounts?: Readonly<Record<string, number>>;
  readonly liveQuoteCallsAvoidedEstimate?: number;
  readonly jupiterDemandActionCounts?: Readonly<Record<string, number>>;
  readonly jupiterDemandOperationCounts?: Readonly<Record<string, number>>;
  readonly jupiterDemandPriorityCounts?: Readonly<Record<string, number>>;
  readonly jupiterDemandDeferredCount?: number;
  readonly jupiterLiveAllowedCount?: number;
  readonly jupiterControllerRateLimitObservedCount?: number;
  readonly jupiterEffectiveIntervalMsAverage?: number;
  readonly jupiterAdaptiveLevelMax?: number;
  readonly jupiterSharedWindowUsageMax?: number;
  readonly authorityEvidenceSourceCounts: Readonly<Record<string, number>>;
  readonly mintAuthorityStateCounts: Readonly<Record<string, number>>;
  readonly freezeAuthorityStateCounts: Readonly<Record<string, number>>;
  readonly rpcCacheStatusCounts: Readonly<Record<string, number>>;
  readonly rpcFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly dasProviderCounts: Readonly<Record<string, number>>;
  readonly dasFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly raydiumFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly raydiumPreflightStatusCounts: Readonly<Record<string, number>>;
  readonly heliusEvidenceSourceCounts: Readonly<Record<string, number>>;
  readonly heliusCacheStatusCounts: Readonly<Record<string, number>>;
  readonly birdeyeEndpointCounts: Readonly<Record<string, number>>;
  readonly birdeyeCacheStatusCounts: Readonly<Record<string, number>>;
  readonly birdeyeFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly birdeyeSelectionReasonCounts: Readonly<Record<string, number>>;
  readonly birdeyeBudgetReasonCounts: Readonly<Record<string, number>>;
}

export interface ProviderPressureSummary {
  readonly total: number;
  readonly statusCounts: Readonly<Record<ProviderStatus, number>>;
  readonly liveRows: number;
  readonly routerRows: number;
  readonly liveRateLimitedCount: number;
  readonly liveErrorCount: number;
  readonly liveRateLimitedPercent: number;
  readonly routerCacheHits: number;
  readonly routerCooldownSkips: number;
  readonly routerUnavailable: number;
  readonly routerCooldownSkipPercent: number;
  readonly combinedRateLimitedPercent: number;
  readonly quoteSourceTypeCounts: Readonly<Record<string, number>>;
  readonly quoteFallbackReasonCounts: Readonly<Record<string, number>>;
  readonly quoteDemandActionCounts?: Readonly<Record<string, number>>;
  readonly quoteSchedulerWaitMsTotal?: number;
  readonly quoteSingleFlightJoinCount?: number;
  readonly quoteNegativeCacheHitCount?: number;
  readonly quoteNegativeCacheReasonCounts?: Readonly<Record<string, number>>;
  readonly raydiumVenueGuardDecisionCounts?: Readonly<Record<string, number>>;
  readonly raydiumVenueGuardReasonCounts?: Readonly<Record<string, number>>;
  readonly liveQuoteCallsAvoidedEstimate?: number;
  readonly jupiterDemandActionCounts?: Readonly<Record<string, number>>;
  readonly jupiterDemandOperationCounts?: Readonly<Record<string, number>>;
  readonly jupiterDemandPriorityCounts?: Readonly<Record<string, number>>;
  readonly jupiterDemandDeferredCount?: number;
  readonly jupiterLiveAllowedCount?: number;
  readonly jupiterControllerRateLimitObservedCount?: number;
  readonly jupiterEffectiveIntervalMsAverage?: number;
  readonly jupiterAdaptiveLevelMax?: number;
  readonly jupiterSharedWindowUsageMax?: number;
  readonly authorityEvidenceSourceCounts: Readonly<Record<string, number>>;
  readonly mintAuthorityStateCounts: Readonly<Record<string, number>>;
  readonly freezeAuthorityStateCounts: Readonly<Record<string, number>>;
  readonly rpcCacheStatusCounts: Readonly<Record<string, number>>;
  readonly rpcFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly dasProviderCounts: Readonly<Record<string, number>>;
  readonly dasFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly raydiumFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly raydiumPreflightStatusCounts: Readonly<Record<string, number>>;
  readonly heliusEvidenceSourceCounts: Readonly<Record<string, number>>;
  readonly heliusCacheStatusCounts: Readonly<Record<string, number>>;
  readonly birdeyeEndpointCounts: Readonly<Record<string, number>>;
  readonly birdeyeCacheStatusCounts: Readonly<Record<string, number>>;
  readonly birdeyeFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly birdeyeSelectionReasonCounts: Readonly<Record<string, number>>;
  readonly birdeyeBudgetReasonCounts: Readonly<Record<string, number>>;
  readonly providers: readonly ProviderPressureProviderSummary[];
}

export interface TerminalStageResult {
  readonly name: TerminalStageName;
  readonly status: TerminalStageStatus;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly summary: string;
  readonly counts: Readonly<Record<string, number | string | boolean | null>>;
  readonly providerPressure: ProviderPressureSummary;
  readonly recoverableFailure: boolean;
  readonly errorMessage?: string;
}

export interface TerminalCycleSummary {
  readonly cycleNumber: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly status: TerminalCycleStatus;
  readonly stages: readonly TerminalStageResult[];
  readonly providerPressure: ProviderPressureSummary;
}

export interface TerminalRunSummary {
  readonly runId: string;
  readonly sessionId?: string;
  readonly mode: "PAPER";
  readonly shadowOnly: true;
  readonly safetyStatus: TerminalSafetyStatus;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly requestedCycles?: number;
  readonly maxRuntimeMinutes?: number;
  readonly intervalMs: number;
  readonly cycleCount: number;
  readonly cycles: readonly TerminalCycleSummary[];
  readonly providerPressure: ProviderPressureSummary;
  readonly stopped: boolean;
  readonly fatalErrorMessage?: string;
  readonly outputFiles?: readonly string[];
}

export function createEmptyProviderPressureSummary(): ProviderPressureSummary {
  return {
    total: 0,
    statusCounts: createEmptyStatusCounts(),
    liveRows: 0,
    routerRows: 0,
    liveRateLimitedCount: 0,
    liveErrorCount: 0,
    liveRateLimitedPercent: 0,
    routerCacheHits: 0,
    routerCooldownSkips: 0,
    routerUnavailable: 0,
    routerCooldownSkipPercent: 0,
    combinedRateLimitedPercent: 0,
    quoteSourceTypeCounts: {},
    quoteFallbackReasonCounts: {},
    quoteDemandActionCounts: {},
    quoteSchedulerWaitMsTotal: 0,
    quoteSingleFlightJoinCount: 0,
    quoteNegativeCacheHitCount: 0,
    quoteNegativeCacheReasonCounts: {},
    raydiumVenueGuardDecisionCounts: {},
    raydiumVenueGuardReasonCounts: {},
    liveQuoteCallsAvoidedEstimate: 0,
    jupiterDemandActionCounts: {},
    jupiterDemandOperationCounts: {},
    jupiterDemandPriorityCounts: {},
    jupiterDemandDeferredCount: 0,
    jupiterLiveAllowedCount: 0,
    jupiterControllerRateLimitObservedCount: 0,
    jupiterEffectiveIntervalMsAverage: 0,
    jupiterAdaptiveLevelMax: 0,
    jupiterSharedWindowUsageMax: 0,
    authorityEvidenceSourceCounts: {},
    mintAuthorityStateCounts: {},
    freezeAuthorityStateCounts: {},
    rpcCacheStatusCounts: {},
    rpcFailureCategoryCounts: {},
    dasProviderCounts: {},
    dasFailureCategoryCounts: {},
    raydiumFailureCategoryCounts: {},
    raydiumPreflightStatusCounts: {},
    heliusEvidenceSourceCounts: {},
    heliusCacheStatusCounts: {},
    birdeyeEndpointCounts: {},
    birdeyeCacheStatusCounts: {},
    birdeyeFailureCategoryCounts: {},
    birdeyeSelectionReasonCounts: {},
    birdeyeBudgetReasonCounts: {},
    providers: [],
  };
}

export function summarizeProviderHealthRows(
  rows: readonly ProviderHealthRecord[],
): ProviderPressureSummary {
  const byProvider = new Map<string, ProviderHealthRecord[]>();

  for (const row of rows) {
    byProvider.set(row.provider, [...(byProvider.get(row.provider) ?? []), row]);
  }

  const metrics = summarizeProviderPressureMetrics(rows);

  return {
    total: rows.length,
    statusCounts: metrics.statusCounts,
    liveRows: metrics.liveRows,
    routerRows: metrics.routerRows,
    liveRateLimitedCount: metrics.liveRateLimited,
    liveErrorCount: metrics.liveError,
    liveRateLimitedPercent: metrics.liveRateLimitedPct,
    routerCacheHits: metrics.routerCacheHits,
    routerCooldownSkips: metrics.routerCooldownSkips,
    routerUnavailable: metrics.routerUnavailable,
    routerCooldownSkipPercent: metrics.routerCooldownSkipPct,
    combinedRateLimitedPercent: metrics.combinedRateLimitedPct,
    quoteSourceTypeCounts: metrics.quoteSourceTypeCounts,
    quoteFallbackReasonCounts: metrics.quoteFallbackReasonCounts,
    quoteDemandActionCounts: metrics.quoteDemandActionCounts,
    quoteSchedulerWaitMsTotal: metrics.quoteSchedulerWaitMsTotal,
    quoteSingleFlightJoinCount: metrics.quoteSingleFlightJoinCount,
    quoteNegativeCacheHitCount: metrics.quoteNegativeCacheHitCount,
    quoteNegativeCacheReasonCounts: metrics.quoteNegativeCacheReasonCounts,
    raydiumVenueGuardDecisionCounts: metrics.raydiumVenueGuardDecisionCounts,
    raydiumVenueGuardReasonCounts: metrics.raydiumVenueGuardReasonCounts,
    liveQuoteCallsAvoidedEstimate: metrics.liveQuoteCallsAvoidedEstimate,
    jupiterDemandActionCounts: metrics.jupiterDemandActionCounts,
    jupiterDemandOperationCounts: metrics.jupiterDemandOperationCounts,
    jupiterDemandPriorityCounts: metrics.jupiterDemandPriorityCounts,
    jupiterDemandDeferredCount: metrics.jupiterDemandDeferredCount,
    jupiterLiveAllowedCount: metrics.jupiterLiveAllowedCount,
    jupiterControllerRateLimitObservedCount: metrics.jupiterControllerRateLimitObservedCount,
    jupiterEffectiveIntervalMsAverage: metrics.jupiterEffectiveIntervalMsAverage,
    jupiterAdaptiveLevelMax: metrics.jupiterAdaptiveLevelMax,
    jupiterSharedWindowUsageMax: metrics.jupiterSharedWindowUsageMax,
    authorityEvidenceSourceCounts: metrics.authorityEvidenceSourceCounts,
    mintAuthorityStateCounts: metrics.mintAuthorityStateCounts,
    freezeAuthorityStateCounts: metrics.freezeAuthorityStateCounts,
    rpcCacheStatusCounts: metrics.rpcCacheStatusCounts,
    rpcFailureCategoryCounts: metrics.rpcFailureCategoryCounts,
    dasProviderCounts: metrics.dasProviderCounts,
    dasFailureCategoryCounts: metrics.dasFailureCategoryCounts,
    raydiumFailureCategoryCounts: metrics.raydiumFailureCategoryCounts,
    raydiumPreflightStatusCounts: metrics.raydiumPreflightStatusCounts,
    heliusEvidenceSourceCounts: metrics.heliusEvidenceSourceCounts,
    heliusCacheStatusCounts: metrics.heliusCacheStatusCounts,
    birdeyeEndpointCounts: metrics.birdeyeEndpointCounts,
    birdeyeCacheStatusCounts: metrics.birdeyeCacheStatusCounts,
    birdeyeFailureCategoryCounts: metrics.birdeyeFailureCategoryCounts,
    birdeyeSelectionReasonCounts: metrics.birdeyeSelectionReasonCounts,
    birdeyeBudgetReasonCounts: metrics.birdeyeBudgetReasonCounts,
    providers: [...byProvider.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, providerRows]) => {
        const providerMetrics = summarizeProviderPressureMetrics(providerRows);

        return {
          provider,
          total: providerRows.length,
          statusCounts: providerMetrics.statusCounts,
          rateLimitedCount: providerMetrics.statusCounts.RATE_LIMITED,
          degradedCount: providerMetrics.statusCounts.DEGRADED,
          errorCount: providerMetrics.statusCounts.ERROR,
          liveRows: providerMetrics.liveRows,
          routerRows: providerMetrics.routerRows,
          liveRateLimitedCount: providerMetrics.liveRateLimited,
          liveErrorCount: providerMetrics.liveError,
          liveRateLimitedPercent: providerMetrics.liveRateLimitedPct,
          liveErrorPercent: providerMetrics.liveErrorPct,
          routerCacheHits: providerMetrics.routerCacheHits,
          routerCooldownSkips: providerMetrics.routerCooldownSkips,
          routerUnavailable: providerMetrics.routerUnavailable,
          routerCooldownSkipPercent: providerMetrics.routerCooldownSkipPct,
          combinedRateLimitedPercent: providerMetrics.combinedRateLimitedPct,
          quoteSourceTypeCounts: providerMetrics.quoteSourceTypeCounts,
          quoteFallbackReasonCounts: providerMetrics.quoteFallbackReasonCounts,
          quoteDemandActionCounts: providerMetrics.quoteDemandActionCounts,
          quoteSchedulerWaitMsTotal: providerMetrics.quoteSchedulerWaitMsTotal,
          quoteSingleFlightJoinCount: providerMetrics.quoteSingleFlightJoinCount,
          quoteNegativeCacheHitCount: providerMetrics.quoteNegativeCacheHitCount,
          quoteNegativeCacheReasonCounts: providerMetrics.quoteNegativeCacheReasonCounts,
          raydiumVenueGuardDecisionCounts: providerMetrics.raydiumVenueGuardDecisionCounts,
          raydiumVenueGuardReasonCounts: providerMetrics.raydiumVenueGuardReasonCounts,
          liveQuoteCallsAvoidedEstimate: providerMetrics.liveQuoteCallsAvoidedEstimate,
          jupiterDemandActionCounts: providerMetrics.jupiterDemandActionCounts,
          jupiterDemandOperationCounts: providerMetrics.jupiterDemandOperationCounts,
          jupiterDemandPriorityCounts: providerMetrics.jupiterDemandPriorityCounts,
          jupiterDemandDeferredCount: providerMetrics.jupiterDemandDeferredCount,
          jupiterLiveAllowedCount: providerMetrics.jupiterLiveAllowedCount,
          jupiterControllerRateLimitObservedCount:
            providerMetrics.jupiterControllerRateLimitObservedCount,
          jupiterEffectiveIntervalMsAverage: providerMetrics.jupiterEffectiveIntervalMsAverage,
          jupiterAdaptiveLevelMax: providerMetrics.jupiterAdaptiveLevelMax,
          jupiterSharedWindowUsageMax: providerMetrics.jupiterSharedWindowUsageMax,
          authorityEvidenceSourceCounts: providerMetrics.authorityEvidenceSourceCounts,
          mintAuthorityStateCounts: providerMetrics.mintAuthorityStateCounts,
          freezeAuthorityStateCounts: providerMetrics.freezeAuthorityStateCounts,
          rpcCacheStatusCounts: providerMetrics.rpcCacheStatusCounts,
          rpcFailureCategoryCounts: providerMetrics.rpcFailureCategoryCounts,
          dasProviderCounts: providerMetrics.dasProviderCounts,
          dasFailureCategoryCounts: providerMetrics.dasFailureCategoryCounts,
          raydiumFailureCategoryCounts: providerMetrics.raydiumFailureCategoryCounts,
          raydiumPreflightStatusCounts: providerMetrics.raydiumPreflightStatusCounts,
          heliusEvidenceSourceCounts: providerMetrics.heliusEvidenceSourceCounts,
          heliusCacheStatusCounts: providerMetrics.heliusCacheStatusCounts,
          birdeyeEndpointCounts: providerMetrics.birdeyeEndpointCounts,
          birdeyeCacheStatusCounts: providerMetrics.birdeyeCacheStatusCounts,
          birdeyeFailureCategoryCounts: providerMetrics.birdeyeFailureCategoryCounts,
          birdeyeSelectionReasonCounts: providerMetrics.birdeyeSelectionReasonCounts,
          birdeyeBudgetReasonCounts: providerMetrics.birdeyeBudgetReasonCounts,
        };
      }),
  };
}

export function mergeProviderPressureSummaries(
  summaries: readonly ProviderPressureSummary[],
): ProviderPressureSummary {
  const statusCounts = createEmptyStatusCounts();
  const byProvider = new Map<string, ProviderPressureProviderSummary[]>();
  let liveRows = 0;
  let routerRows = 0;
  let liveRateLimitedCount = 0;
  let liveErrorCount = 0;
  let routerCacheHits = 0;
  let routerCooldownSkips = 0;
  let routerUnavailable = 0;
  const quoteSourceTypeCounts: Record<string, number> = {};
  const quoteFallbackReasonCounts: Record<string, number> = {};
  const quoteDemandActionCounts: Record<string, number> = {};
  let quoteSchedulerWaitMsTotal = 0;
  let quoteSingleFlightJoinCount = 0;
  let quoteNegativeCacheHitCount = 0;
  const quoteNegativeCacheReasonCounts: Record<string, number> = {};
  const raydiumVenueGuardDecisionCounts: Record<string, number> = {};
  const raydiumVenueGuardReasonCounts: Record<string, number> = {};
  let liveQuoteCallsAvoidedEstimate = 0;
  const jupiterDemandActionCounts: Record<string, number> = {};
  const jupiterDemandOperationCounts: Record<string, number> = {};
  const jupiterDemandPriorityCounts: Record<string, number> = {};
  let jupiterDemandDeferredCount = 0;
  let jupiterLiveAllowedCount = 0;
  let jupiterControllerRateLimitObservedCount = 0;
  let jupiterEffectiveIntervalMsWeightedTotal = 0;
  let jupiterEffectiveIntervalWeight = 0;
  let jupiterAdaptiveLevelMax = 0;
  let jupiterSharedWindowUsageMax = 0;
  const authorityEvidenceSourceCounts: Record<string, number> = {};
  const mintAuthorityStateCounts: Record<string, number> = {};
  const freezeAuthorityStateCounts: Record<string, number> = {};
  const rpcCacheStatusCounts: Record<string, number> = {};
  const rpcFailureCategoryCounts: Record<string, number> = {};
  const dasProviderCounts: Record<string, number> = {};
  const dasFailureCategoryCounts: Record<string, number> = {};
  const raydiumFailureCategoryCounts: Record<string, number> = {};
  const raydiumPreflightStatusCounts: Record<string, number> = {};
  const heliusEvidenceSourceCounts: Record<string, number> = {};
  const heliusCacheStatusCounts: Record<string, number> = {};
  const birdeyeEndpointCounts: Record<string, number> = {};
  const birdeyeCacheStatusCounts: Record<string, number> = {};
  const birdeyeFailureCategoryCounts: Record<string, number> = {};
  const birdeyeSelectionReasonCounts: Record<string, number> = {};
  const birdeyeBudgetReasonCounts: Record<string, number> = {};

  for (const summary of summaries) {
    liveRows += summary.liveRows ?? 0;
    routerRows += summary.routerRows ?? 0;
    liveRateLimitedCount += summary.liveRateLimitedCount ?? 0;
    liveErrorCount += summary.liveErrorCount ?? 0;
    routerCacheHits += summary.routerCacheHits ?? 0;
    routerCooldownSkips += summary.routerCooldownSkips ?? 0;
    routerUnavailable += summary.routerUnavailable ?? 0;
    mergeCounts(quoteSourceTypeCounts, summary.quoteSourceTypeCounts);
    mergeCounts(quoteFallbackReasonCounts, summary.quoteFallbackReasonCounts);
    mergeCounts(quoteDemandActionCounts, summary.quoteDemandActionCounts);
    quoteSchedulerWaitMsTotal += summary.quoteSchedulerWaitMsTotal ?? 0;
    quoteSingleFlightJoinCount += summary.quoteSingleFlightJoinCount ?? 0;
    quoteNegativeCacheHitCount += summary.quoteNegativeCacheHitCount ?? 0;
    mergeCounts(quoteNegativeCacheReasonCounts, summary.quoteNegativeCacheReasonCounts);
    mergeCounts(raydiumVenueGuardDecisionCounts, summary.raydiumVenueGuardDecisionCounts);
    mergeCounts(raydiumVenueGuardReasonCounts, summary.raydiumVenueGuardReasonCounts);
    liveQuoteCallsAvoidedEstimate += summary.liveQuoteCallsAvoidedEstimate ?? 0;
    mergeCounts(jupiterDemandActionCounts, summary.jupiterDemandActionCounts);
    mergeCounts(jupiterDemandOperationCounts, summary.jupiterDemandOperationCounts);
    mergeCounts(jupiterDemandPriorityCounts, summary.jupiterDemandPriorityCounts);
    jupiterDemandDeferredCount += summary.jupiterDemandDeferredCount ?? 0;
    jupiterLiveAllowedCount += summary.jupiterLiveAllowedCount ?? 0;
    jupiterControllerRateLimitObservedCount += summary.jupiterControllerRateLimitObservedCount ?? 0;
    const jupiterIntervalWeight =
      (summary.jupiterLiveAllowedCount ?? 0) + (summary.jupiterDemandDeferredCount ?? 0);
    jupiterEffectiveIntervalMsWeightedTotal +=
      (summary.jupiterEffectiveIntervalMsAverage ?? 0) * jupiterIntervalWeight;
    jupiterEffectiveIntervalWeight += jupiterIntervalWeight;
    jupiterAdaptiveLevelMax = Math.max(
      jupiterAdaptiveLevelMax,
      summary.jupiterAdaptiveLevelMax ?? 0,
    );
    jupiterSharedWindowUsageMax = Math.max(
      jupiterSharedWindowUsageMax,
      summary.jupiterSharedWindowUsageMax ?? 0,
    );
    mergeCounts(authorityEvidenceSourceCounts, summary.authorityEvidenceSourceCounts);
    mergeCounts(mintAuthorityStateCounts, summary.mintAuthorityStateCounts);
    mergeCounts(freezeAuthorityStateCounts, summary.freezeAuthorityStateCounts);
    mergeCounts(rpcCacheStatusCounts, summary.rpcCacheStatusCounts);
    mergeCounts(rpcFailureCategoryCounts, summary.rpcFailureCategoryCounts);
    mergeCounts(dasProviderCounts, summary.dasProviderCounts);
    mergeCounts(dasFailureCategoryCounts, summary.dasFailureCategoryCounts);
    mergeCounts(raydiumFailureCategoryCounts, summary.raydiumFailureCategoryCounts);
    mergeCounts(raydiumPreflightStatusCounts, summary.raydiumPreflightStatusCounts);
    mergeCounts(heliusEvidenceSourceCounts, summary.heliusEvidenceSourceCounts);
    mergeCounts(heliusCacheStatusCounts, summary.heliusCacheStatusCounts);
    mergeCounts(birdeyeEndpointCounts, summary.birdeyeEndpointCounts);
    mergeCounts(birdeyeCacheStatusCounts, summary.birdeyeCacheStatusCounts);
    mergeCounts(birdeyeFailureCategoryCounts, summary.birdeyeFailureCategoryCounts);
    mergeCounts(birdeyeSelectionReasonCounts, summary.birdeyeSelectionReasonCounts);
    mergeCounts(birdeyeBudgetReasonCounts, summary.birdeyeBudgetReasonCounts);

    for (const status of providerStatusValues) {
      statusCounts[status] += summary.statusCounts[status] ?? 0;
    }

    for (const provider of summary.providers) {
      byProvider.set(provider.provider, [...(byProvider.get(provider.provider) ?? []), provider]);
    }
  }

  return {
    total: summaries.reduce((total, summary) => total + summary.total, 0),
    statusCounts,
    liveRows,
    routerRows,
    liveRateLimitedCount,
    liveErrorCount,
    liveRateLimitedPercent: percent(liveRateLimitedCount, liveRows),
    routerCacheHits,
    routerCooldownSkips,
    routerUnavailable,
    routerCooldownSkipPercent: percent(routerCooldownSkips, routerRows),
    combinedRateLimitedPercent: percent(
      statusCounts.RATE_LIMITED,
      summaries.reduce((total, summary) => total + summary.total, 0),
    ),
    quoteSourceTypeCounts,
    quoteFallbackReasonCounts,
    quoteDemandActionCounts,
    quoteSchedulerWaitMsTotal,
    quoteSingleFlightJoinCount,
    quoteNegativeCacheHitCount,
    quoteNegativeCacheReasonCounts,
    raydiumVenueGuardDecisionCounts,
    raydiumVenueGuardReasonCounts,
    liveQuoteCallsAvoidedEstimate,
    jupiterDemandActionCounts,
    jupiterDemandOperationCounts,
    jupiterDemandPriorityCounts,
    jupiterDemandDeferredCount,
    jupiterLiveAllowedCount,
    jupiterControllerRateLimitObservedCount,
    jupiterEffectiveIntervalMsAverage:
      jupiterEffectiveIntervalWeight === 0
        ? 0
        : jupiterEffectiveIntervalMsWeightedTotal / jupiterEffectiveIntervalWeight,
    jupiterAdaptiveLevelMax,
    jupiterSharedWindowUsageMax,
    authorityEvidenceSourceCounts,
    mintAuthorityStateCounts,
    freezeAuthorityStateCounts,
    rpcCacheStatusCounts,
    rpcFailureCategoryCounts,
    dasProviderCounts,
    dasFailureCategoryCounts,
    raydiumFailureCategoryCounts,
    raydiumPreflightStatusCounts,
    heliusEvidenceSourceCounts,
    heliusCacheStatusCounts,
    birdeyeEndpointCounts,
    birdeyeCacheStatusCounts,
    birdeyeFailureCategoryCounts,
    birdeyeSelectionReasonCounts,
    birdeyeBudgetReasonCounts,
    providers: [...byProvider.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, rows]) => {
        const providerStatusCounts = createEmptyStatusCounts();
        let providerLiveRows = 0;
        let providerRouterRows = 0;
        let providerLiveRateLimitedCount = 0;
        let providerLiveErrorCount = 0;
        let providerRouterCacheHits = 0;
        let providerRouterCooldownSkips = 0;
        let providerRouterUnavailable = 0;
        const providerQuoteSourceTypeCounts: Record<string, number> = {};
        const providerQuoteFallbackReasonCounts: Record<string, number> = {};
        const providerQuoteDemandActionCounts: Record<string, number> = {};
        let providerQuoteSchedulerWaitMsTotal = 0;
        let providerQuoteSingleFlightJoinCount = 0;
        let providerQuoteNegativeCacheHitCount = 0;
        const providerQuoteNegativeCacheReasonCounts: Record<string, number> = {};
        const providerRaydiumVenueGuardDecisionCounts: Record<string, number> = {};
        const providerRaydiumVenueGuardReasonCounts: Record<string, number> = {};
        let providerLiveQuoteCallsAvoidedEstimate = 0;
        const providerJupiterDemandActionCounts: Record<string, number> = {};
        const providerJupiterDemandOperationCounts: Record<string, number> = {};
        const providerJupiterDemandPriorityCounts: Record<string, number> = {};
        let providerJupiterDemandDeferredCount = 0;
        let providerJupiterLiveAllowedCount = 0;
        let providerJupiterControllerRateLimitObservedCount = 0;
        let providerJupiterEffectiveIntervalMsWeightedTotal = 0;
        let providerJupiterEffectiveIntervalWeight = 0;
        let providerJupiterAdaptiveLevelMax = 0;
        let providerJupiterSharedWindowUsageMax = 0;
        const providerAuthorityEvidenceSourceCounts: Record<string, number> = {};
        const providerMintAuthorityStateCounts: Record<string, number> = {};
        const providerFreezeAuthorityStateCounts: Record<string, number> = {};
        const providerRpcCacheStatusCounts: Record<string, number> = {};
        const providerRpcFailureCategoryCounts: Record<string, number> = {};
        const providerDasProviderCounts: Record<string, number> = {};
        const providerDasFailureCategoryCounts: Record<string, number> = {};
        const providerRaydiumFailureCategoryCounts: Record<string, number> = {};
        const providerRaydiumPreflightStatusCounts: Record<string, number> = {};
        const providerHeliusEvidenceSourceCounts: Record<string, number> = {};
        const providerHeliusCacheStatusCounts: Record<string, number> = {};
        const providerBirdeyeEndpointCounts: Record<string, number> = {};
        const providerBirdeyeCacheStatusCounts: Record<string, number> = {};
        const providerBirdeyeFailureCategoryCounts: Record<string, number> = {};
        const providerBirdeyeSelectionReasonCounts: Record<string, number> = {};
        const providerBirdeyeBudgetReasonCounts: Record<string, number> = {};

        for (const row of rows) {
          providerLiveRows += row.liveRows ?? 0;
          providerRouterRows += row.routerRows ?? 0;
          providerLiveRateLimitedCount += row.liveRateLimitedCount ?? 0;
          providerLiveErrorCount += row.liveErrorCount ?? 0;
          providerRouterCacheHits += row.routerCacheHits ?? 0;
          providerRouterCooldownSkips += row.routerCooldownSkips ?? 0;
          providerRouterUnavailable += row.routerUnavailable ?? 0;
          mergeCounts(providerQuoteSourceTypeCounts, row.quoteSourceTypeCounts);
          mergeCounts(providerQuoteFallbackReasonCounts, row.quoteFallbackReasonCounts);
          mergeCounts(providerQuoteDemandActionCounts, row.quoteDemandActionCounts);
          providerQuoteSchedulerWaitMsTotal += row.quoteSchedulerWaitMsTotal ?? 0;
          providerQuoteSingleFlightJoinCount += row.quoteSingleFlightJoinCount ?? 0;
          providerQuoteNegativeCacheHitCount += row.quoteNegativeCacheHitCount ?? 0;
          mergeCounts(providerQuoteNegativeCacheReasonCounts, row.quoteNegativeCacheReasonCounts);
          mergeCounts(providerRaydiumVenueGuardDecisionCounts, row.raydiumVenueGuardDecisionCounts);
          mergeCounts(providerRaydiumVenueGuardReasonCounts, row.raydiumVenueGuardReasonCounts);
          providerLiveQuoteCallsAvoidedEstimate += row.liveQuoteCallsAvoidedEstimate ?? 0;
          mergeCounts(providerJupiterDemandActionCounts, row.jupiterDemandActionCounts);
          mergeCounts(providerJupiterDemandOperationCounts, row.jupiterDemandOperationCounts);
          mergeCounts(providerJupiterDemandPriorityCounts, row.jupiterDemandPriorityCounts);
          providerJupiterDemandDeferredCount += row.jupiterDemandDeferredCount ?? 0;
          providerJupiterLiveAllowedCount += row.jupiterLiveAllowedCount ?? 0;
          providerJupiterControllerRateLimitObservedCount +=
            row.jupiterControllerRateLimitObservedCount ?? 0;
          const providerJupiterIntervalWeight =
            (row.jupiterLiveAllowedCount ?? 0) + (row.jupiterDemandDeferredCount ?? 0);
          providerJupiterEffectiveIntervalMsWeightedTotal +=
            (row.jupiterEffectiveIntervalMsAverage ?? 0) * providerJupiterIntervalWeight;
          providerJupiterEffectiveIntervalWeight += providerJupiterIntervalWeight;
          providerJupiterAdaptiveLevelMax = Math.max(
            providerJupiterAdaptiveLevelMax,
            row.jupiterAdaptiveLevelMax ?? 0,
          );
          providerJupiterSharedWindowUsageMax = Math.max(
            providerJupiterSharedWindowUsageMax,
            row.jupiterSharedWindowUsageMax ?? 0,
          );
          mergeCounts(providerAuthorityEvidenceSourceCounts, row.authorityEvidenceSourceCounts);
          mergeCounts(providerMintAuthorityStateCounts, row.mintAuthorityStateCounts);
          mergeCounts(providerFreezeAuthorityStateCounts, row.freezeAuthorityStateCounts);
          mergeCounts(providerRpcCacheStatusCounts, row.rpcCacheStatusCounts);
          mergeCounts(providerRpcFailureCategoryCounts, row.rpcFailureCategoryCounts);
          mergeCounts(providerDasProviderCounts, row.dasProviderCounts);
          mergeCounts(providerDasFailureCategoryCounts, row.dasFailureCategoryCounts);
          mergeCounts(providerRaydiumFailureCategoryCounts, row.raydiumFailureCategoryCounts);
          mergeCounts(providerRaydiumPreflightStatusCounts, row.raydiumPreflightStatusCounts);
          mergeCounts(providerHeliusEvidenceSourceCounts, row.heliusEvidenceSourceCounts);
          mergeCounts(providerHeliusCacheStatusCounts, row.heliusCacheStatusCounts);
          mergeCounts(providerBirdeyeEndpointCounts, row.birdeyeEndpointCounts);
          mergeCounts(providerBirdeyeCacheStatusCounts, row.birdeyeCacheStatusCounts);
          mergeCounts(providerBirdeyeFailureCategoryCounts, row.birdeyeFailureCategoryCounts);
          mergeCounts(providerBirdeyeSelectionReasonCounts, row.birdeyeSelectionReasonCounts);
          mergeCounts(providerBirdeyeBudgetReasonCounts, row.birdeyeBudgetReasonCounts);

          for (const status of providerStatusValues) {
            providerStatusCounts[status] += row.statusCounts[status] ?? 0;
          }
        }
        const providerTotal = rows.reduce((total, row) => total + row.total, 0);

        return {
          provider,
          total: providerTotal,
          statusCounts: providerStatusCounts,
          rateLimitedCount: providerStatusCounts.RATE_LIMITED,
          degradedCount: providerStatusCounts.DEGRADED,
          errorCount: providerStatusCounts.ERROR,
          liveRows: providerLiveRows,
          routerRows: providerRouterRows,
          liveRateLimitedCount: providerLiveRateLimitedCount,
          liveErrorCount: providerLiveErrorCount,
          liveRateLimitedPercent: percent(providerLiveRateLimitedCount, providerLiveRows),
          liveErrorPercent: percent(providerLiveErrorCount, providerLiveRows),
          routerCacheHits: providerRouterCacheHits,
          routerCooldownSkips: providerRouterCooldownSkips,
          routerUnavailable: providerRouterUnavailable,
          routerCooldownSkipPercent: percent(providerRouterCooldownSkips, providerRouterRows),
          combinedRateLimitedPercent: percent(providerStatusCounts.RATE_LIMITED, providerTotal),
          quoteSourceTypeCounts: providerQuoteSourceTypeCounts,
          quoteFallbackReasonCounts: providerQuoteFallbackReasonCounts,
          quoteDemandActionCounts: providerQuoteDemandActionCounts,
          quoteSchedulerWaitMsTotal: providerQuoteSchedulerWaitMsTotal,
          quoteSingleFlightJoinCount: providerQuoteSingleFlightJoinCount,
          quoteNegativeCacheHitCount: providerQuoteNegativeCacheHitCount,
          quoteNegativeCacheReasonCounts: providerQuoteNegativeCacheReasonCounts,
          raydiumVenueGuardDecisionCounts: providerRaydiumVenueGuardDecisionCounts,
          raydiumVenueGuardReasonCounts: providerRaydiumVenueGuardReasonCounts,
          liveQuoteCallsAvoidedEstimate: providerLiveQuoteCallsAvoidedEstimate,
          jupiterDemandActionCounts: providerJupiterDemandActionCounts,
          jupiterDemandOperationCounts: providerJupiterDemandOperationCounts,
          jupiterDemandPriorityCounts: providerJupiterDemandPriorityCounts,
          jupiterDemandDeferredCount: providerJupiterDemandDeferredCount,
          jupiterLiveAllowedCount: providerJupiterLiveAllowedCount,
          jupiterControllerRateLimitObservedCount: providerJupiterControllerRateLimitObservedCount,
          jupiterEffectiveIntervalMsAverage:
            providerJupiterEffectiveIntervalWeight === 0
              ? 0
              : providerJupiterEffectiveIntervalMsWeightedTotal /
                providerJupiterEffectiveIntervalWeight,
          jupiterAdaptiveLevelMax: providerJupiterAdaptiveLevelMax,
          jupiterSharedWindowUsageMax: providerJupiterSharedWindowUsageMax,
          authorityEvidenceSourceCounts: providerAuthorityEvidenceSourceCounts,
          mintAuthorityStateCounts: providerMintAuthorityStateCounts,
          freezeAuthorityStateCounts: providerFreezeAuthorityStateCounts,
          rpcCacheStatusCounts: providerRpcCacheStatusCounts,
          rpcFailureCategoryCounts: providerRpcFailureCategoryCounts,
          dasProviderCounts: providerDasProviderCounts,
          dasFailureCategoryCounts: providerDasFailureCategoryCounts,
          raydiumFailureCategoryCounts: providerRaydiumFailureCategoryCounts,
          raydiumPreflightStatusCounts: providerRaydiumPreflightStatusCounts,
          heliusEvidenceSourceCounts: providerHeliusEvidenceSourceCounts,
          heliusCacheStatusCounts: providerHeliusCacheStatusCounts,
          birdeyeEndpointCounts: providerBirdeyeEndpointCounts,
          birdeyeCacheStatusCounts: providerBirdeyeCacheStatusCounts,
          birdeyeFailureCategoryCounts: providerBirdeyeFailureCategoryCounts,
          birdeyeSelectionReasonCounts: providerBirdeyeSelectionReasonCounts,
          birdeyeBudgetReasonCounts: providerBirdeyeBudgetReasonCounts,
        };
      }),
  };
}

export function formatTerminalRunJson(summary: TerminalRunSummary): string {
  return JSON.stringify(summary, null, 2);
}

export function formatTerminalRunText(summary: TerminalRunSummary): string {
  const lines: string[] = [];

  lines.push("NeXusTrade TerminalRunner Summary");
  lines.push(`Run id: ${summary.runId}`);
  if (summary.sessionId) {
    lines.push(`Session id: ${summary.sessionId}`);
  }
  lines.push(`Mode: ${summary.mode}`);
  lines.push(`Shadow only: ${summary.shadowOnly ? "yes" : "no"}`);
  lines.push(`Safety status: ${summary.safetyStatus}`);
  lines.push(`Started: ${new Date(summary.startedAtMs).toISOString()}`);
  lines.push(`Ended: ${new Date(summary.endedAtMs).toISOString()}`);
  lines.push(`Duration ms: ${summary.durationMs}`);
  lines.push(`Cycles: ${summary.cycleCount}`);
  lines.push("");

  for (const cycle of summary.cycles) {
    lines.push(`Cycle ${cycle.cycleNumber}: ${cycle.status} durationMs=${cycle.durationMs}`);

    for (const stage of cycle.stages) {
      lines.push(
        `  ${stage.name}: ${stage.status} durationMs=${stage.durationMs} ${stage.summary}`,
      );

      if (stage.errorMessage) {
        lines.push(`    error: ${stage.errorMessage}`);
      }

      const counts = formatCounts(stage.counts);

      if (counts) {
        lines.push(`    counts: ${counts}`);
      }
    }

    lines.push(`  provider pressure: ${formatProviderPressure(cycle.providerPressure)}`);
  }

  lines.push("");
  lines.push(`Provider pressure total: ${formatProviderPressure(summary.providerPressure)}`);

  if (summary.fatalErrorMessage) {
    lines.push(`Fatal error: ${summary.fatalErrorMessage}`);
  }

  if (summary.outputFiles && summary.outputFiles.length > 0) {
    lines.push("");
    lines.push("Output files:");
    lines.push(...summary.outputFiles.map((file) => `  ${file}`));
  }

  return lines.join("\n");
}

export function writeTerminalRunArtifacts(input: {
  readonly summary: TerminalRunSummary;
  readonly outputDir: string;
}): readonly string[] {
  const resolvedOutputDir = path.isAbsolute(input.outputDir)
    ? path.resolve(input.outputDir)
    : path.resolve(getRepoRoot(), input.outputDir);
  const baseName = input.summary.runId;
  const jsonPath = path.join(resolvedOutputDir, `${baseName}.json`);
  const textPath = path.join(resolvedOutputDir, `${baseName}.txt`);

  mkdirSync(resolvedOutputDir, { recursive: true });
  writeFileSync(jsonPath, formatTerminalRunJson(input.summary), "utf8");
  writeFileSync(textPath, formatTerminalRunText(input.summary), "utf8");

  return [jsonPath, textPath];
}

function createEmptyStatusCounts(): Record<ProviderStatus, number> {
  return Object.fromEntries(providerStatusValues.map((status) => [status, 0])) as Record<
    ProviderStatus,
    number
  >;
}

function formatProviderPressure(summary: ProviderPressureSummary): string {
  if (summary.total === 0) {
    return "none";
  }

  return summary.providers
    .map((provider) => {
      const sourceTypes = formatCompactCounts(provider.quoteSourceTypeCounts);
      const fallbackReasons = formatCompactCounts(provider.quoteFallbackReasonCounts);
      const demandActions = formatCompactCounts(provider.quoteDemandActionCounts ?? {});
      const negativeCacheReasons = formatCompactCounts(
        provider.quoteNegativeCacheReasonCounts ?? {},
      );
      const venueGuardDecisions = formatCompactCounts(
        provider.raydiumVenueGuardDecisionCounts ?? {},
      );
      const venueGuardReasons = formatCompactCounts(provider.raydiumVenueGuardReasonCounts ?? {});
      const authoritySources = formatCompactCounts(provider.authorityEvidenceSourceCounts);
      const mintAuthority = formatCompactCounts(provider.mintAuthorityStateCounts);
      const freezeAuthority = formatCompactCounts(provider.freezeAuthorityStateCounts);
      const rpcCache = formatCompactCounts(provider.rpcCacheStatusCounts);
      const rpcFailures = formatCompactCounts(provider.rpcFailureCategoryCounts);
      const dasProviders = formatCompactCounts(provider.dasProviderCounts);
      const dasFailures = formatCompactCounts(provider.dasFailureCategoryCounts);
      const raydiumFailures = formatCompactCounts(provider.raydiumFailureCategoryCounts);
      const raydiumPreflight = formatCompactCounts(provider.raydiumPreflightStatusCounts);
      const heliusSources = formatCompactCounts(provider.heliusEvidenceSourceCounts);
      const heliusCache = formatCompactCounts(provider.heliusCacheStatusCounts);
      const birdeyeEndpoints = formatCompactCounts(provider.birdeyeEndpointCounts);
      const birdeyeCache = formatCompactCounts(provider.birdeyeCacheStatusCounts);
      const birdeyeFailures = formatCompactCounts(provider.birdeyeFailureCategoryCounts);
      const birdeyeReasons = formatCompactCounts(provider.birdeyeSelectionReasonCounts);
      const birdeyeBudget = formatCompactCounts(provider.birdeyeBudgetReasonCounts);

      return `${provider.provider}{total=${provider.total},live=${provider.liveRows},router=${provider.routerRows},liveRateLimited=${provider.liveRateLimitedPercent.toFixed(2)}%,cache=${provider.routerCacheHits},cooldown=${provider.routerCooldownSkips},avoided=${provider.liveQuoteCallsAvoidedEstimate ?? 0},schedulerWaitMs=${provider.quoteSchedulerWaitMsTotal ?? 0},singleFlightJoins=${provider.quoteSingleFlightJoinCount ?? 0},negativeCacheHits=${provider.quoteNegativeCacheHitCount ?? 0},OK=${provider.statusCounts.OK},DEGRADED=${provider.statusCounts.DEGRADED},RATE_LIMITED=${provider.statusCounts.RATE_LIMITED},ERROR=${provider.statusCounts.ERROR},DISABLED=${provider.statusCounts.DISABLED}${sourceTypes ? `,quoteSourceTypes=${sourceTypes}` : ""}${fallbackReasons ? `,fallbackReasons=${fallbackReasons}` : ""}${demandActions ? `,quoteDemandActions=${demandActions}` : ""}${negativeCacheReasons ? `,negativeCacheReasons=${negativeCacheReasons}` : ""}${venueGuardDecisions ? `,raydiumVenueGuard=${venueGuardDecisions}` : ""}${venueGuardReasons ? `,raydiumVenueReasons=${venueGuardReasons}` : ""}${authoritySources ? `,authoritySources=${authoritySources}` : ""}${mintAuthority ? `,mintAuthority=${mintAuthority}` : ""}${freezeAuthority ? `,freezeAuthority=${freezeAuthority}` : ""}${rpcCache ? `,rpcCache=${rpcCache}` : ""}${rpcFailures ? `,rpcFailures=${rpcFailures}` : ""}${dasProviders ? `,dasProviders=${dasProviders}` : ""}${dasFailures ? `,dasFailures=${dasFailures}` : ""}${raydiumFailures ? `,raydiumFailures=${raydiumFailures}` : ""}${raydiumPreflight ? `,raydiumPreflight=${raydiumPreflight}` : ""}${heliusSources ? `,heliusSources=${heliusSources}` : ""}${heliusCache ? `,heliusCache=${heliusCache}` : ""}${birdeyeEndpoints ? `,birdeyeEndpoints=${birdeyeEndpoints}` : ""}${birdeyeCache ? `,birdeyeCache=${birdeyeCache}` : ""}${birdeyeFailures ? `,birdeyeFailures=${birdeyeFailures}` : ""}${birdeyeReasons ? `,birdeyeReasons=${birdeyeReasons}` : ""}${birdeyeBudget ? `,birdeyeBudget=${birdeyeBudget}` : ""}}`;
    })
    .join(" ");
}

function formatCounts(counts: Readonly<Record<string, number | string | boolean | null>>): string {
  return Object.entries(counts)
    .filter(([, value]) => value !== 0 && value !== false && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function mergeCounts(
  target: Record<string, number>,
  source: Readonly<Record<string, number>> | undefined,
): void {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function formatCompactCounts(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");
}
