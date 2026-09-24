import type { AnalyticsReadRepositories } from "./AnalyticsReadRepositories.js";
import { readStrategySnapshot, readQuoteBudgetProjection } from "./AnalyticsJsonReaders.js";
import { buildQuoteBudgetReport } from "./AnalyticsQuoteBudget.js";
import type {
  ProviderHealthRecord,
  SessionRecord,
  StrategyDecisionRecord,
  WatchlistReturnObservationRecord,
} from "../db/schema/index.js";
import {
  orderStatusValues,
  positionStatusValues,
  providerStatusValues,
  riskResultValues,
  strategyDecisionValues,
  tokenRadarStatusValues,
  watchlistReturnStatusValues,
} from "../db/schema/index.js";
import { nowMs } from "../db/utils/timestamps.js";
import {
  readProviderHealthContext,
  summarizeProviderPressureMetrics,
} from "../providers/ProviderPressureClassifier.js";
import type { AnalyticsRuntimeConfig } from "./AnalyticsConfig.js";

const MAX_REPORT_ROWS = 10_000;

export type * from "./AnalyticsReportTypes.js";
import type {
  AnalyticsReport,
  SessionReport,
  ScoreBucketReport,
  NearMissReport,
  MissedOpportunityReport,
  ProviderHealthReport,
} from "./AnalyticsReportTypes.js";
export interface AnalyticsReportServiceOptions {
  readonly config: AnalyticsRuntimeConfig;
  readonly repositories: AnalyticsReadRepositories;
  readonly clock?: () => number;
}

export class AnalyticsReportService {
  private readonly clock: () => number;

  constructor(private readonly options: AnalyticsReportServiceOptions) {
    this.clock = options.clock ?? nowMs;
  }

  generate(): AnalyticsReport {
    const generatedAtMs = this.clock();
    const session = this.resolveSession();
    const fromMs = generatedAtMs - this.options.config.sinceHours * 60 * 60 * 1000;
    const providerFromMs = generatedAtMs - this.options.config.providerSinceHours * 60 * 60 * 1000;
    const tokenRadarRows = this.options.repositories.tokenRadar.listRadarEntries(session.id, {
      limit: MAX_REPORT_ROWS,
    });
    const riskRows = this.options.repositories.riskAssessments.listRiskAssessments(session.id, {
      limit: MAX_REPORT_ROWS,
    });
    const strategyRows = this.options.repositories.strategyDecisions.listStrategyDecisions(
      session.id,
      {
        limit: MAX_REPORT_ROWS,
      },
    );
    const orders = this.options.repositories.orders.listOrders(session.id, {
      limit: MAX_REPORT_ROWS,
    });
    const fills = this.options.repositories.fills.listFillsForSession(session.id);
    const openPositions = this.options.repositories.positions.listOpenPositions(session.id);
    const closedPositions = this.options.repositories.positions.listClosedPositions(session.id);
    const equitySnapshots = this.options.repositories.snapshots.listEquitySnapshots(session.id, {
      limit: MAX_REPORT_ROWS,
    });
    const watchlistReturns = this.options.repositories.watchlistReturns.listObservations(
      session.id,
      {
        limit: MAX_REPORT_ROWS,
      },
    );
    const providerHealth = this.options.repositories.providerHealth.listProviderHealth({
      fromMs: providerFromMs,
      limit: MAX_REPORT_ROWS,
    });
    const recentStrategyRows = strategyRows.filter((decision) => decision.decidedAtMs >= fromMs);

    return {
      generatedAtMs,
      session: toSessionReport(session),
      funnel: {
        tokenRadarTotal: tokenRadarRows.length,
        tokenRadarByStatus: countBy(tokenRadarRows, (row) => row.status, tokenRadarStatusValues),
        riskAssessmentTotal: riskRows.length,
        riskByResult: countBy(riskRows, (row) => row.result, riskResultValues),
        strategyDecisionTotal: strategyRows.length,
        strategyByDecision: countBy(strategyRows, (row) => row.decision, strategyDecisionValues),
        orderTotal: orders.length,
        ordersByStatus: countBy(orders, (row) => row.status, orderStatusValues),
        fillTotal: fills.length,
        positionsByStatus: mergeCounts(
          countBy(openPositions, (row) => row.status, positionStatusValues),
          countBy(closedPositions, (row) => row.status, positionStatusValues),
        ),
        equitySnapshotTotal: equitySnapshots.length,
        watchlistReturnTotal: watchlistReturns.length,
        watchlistReturnsByStatus: countBy(
          watchlistReturns,
          (row) => row.status,
          watchlistReturnStatusValues,
        ),
      },
      scoreBuckets: buildScoreBuckets(recentStrategyRows, this.options.config.scoreBucketSize),
      nearMisses: buildNearMisses(recentStrategyRows, this.options.config.nearMissMinScore).slice(
        0,
        this.options.config.limit,
      ),
      missedOpportunities: buildMissedOpportunities(
        strategyRows,
        watchlistReturns,
        this.options.config.missedOpportunityLimit,
      ),
      quoteBudget: buildQuoteBudgetReport(
        riskRows.map((row) => readQuoteBudgetProjection(row.rawProviderDataJson).value),
      ),
      providerHealth: buildProviderHealthReports(providerHealth),
      jupiterRateLimitSummary: buildProviderHealthReports(providerHealth).find(
        (report) => report.provider === "JUPITER" && report.operation === undefined,
      ),
    };
  }

