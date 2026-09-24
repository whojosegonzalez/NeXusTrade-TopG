import type { ProviderHealthRecord, ProviderStatus } from "../db/schema/index.js";
import { providerStatusValues } from "../db/schema/index.js";
import { parseJson } from "../db/utils/json.js";

export type ProviderPressureClass =
  | "LIVE_PROVIDER"
  | "ROUTER_CACHE"
  | "ROUTER_COOLDOWN"
  | "ROUTER_UNAVAILABLE"
  | "ROUTER_OTHER"
  | "DISABLED";

export interface ProviderPressureMetrics {
  readonly totalRows: number;
  readonly liveRows: number;
  readonly routerRows: number;
  readonly statusCounts: Readonly<Record<ProviderStatus, number>>;
  readonly liveOk: number;
  readonly liveDegraded: number;
  readonly liveRateLimited: number;
  readonly liveError: number;
  readonly liveRateLimitedPct: number;
  readonly liveErrorPct: number;
  readonly routerCacheHits: number;
  readonly routerCooldownSkips: number;
  readonly routerUnavailable: number;
  readonly routerCooldownSkipPct: number;
  readonly combinedRateLimitedPct: number;
  readonly quoteSourceTypeCounts: Readonly<Record<string, number>>;
  readonly quoteFallbackReasonCounts: Readonly<Record<string, number>>;
  readonly quoteDemandActionCounts: Readonly<Record<string, number>>;
  readonly quoteSchedulerWaitMsTotal: number;
  readonly quoteSingleFlightJoinCount: number;
  readonly quoteNegativeCacheHitCount: number;
  readonly quoteNegativeCacheReasonCounts: Readonly<Record<string, number>>;
  readonly raydiumVenueGuardDecisionCounts: Readonly<Record<string, number>>;
  readonly raydiumVenueGuardReasonCounts: Readonly<Record<string, number>>;
  readonly liveQuoteCallsAvoidedEstimate: number;
  readonly jupiterDemandActionCounts: Readonly<Record<string, number>>;
  readonly jupiterDemandOperationCounts: Readonly<Record<string, number>>;
  readonly jupiterDemandPriorityCounts: Readonly<Record<string, number>>;
  readonly jupiterDemandDeferredCount: number;
  readonly jupiterLiveAllowedCount: number;
  readonly jupiterControllerRateLimitObservedCount: number;
  readonly jupiterEffectiveIntervalMsAverage: number;
  readonly jupiterAdaptiveLevelMax: number;
  readonly jupiterSharedWindowUsageMax: number;
  readonly authorityEvidenceSourceCounts: Readonly<Record<string, number>>;
  readonly mintAuthorityStateCounts: Readonly<Record<string, number>>;
  readonly freezeAuthorityStateCounts: Readonly<Record<string, number>>;
  readonly rpcCacheStatusCounts: Readonly<Record<string, number>>;
  readonly rpcFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly dasProviderCounts: Readonly<Record<string, number>>;
  readonly dasFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly raydiumFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly raydiumFailureDetailCounts: Readonly<Record<string, number>>;
  readonly raydiumPreflightStatusCounts: Readonly<Record<string, number>>;
  readonly raydiumPreflightFailureDetailCounts: Readonly<Record<string, number>>;
  readonly httpEndpointIdCounts: Readonly<Record<string, number>>;
  readonly httpAttemptOutcomeCounts: Readonly<Record<string, number>>;
  readonly httpStatusCodeCounts: Readonly<Record<string, number>>;
  readonly quoteLatestAttemptOutcomeCounts: Readonly<Record<string, number>>;
  readonly quoteLastSuccessfulProviderCounts: Readonly<Record<string, number>>;
  readonly quoteLatestVsLastSuccessDivergenceCounts: Readonly<Record<string, number>>;
  readonly heliusEvidenceSourceCounts: Readonly<Record<string, number>>;
  readonly heliusCacheStatusCounts: Readonly<Record<string, number>>;
  readonly birdeyeEndpointCounts: Readonly<Record<string, number>>;
  readonly birdeyeCacheStatusCounts: Readonly<Record<string, number>>;
  readonly birdeyeFailureCategoryCounts: Readonly<Record<string, number>>;
  readonly birdeyeSelectionReasonCounts: Readonly<Record<string, number>>;
  readonly birdeyeBudgetReasonCounts: Readonly<Record<string, number>>;
}