  private resolveSession(): SessionRecord {
    if (this.options.config.sessionId) {
      const session = this.options.repositories.sessions.getSessionById(
        this.options.config.sessionId,
      );

      if (!session) {
        throw new Error(`Analytics session not found: ${this.options.config.sessionId}`);
      }

      if (session.mode !== "PAPER") {
        throw new Error(
          `Analytics requires a PAPER session. Session ${session.id} is ${session.mode}.`,
        );
      }

      return session;
    }

    for (const session of this.options.repositories.sessions.listSessions({
      mode: "PAPER",
      limit: 100,
    })) {
      const hasRadar =
        this.options.repositories.tokenRadar.listRadarEntries(session.id, { limit: 1 }).length > 0;
      const hasDecisions =
        this.options.repositories.strategyDecisions.listStrategyDecisions(session.id, {
          limit: 1,
        }).length > 0;

      if (hasRadar || hasDecisions) {
        return session;
      }
    }

    throw new Error(
      "No PAPER session with TokenRadar or StrategyDecision rows was found. Run scanner/strategy first or pass --session-id.",
    );
  }
}

function toSessionReport(session: SessionRecord): SessionReport {
  return {
    id: session.id,
    mode: session.mode,
    status: session.status,
    startingBalanceLamports: session.startingBalanceLamports,
    currentCashLamports: session.currentCashLamports,
    targetProfitLamports: session.targetProfitLamports,
    targetProfitBps: session.targetProfitBps,
    maxDrawdownLamports: session.maxDrawdownLamports,
    realizedPnlLamports: session.realizedPnlLamports,
    unrealizedPnlLamports: session.unrealizedPnlLamports,
    terminationReason: session.terminationReason,
    startedAtMs: session.startedAtMs,
    endedAtMs: session.endedAtMs,
    createdAtMs: session.createdAtMs,
    updatedAtMs: session.updatedAtMs,
  };
}

function buildScoreBuckets(
  decisions: readonly StrategyDecisionRecord[],
  bucketSize: number,
): readonly ScoreBucketReport[] {
  const buckets = new Map<number, ScoreBucketReport>();

  for (const decision of decisions) {
    if (decision.score === null) {
      continue;
    }

    const bucketStart = Math.floor(decision.score / bucketSize) * bucketSize;
    const bucketEnd = Math.min(100, bucketStart + bucketSize - 1);
    const existing =
      buckets.get(bucketStart) ??
      ({
        bucket: `${bucketStart}-${bucketEnd}`,
        total: 0,
        buyCount: 0,
        watchCount: 0,
        skipCount: 0,
      } satisfies ScoreBucketReport);

    buckets.set(bucketStart, {
      ...existing,
      total: existing.total + 1,
      buyCount: existing.buyCount + (decision.decision === "BUY" ? 1 : 0),
      watchCount: existing.watchCount + (decision.decision === "WATCH" ? 1 : 0),
      skipCount: existing.skipCount + (decision.decision === "SKIP" ? 1 : 0),
    });
  }

  return [...buckets.entries()].sort(([left], [right]) => left - right).map(([, report]) => report);
}

function buildNearMisses(
  decisions: readonly StrategyDecisionRecord[],
  minScore: number,
): readonly NearMissReport[] {
  return decisions
    .filter((decision) => decision.decision !== "BUY")
    .filter((decision) => (decision.score ?? -1) >= minScore)
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1))
    .map((decision) => {
      const snapshot = readStrategySnapshot(decision);

      return {
        decidedAtMs: decision.decidedAtMs,
        mintAddress: decision.mintAddress,
        symbol: snapshot.symbol,
        decision: decision.decision,
        score: decision.score,
        reason: decision.reason,
        riskResult: snapshot.riskResult,
        riskFlags: snapshot.riskFlags,
        blockingFactors: snapshot.blockingFactors,
        liquidityUsd: snapshot.liquidityUsd,
        volume1hUsd: snapshot.volume1hUsd,
        ageSeconds: snapshot.ageSeconds,
        maxPriceImpactPct: snapshot.maxPriceImpactPct,
      };
    });
}