export function classifyProviderHealthRow(row: ProviderHealthRecord): ProviderPressureClass {
  if (row.status === "DISABLED") {
    return "DISABLED";
  }

  const context = readProviderHealthContext(row);
  const quoteSource = readString(context.quoteSource);
  const quoteDemandAction = readString(context.quoteDemandAction);
  const heliusEvidenceSource = readString(context.heliusEvidenceSource);
  const rpcCacheStatus = readString(context.rpcCacheStatus);
  const birdeyeCacheStatus = readString(context.birdeyeCacheStatus);

  if (quoteDemandAction === "SUCCESS_CACHE_HIT") {
    return "ROUTER_CACHE";
  }

  if (quoteDemandAction === "COOLDOWN_SKIP") {
    return "ROUTER_COOLDOWN";
  }

  if (quoteDemandAction) {
    return "ROUTER_OTHER";
  }

  if (
    quoteSource === "CACHE" ||
    heliusEvidenceSource === "CACHE" ||
    rpcCacheStatus === "HIT" ||
    birdeyeCacheStatus === "HIT"
  ) {
    return "ROUTER_CACHE";
  }

  if (quoteSource === "SKIPPED_COOLDOWN" || heliusEvidenceSource === "SKIPPED_COOLDOWN") {
    return "ROUTER_COOLDOWN";
  }

  if (quoteSource === "UNAVAILABLE") {
    return "ROUTER_UNAVAILABLE";
  }

  if (quoteSource) {
    return "ROUTER_OTHER";
  }

  return "LIVE_PROVIDER";
}