function buildMissedOpportunities(
  decisions: readonly StrategyDecisionRecord[],
  observations: readonly WatchlistReturnObservationRecord[],
  limit: number,
): readonly MissedOpportunityReport[] {
  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
  const observationsByDecision = new Map<string, WatchlistReturnObservationRecord[]>();

  for (const observation of observations) {
    if (observation.status !== "OBSERVED") {
      continue;
    }

    const group = observationsByDecision.get(observation.strategyDecisionId) ?? [];
    group.push(observation);
    observationsByDecision.set(observation.strategyDecisionId, group);
  }

  const reports: MissedOpportunityReport[] = [];

  for (const [strategyDecisionId, groupedObservations] of observationsByDecision.entries()) {
    const decision = decisionById.get(strategyDecisionId);

    if (!decision || decision.decision === "BUY") {
      continue;
    }

    const returnsByHorizon = buildReturnsByHorizon(groupedObservations);
    const best = findBestReturn(groupedObservations);

    if (!best || best.returnPct <= 0) {
      continue;
    }

    const snapshot = readStrategySnapshot(decision);

    reports.push({
      mintAddress: decision.mintAddress,
      symbol: snapshot.symbol,
      decision: decision.decision,
      score: decision.score,
      reason: decision.reason,
      riskResult: snapshot.riskResult,
      blockingFactors: snapshot.blockingFactors,
      baselinePriceSol: groupedObservations[0]?.baselinePriceSol ?? undefined,
      returnsByHorizon,
      bestHorizonMinutes: best.horizonMinutes,
      bestReturnPct: best.returnPct.toString(),
    });
  }

  return reports.sort(compareMissedOpportunities).slice(0, limit);
}

function buildProviderHealthReports(
  rows: readonly ProviderHealthRecord[],
): readonly ProviderHealthReport[] {
  const byProvider = groupProviderHealth(rows, (row) => row.provider);
  const byProviderOperation = groupProviderHealth(rows, (row) => {
    const operation = readProviderOperation(row);
    return operation ? `${row.provider}:${operation}` : undefined;
  });

  return [
    ...[...byProvider.entries()].map(([provider, group]) =>
      toProviderHealthReport(provider, undefined, group),
    ),
    ...[...byProviderOperation.entries()].map(([key, group]) => {
      const [provider = key, operation] = key.split(":");
      return toProviderHealthReport(provider, operation, group);
    }),
  ].sort((left, right) =>
    `${left.provider}:${left.operation ?? ""}`.localeCompare(
      `${right.provider}:${right.operation ?? ""}`,
    ),
  );
}