export function summarizeProviderPressureMetrics(
  rows: readonly ProviderHealthRecord[],
): ProviderPressureMetrics {
  const statusCounts = createEmptyStatusCounts();
  let liveRows = 0;
  let routerRows = 0;
  let liveOk = 0;
  let liveDegraded = 0;
  let liveRateLimited = 0;
  let liveError = 0;
  let routerCacheHits = 0;
  let routerCooldownSkips = 0;
  let routerUnavailable = 0;
  const quoteSourceTypeCounts: Record<string, number> = {};
  const quoteFallbackReasonCounts: Record<string, number> = {};
  const quoteDemandActionCounts: Record<string, number> = {};
  const quoteNegativeCacheReasonCounts: Record<string, number> = {};
  const raydiumVenueGuardDecisionCounts: Record<string, number> = {};
  const raydiumVenueGuardReasonCounts: Record<string, number> = {};
  let quoteSchedulerWaitMsTotal = 0;
  let quoteSingleFlightJoinCount = 0;
  let quoteNegativeCacheHitCount = 0;
  let liveQuoteCallsAvoidedEstimate = 0;
  const jupiterDemandActionCounts: Record<string, number> = {};
  const jupiterDemandOperationCounts: Record<string, number> = {};
  const jupiterDemandPriorityCounts: Record<string, number> = {};
  let jupiterDemandDeferredCount = 0;
  let jupiterLiveAllowedCount = 0;
  let jupiterControllerRateLimitObservedCount = 0;
  let jupiterEffectiveIntervalMsTotal = 0;
  let jupiterEffectiveIntervalMsCount = 0;
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
  const raydiumFailureDetailCounts: Record<string, number> = {};
  const raydiumPreflightStatusCounts: Record<string, number> = {};
  const raydiumPreflightFailureDetailCounts: Record<string, number> = {};
  const httpEndpointIdCounts: Record<string, number> = {};
  const httpAttemptOutcomeCounts: Record<string, number> = {};
  const httpStatusCodeCounts: Record<string, number> = {};
  const quoteLatestAttemptOutcomeCounts: Record<string, number> = {};
  const quoteLastSuccessfulProviderCounts: Record<string, number> = {};
  const quoteLatestVsLastSuccessDivergenceCounts: Record<string, number> = {};
  const heliusEvidenceSourceCounts: Record<string, number> = {};
  const heliusCacheStatusCounts: Record<string, number> = {};
  const birdeyeEndpointCounts: Record<string, number> = {};
  const birdeyeCacheStatusCounts: Record<string, number> = {};
  const birdeyeFailureCategoryCounts: Record<string, number> = {};
  const birdeyeSelectionReasonCounts: Record<string, number> = {};
  const birdeyeBudgetReasonCounts: Record<string, number> = {};

  for (const row of rows) {
    statusCounts[row.status] += 1;
    const classification = classifyProviderHealthRow(row);
    const context = readProviderHealthContext(row);
    incrementCount(quoteSourceTypeCounts, readString(context.quoteSourceType));
    incrementCount(quoteFallbackReasonCounts, readString(context.quoteFallbackReason));
    const quoteDemandAction = readString(context.quoteDemandAction);
    incrementCount(quoteDemandActionCounts, quoteDemandAction);
    incrementCount(quoteNegativeCacheReasonCounts, readString(context.quoteNegativeCacheReason));
    incrementCount(raydiumVenueGuardDecisionCounts, readString(context.raydiumVenueGuardDecision));
    incrementCount(raydiumVenueGuardReasonCounts, readString(context.raydiumVenueGuardReason));
    quoteSchedulerWaitMsTotal += readNumber(context.quoteSchedulerWaitMs) ?? 0;
    if (context.quoteSingleFlightJoined === true) quoteSingleFlightJoinCount += 1;
    if (quoteDemandAction === "NEGATIVE_CACHE_HIT") quoteNegativeCacheHitCount += 1;
    if (
      quoteDemandAction === "SUCCESS_CACHE_HIT" ||
      quoteDemandAction === "NEGATIVE_CACHE_HIT" ||
      quoteDemandAction === "COOLDOWN_SKIP" ||
      quoteDemandAction === "VENUE_GUARD_SKIP" ||
      quoteDemandAction === "SINGLE_FLIGHT_JOIN"
    ) {
      liveQuoteCallsAvoidedEstimate += 1;
    }
    if (isJupiterDemandMeasurement(context)) {
      const jupiterDemandAction = readString(context.jupiterDemandAction);
      incrementCount(jupiterDemandActionCounts, jupiterDemandAction);
      incrementCount(jupiterDemandOperationCounts, readString(context.jupiterDemandOperation));
      incrementCount(jupiterDemandPriorityCounts, readString(context.jupiterDemandPriority));
      if (jupiterDemandAction?.startsWith("DEFERRED_")) {
        jupiterDemandDeferredCount += 1;
      }
      if (jupiterDemandAction === "LIVE_ALLOWED") {
        jupiterLiveAllowedCount += 1;
      }
      if (context.jupiterControllerRateLimitObserved === true) {
        jupiterControllerRateLimitObservedCount += 1;
      }
      const intervalMs = readNumber(context.jupiterEffectiveIntervalMs);
      if (intervalMs !== undefined) {
        jupiterEffectiveIntervalMsTotal += intervalMs;
        jupiterEffectiveIntervalMsCount += 1;
      }
      jupiterAdaptiveLevelMax = Math.max(
        jupiterAdaptiveLevelMax,
        readNumber(context.jupiterAdaptiveLevel) ?? 0,
      );
      jupiterSharedWindowUsageMax = Math.max(
        jupiterSharedWindowUsageMax,
        readNumber(context.jupiterSharedWindowUsage) ?? 0,
      );
    }
    incrementCount(authorityEvidenceSourceCounts, readString(context.authorityEvidenceSource));
    incrementCount(mintAuthorityStateCounts, readString(context.mintAuthorityState));
    incrementCount(freezeAuthorityStateCounts, readString(context.freezeAuthorityState));
    incrementCount(rpcCacheStatusCounts, readString(context.rpcCacheStatus));
    incrementCount(rpcFailureCategoryCounts, readString(context.rpcFailureCategory));
    incrementCount(dasProviderCounts, readString(context.dasProvider));
    incrementCount(dasFailureCategoryCounts, readString(context.dasFailureCategory));
    incrementCount(raydiumFailureCategoryCounts, readString(context.raydiumFailureCategory));
    incrementCount(raydiumFailureDetailCounts, readString(context.raydiumFailureDetail));
    incrementCount(raydiumPreflightStatusCounts, readString(context.raydiumPreflightStatus));
    incrementCount(
      raydiumPreflightFailureDetailCounts,
      readString(context.raydiumPreflightFailureDetail),
    );
    incrementPipeCounts(httpEndpointIdCounts, readString(context.httpEndpointIds));
    incrementPipeCounts(httpAttemptOutcomeCounts, readString(context.httpAttemptOutcomes));
    incrementPipeCounts(httpStatusCodeCounts, readString(context.httpStatusCodes));
    incrementCount(quoteLatestAttemptOutcomeCounts, readString(context.quoteLatestAttemptOutcome));
    incrementCount(
      quoteLastSuccessfulProviderCounts,
      readString(context.quoteLastSuccessfulProvider),
    );
    incrementCount(
      quoteLatestVsLastSuccessDivergenceCounts,
      readBooleanString(context.quoteLatestVsLastSuccessDivergence),
    );
    incrementCount(heliusEvidenceSourceCounts, readString(context.heliusEvidenceSource));
    incrementCount(heliusCacheStatusCounts, readString(context.heliusCacheStatus));
    incrementCount(birdeyeEndpointCounts, readString(context.birdeyeEndpoint));
    incrementCount(birdeyeCacheStatusCounts, readString(context.birdeyeCacheStatus));
    incrementCount(birdeyeFailureCategoryCounts, readString(context.birdeyeFailureCategory));
    incrementCount(birdeyeSelectionReasonCounts, readString(context.birdeyeSelectionReason));
    incrementCount(birdeyeBudgetReasonCounts, readString(context.birdeyeBudgetReason));

    switch (classification) {
      case "LIVE_PROVIDER":
        liveRows += 1;
        if (row.status === "OK") {
          liveOk += 1;
        } else if (row.status === "DEGRADED") {
          liveDegraded += 1;
        } else if (row.status === "RATE_LIMITED") {
          liveRateLimited += 1;
        } else if (row.status === "ERROR") {
          liveError += 1;
        }
        break;
      case "ROUTER_CACHE":
        routerRows += 1;
        routerCacheHits += 1;
        break;
      case "ROUTER_COOLDOWN":
        routerRows += 1;
        routerCooldownSkips += 1;
        break;
      case "ROUTER_UNAVAILABLE":
        routerRows += 1;
        routerUnavailable += 1;
        break;
      case "ROUTER_OTHER":
        routerRows += 1;
        break;
      case "DISABLED":
        break;
    }
  }

  return {
    totalRows: rows.length,
    liveRows,
    routerRows,
    statusCounts,
    liveOk,
    liveDegraded,
    liveRateLimited,
    liveError,
    liveRateLimitedPct: percent(liveRateLimited, liveRows),
    liveErrorPct: percent(liveError, liveRows),
    routerCacheHits,
    routerCooldownSkips,
    routerUnavailable,
    routerCooldownSkipPct: percent(routerCooldownSkips, routerRows),
    combinedRateLimitedPct: percent(statusCounts.RATE_LIMITED, rows.length),
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
      jupiterEffectiveIntervalMsCount === 0
        ? 0
        : jupiterEffectiveIntervalMsTotal / jupiterEffectiveIntervalMsCount,
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
    raydiumFailureDetailCounts,
    raydiumPreflightStatusCounts,
    raydiumPreflightFailureDetailCounts,
    httpEndpointIdCounts,
    httpAttemptOutcomeCounts,
    httpStatusCodeCounts,
    quoteLatestAttemptOutcomeCounts,
    quoteLastSuccessfulProviderCounts,
    quoteLatestVsLastSuccessDivergenceCounts,
    heliusEvidenceSourceCounts,
    heliusCacheStatusCounts,
    birdeyeEndpointCounts,
    birdeyeCacheStatusCounts,
    birdeyeFailureCategoryCounts,
    birdeyeSelectionReasonCounts,
    birdeyeBudgetReasonCounts,
  };
}

function isJupiterDemandMeasurement(context: Readonly<Record<string, unknown>>): boolean {
  if (!readString(context.jupiterDemandAction)) {
    return false;
  }

  return (
    readString(context.quoteDemandAction) !== undefined ||
    readString(context.operation) === "price" ||
    readString(context.operation) === "token-metadata-from-price"
  );
}

export function readProviderHealthContext(
  row: ProviderHealthRecord,
): Readonly<Record<string, unknown>> {
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

function createEmptyStatusCounts(): Record<ProviderStatus, number> {
  return Object.fromEntries(providerStatusValues.map((status) => [status, 0])) as Record<
    ProviderStatus,
    number
  >;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function incrementCount(counts: Record<string, number>, key: string | undefined): void {
  if (!key) {
    return;
  }

  counts[key] = (counts[key] ?? 0) + 1;
}

function incrementPipeCounts(counts: Record<string, number>, value: string | undefined): void {
  if (!value) {
    return;
  }

  for (const part of value.split("|")) {
    const trimmed = part.trim();

    if (!trimmed) {
      continue;
    }

    const match = /^(.+):(\d+)$/.exec(trimmed);

    if (match) {
      const key = match[1];
      const value = match[2];

      if (key && value) {
        counts[key] = (counts[key] ?? 0) + Number.parseInt(value, 10);
      }
    } else {
      counts[trimmed] = (counts[trimmed] ?? 0) + 1;
    }
  }
}

function readBooleanString(value: unknown): string | undefined {
  return typeof value === "boolean" ? String(value) : readString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}