function toProviderHealthReport(
  provider: string,
  operation: string | undefined,
  rows: readonly ProviderHealthRecord[],
): ProviderHealthReport {
  const statusCounts = countBy(rows, (row) => row.status, providerStatusValues);
  const pressure = summarizeProviderPressureMetrics(rows);
  const latest = [...rows].sort((left, right) => right.timestampMs - left.timestampMs)[0];

  return {
    provider,
    operation,
    total: rows.length,
    statusCounts,
    okPercent: percent(statusCounts.OK ?? 0, rows.length),
    degradedPercent: percent(statusCounts.DEGRADED ?? 0, rows.length),
    rateLimitedPercent: percent(statusCounts.RATE_LIMITED ?? 0, rows.length),
    errorPercent: percent(statusCounts.ERROR ?? 0, rows.length),
    liveRows: pressure.liveRows,
    routerRows: pressure.routerRows,
    liveRateLimitedPercent: pressure.liveRateLimitedPct,
    liveErrorPercent: pressure.liveErrorPct,
    routerCacheHits: pressure.routerCacheHits,
    routerCooldownSkips: pressure.routerCooldownSkips,
    routerUnavailable: pressure.routerUnavailable,
    routerCooldownSkipPercent: pressure.routerCooldownSkipPct,
    combinedRateLimitedPercent: pressure.combinedRateLimitedPct,
    quoteSourceTypeCounts: pressure.quoteSourceTypeCounts,
    quoteFallbackReasonCounts: pressure.quoteFallbackReasonCounts,
    quoteDemandActionCounts: pressure.quoteDemandActionCounts,
    quoteSchedulerWaitMsTotal: pressure.quoteSchedulerWaitMsTotal,
    quoteSingleFlightJoinCount: pressure.quoteSingleFlightJoinCount,
    quoteNegativeCacheHitCount: pressure.quoteNegativeCacheHitCount,
    quoteNegativeCacheReasonCounts: pressure.quoteNegativeCacheReasonCounts,
    raydiumVenueGuardDecisionCounts: pressure.raydiumVenueGuardDecisionCounts,
    raydiumVenueGuardReasonCounts: pressure.raydiumVenueGuardReasonCounts,
    liveQuoteCallsAvoidedEstimate: pressure.liveQuoteCallsAvoidedEstimate,
    jupiterDemandActionCounts: pressure.jupiterDemandActionCounts,
    jupiterDemandOperationCounts: pressure.jupiterDemandOperationCounts,
    jupiterDemandPriorityCounts: pressure.jupiterDemandPriorityCounts,
    jupiterDemandDeferredCount: pressure.jupiterDemandDeferredCount,
    jupiterLiveAllowedCount: pressure.jupiterLiveAllowedCount,
    jupiterControllerRateLimitObservedCount: pressure.jupiterControllerRateLimitObservedCount,
    jupiterEffectiveIntervalMsAverage: pressure.jupiterEffectiveIntervalMsAverage,
    jupiterAdaptiveLevelMax: pressure.jupiterAdaptiveLevelMax,
    jupiterSharedWindowUsageMax: pressure.jupiterSharedWindowUsageMax,
    authorityEvidenceSourceCounts: pressure.authorityEvidenceSourceCounts,
    mintAuthorityStateCounts: pressure.mintAuthorityStateCounts,
    freezeAuthorityStateCounts: pressure.freezeAuthorityStateCounts,
    rpcCacheStatusCounts: pressure.rpcCacheStatusCounts,
    rpcFailureCategoryCounts: pressure.rpcFailureCategoryCounts,
    dasProviderCounts: pressure.dasProviderCounts,
    dasFailureCategoryCounts: pressure.dasFailureCategoryCounts,
    raydiumFailureCategoryCounts: pressure.raydiumFailureCategoryCounts,
    raydiumPreflightStatusCounts: pressure.raydiumPreflightStatusCounts,
    heliusEvidenceSourceCounts: pressure.heliusEvidenceSourceCounts,
    heliusCacheStatusCounts: pressure.heliusCacheStatusCounts,
    birdeyeEndpointCounts: pressure.birdeyeEndpointCounts,
    birdeyeCacheStatusCounts: pressure.birdeyeCacheStatusCounts,
    birdeyeFailureCategoryCounts: pressure.birdeyeFailureCategoryCounts,
    birdeyeSelectionReasonCounts: pressure.birdeyeSelectionReasonCounts,
    birdeyeBudgetReasonCounts: pressure.birdeyeBudgetReasonCounts,
    latestStatus: latest?.status,
    latestErrorMessage: latest?.errorMessage,
  };
}

function groupProviderHealth(
  rows: readonly ProviderHealthRecord[],
  keyFn: (row: ProviderHealthRecord) => string | undefined,
): Map<string, ProviderHealthRecord[]> {
  const grouped = new Map<string, ProviderHealthRecord[]>();

  for (const row of rows) {
    const key = keyFn(row);

    if (!key) {
      continue;
    }

    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return grouped;
}

function readProviderOperation(row: ProviderHealthRecord): string | undefined {
  const operation = readProviderHealthContext(row).operation;

  return typeof operation === "string" && operation.trim() !== "" ? operation : undefined;
}

function buildReturnsByHorizon(
  observations: readonly WatchlistReturnObservationRecord[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    observations
      .map((observation) => [
        `${observation.horizonMinutes}m`,
        observation.returnPctSol ?? observation.returnPctUsd,
      ])
      .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined),
  );
}

function findBestReturn(
  observations: readonly WatchlistReturnObservationRecord[],
): { readonly horizonMinutes: number; readonly returnPct: number } | undefined {
  return observations
    .map((observation) => ({
      horizonMinutes: observation.horizonMinutes,
      returnPct: Number(observation.returnPctSol ?? observation.returnPctUsd),
    }))
    .filter((result) => Number.isFinite(result.returnPct))
    .sort((left, right) => right.returnPct - left.returnPct)[0];
}

function compareMissedOpportunities(
  left: MissedOpportunityReport,
  right: MissedOpportunityReport,
): number {
  return preferredReturn(right) - preferredReturn(left);
}

function preferredReturn(report: MissedOpportunityReport): number {
  return (
    parseReturn(report.returnsByHorizon["60m"]) ??
    parseReturn(report.returnsByHorizon["30m"]) ??
    Number(report.bestReturnPct)
  );
}

function parseReturn(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function countBy<T>(
  rows: readonly T[],
  getKey: (row: T) => string,
  initialKeys: readonly string[] = [],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = Object.fromEntries(initialKeys.map((key) => [key, 0]));

  for (const row of rows) {
    const key = getKey(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}

function mergeCounts(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const merged = { ...left };

  for (const [key, value] of Object.entries(right)) {
    merged[key] = (merged[key] ?? 0) + value;
  }

  return merged;
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}
