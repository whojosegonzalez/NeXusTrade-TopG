import { parseTokenMintAddress, type TokenEnrichmentSnapshot } from "@nexustrade/shared";

import type { Repositories } from "../db/repositories/index.js";
import type {
  SessionRecord,
  StrategyDecisionRecord,
  WatchlistReturnObservationRecord,
} from "../db/schema/index.js";
import { parseJson, stringifyJson } from "../db/utils/json.js";
import { nowMs } from "../db/utils/timestamps.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import type { WatchlistReturnRuntimeConfig } from "./WatchlistReturnConfig.js";

const MINUTE_MS = 60_000;

export interface WatchlistReturnSummary {
  readonly sessionId: string;
  readonly selectedStrategyDecisions: number;
  readonly scheduledCount: number;
  readonly alreadyScheduledCount: number;
  readonly dueCount: number;
  readonly observedCount: number;
  readonly missedCount: number;
  readonly failedCount: number;
  readonly dryRun: boolean;
}

export interface WatchlistReturnRunnerOptions {
  readonly config: WatchlistReturnRuntimeConfig;
  readonly repositories: Repositories;
  readonly marketDataService: Pick<MarketDataService, "enrichToken">;
  readonly clock?: () => number;
  /** Limits this invocation to pre-selected decisions without changing generic CLI defaults. */
  readonly strategyDecisionIds?: readonly string[];
}

interface BaselineSnapshot {
  readonly tokenRadarId?: string | undefined;
  readonly mintAddress: string;
  readonly pairAddress?: string | undefined;
  readonly symbol?: string | undefined;
  readonly priceSol?: string | undefined;
  readonly priceUsd?: string | undefined;
  readonly liquidityUsd?: string | undefined;
  readonly volume5mUsd?: string | undefined;
  readonly volume1hUsd?: string | undefined;
  readonly observedAtMs: number;
  readonly source: string;
}

interface MutableWatchlistReturnCounts {
  selectedStrategyDecisions: number;
  scheduledCount: number;
  alreadyScheduledCount: number;
  dueCount: number;
  observedCount: number;
  missedCount: number;
  failedCount: number;
}

export class WatchlistReturnRunner {
  private readonly clock: () => number;

  constructor(private readonly options: WatchlistReturnRunnerOptions) {
    this.clock = options.clock ?? nowMs;
  }

  async run(): Promise<WatchlistReturnSummary> {
    return this.runOnce();
  }

  async runOnce(): Promise<WatchlistReturnSummary> {
    const runStartedAtMs = this.clock();
    const session = this.resolveSession();
    const counts = createEmptyCounts();
    const decisions = this.selectDecisions(session, runStartedAtMs);

    counts.selectedStrategyDecisions = decisions.length;

    for (const decision of decisions) {
      this.scheduleDecision(session, decision, counts);
    }

    const dueObservations = this.options.repositories.watchlistReturns.listDueObservations(
      runStartedAtMs,
      {
        sessionId: session.id,
        limit: this.options.config.limit,
        ...(this.options.strategyDecisionIds
          ? { strategyDecisionIds: this.options.strategyDecisionIds }
          : {}),
      },
    );
    counts.dueCount = dueObservations.length;

    for (const observation of dueObservations) {
      await this.observeDueObservation(observation, runStartedAtMs, counts);
    }

    return {
      sessionId: session.id,
      selectedStrategyDecisions: counts.selectedStrategyDecisions,
      scheduledCount: counts.scheduledCount,
      alreadyScheduledCount: counts.alreadyScheduledCount,
      dueCount: counts.dueCount,
      observedCount: counts.observedCount,
      missedCount: counts.missedCount,
      failedCount: counts.failedCount,
      dryRun: this.options.config.dryRun,
    };
  }

  private resolveSession(): SessionRecord {
    if (this.options.config.sessionId) {
      const session = this.options.repositories.sessions.getSessionById(
        this.options.config.sessionId,
      );

      if (!session) {
        throw new Error(`Watchlist return session not found: ${this.options.config.sessionId}`);
      }

      if (session.mode !== "PAPER") {
        throw new Error(
          `Watchlist returns require a PAPER session. Session ${session.id} is ${session.mode}.`,
        );
      }

      return session;
    }

    for (const session of this.options.repositories.sessions.listSessions({
      mode: "PAPER",
      limit: 100,
    })) {
      if (
        this.options.repositories.strategyDecisions.listStrategyDecisions(session.id, {
          limit: 1,
        }).length > 0
      ) {
        return session;
      }
    }

    throw new Error(
      "No PAPER session with StrategyDecision rows was found. Run strategy evaluation first or pass --session-id.",
    );
  }

  private selectDecisions(
    session: SessionRecord,
    runStartedAtMs: number,
  ): readonly StrategyDecisionRecord[] {
    const selectedIds = this.options.strategyDecisionIds
      ? new Set(this.options.strategyDecisionIds)
      : undefined;
    const sinceMs = runStartedAtMs - this.options.config.sinceHours * 60 * MINUTE_MS;
    const sourceDecisions = new Set(this.options.config.sourceDecisions);

    return this.options.repositories.strategyDecisions
      .listStrategyDecisions(session.id, { limit: selectedIds ? 1_000 : this.options.config.limit })
      .filter((decision) =>
        selectedIds ? selectedIds.has(decision.id) : decision.decidedAtMs >= sinceMs,
      )
      .filter((decision) => (selectedIds ? true : sourceDecisions.has(decision.decision)))
      .filter((decision) =>
        selectedIds ? true : (decision.score ?? -1) >= this.options.config.minScore,
      )
      .sort(
        (left, right) => left.decidedAtMs - right.decidedAtMs || left.id.localeCompare(right.id),
      );
  }

  private scheduleDecision(
    session: SessionRecord,
    decision: StrategyDecisionRecord,
    counts: MutableWatchlistReturnCounts,
  ): void {
    const baseline = this.resolveBaseline(session, decision);
    const baselineMissing = baseline.priceSol === undefined && baseline.priceUsd === undefined;

    for (const horizonMinutes of this.options.config.horizonsMinutes) {
      const existing = this.options.repositories.watchlistReturns.getObservationByDecisionHorizon(
        decision.id,
        horizonMinutes,
      );

      if (existing) {
        counts.alreadyScheduledCount += 1;
        continue;
      }

      counts.scheduledCount += 1;

      if (baselineMissing) {
        counts.failedCount += 1;
      }

      if (this.options.config.dryRun) {
        continue;
      }

      this.options.repositories.watchlistReturns.createObservation({
        sessionId: session.id,
        strategyDecisionId: decision.id,
        tokenRadarId: baseline.tokenRadarId,
        mintAddress: baseline.mintAddress,
        pairAddress: baseline.pairAddress,
        symbol: baseline.symbol,
        decision: decision.decision,
        strategyName: decision.strategyName,
        strategyScore: decision.score,
        horizonMinutes,
        baselineObservedAtMs: baseline.observedAtMs,
        baselinePriceSol: baseline.priceSol,
        baselinePriceUsd: baseline.priceUsd,
        baselineLiquidityUsd: baseline.liquidityUsd,
        baselineVolume5mUsd: baseline.volume5mUsd,
        baselineVolume1hUsd: baseline.volume1hUsd,
        baselineSource: baseline.source,
        dueAtMs: decision.decidedAtMs + horizonMinutes * MINUTE_MS,
        status: baselineMissing ? "FAILED" : "PENDING",
        errorCode: baselineMissing ? "MISSING_BASELINE_PRICE" : undefined,
        errorMessage: baselineMissing
          ? "Strategy decision and TokenRadar fallback did not include a usable baseline price."
          : undefined,
        rawDataJson: stringifyJson({
          strategyDecisionId: decision.id,
          baselineSource: baseline.source,
        }),
      });
    }
  }

  private resolveBaseline(
    session: SessionRecord,
    decision: StrategyDecisionRecord,
  ): BaselineSnapshot {
    const snapshotBaseline = readBaselineFromStrategySnapshot(decision);

    if (snapshotBaseline.priceSol !== undefined || snapshotBaseline.priceUsd !== undefined) {
      return snapshotBaseline;
    }

    const tokenRadar = this.options.repositories.tokenRadar.findRadarEntryByMint(
      session.id,
      decision.mintAddress,
    );

    if (!tokenRadar) {
      return {
        ...snapshotBaseline,
        source: "MISSING_BASELINE_PRICE",
      };
    }

    return {
      tokenRadarId: tokenRadar.id,
      mintAddress: tokenRadar.mintAddress,
      pairAddress: tokenRadar.pairAddress ?? snapshotBaseline.pairAddress,
      symbol: tokenRadar.symbol ?? snapshotBaseline.symbol,
      priceSol: normalizeDecimalString(tokenRadar.priceSol),
      priceUsd: normalizeDecimalString(tokenRadar.priceUsd),
      liquidityUsd: normalizeDecimalString(tokenRadar.liquidityUsd),
      volume5mUsd: normalizeDecimalString(tokenRadar.volume5mUsd),
      volume1hUsd: normalizeDecimalString(tokenRadar.volume1hUsd),
      observedAtMs: tokenRadar.updatedAtMs,
      source: "TOKEN_RADAR_FALLBACK",
    };
  }

  private async observeDueObservation(
    observation: WatchlistReturnObservationRecord,
    runStartedAtMs: number,
    counts: MutableWatchlistReturnCounts,
  ): Promise<void> {
    if (runStartedAtMs > observation.dueAtMs + this.options.config.maxLateMinutes * MINUTE_MS) {
      counts.missedCount += 1;

      if (!this.options.config.dryRun) {
        this.options.repositories.watchlistReturns.markMissed(observation.id, {
          errorCode: "OBSERVATION_WINDOW_EXPIRED",
          errorMessage: `Observation was more than ${this.options.config.maxLateMinutes} minutes late.`,
        });
      }

      return;
    }

    let mintAddress;

    try {
      mintAddress = parseTokenMintAddress(observation.mintAddress);
    } catch (error) {
      counts.failedCount += 1;

      if (!this.options.config.dryRun) {
        this.options.repositories.watchlistReturns.markFailed(observation.id, {
          errorCode: "INVALID_MINT_ADDRESS",
          errorMessage: error instanceof Error ? error.message : "Invalid mint address.",
        });
      }

      return;
    }

    const enrichment = await this.options.marketDataService.enrichToken({ mintAddress });

    if (!enrichment.ok) {
      counts.failedCount += 1;

      if (!this.options.config.dryRun) {
        this.options.repositories.watchlistReturns.markFailed(observation.id, {
          errorCode: enrichment.rateLimited ? "PROVIDER_RATE_LIMITED" : "PROVIDER_ERROR",
          errorMessage: enrichment.error.message,
          rawDataJson: stringifyJson({
            provider: enrichment.provider,
            errorCode: enrichment.error.code,
            warnings: enrichment.warnings,
          }),
        });
      }

      return;
    }

    const observed = buildObservedSnapshot(enrichment.data);
    const returnPctSol = calculateReturnPercent(observation.baselinePriceSol, observed.priceSol);
    const returnPctUsd = calculateReturnPercent(observation.baselinePriceUsd, observed.priceUsd);

    if (returnPctSol === undefined && returnPctUsd === undefined) {
      counts.failedCount += 1;

      if (!this.options.config.dryRun) {
        this.options.repositories.watchlistReturns.markFailed(observation.id, {
          errorCode: "MISSING_OBSERVED_PRICE",
          errorMessage: "Provider enrichment did not return a usable observed price.",
          rawDataJson: stringifyJson({
            sourcesUsed: enrichment.data.sourcesUsed,
            warnings: enrichment.data.warnings,
          }),
        });
      }

      return;
    }

    counts.observedCount += 1;

    if (!this.options.config.dryRun) {
      this.options.repositories.watchlistReturns.markObserved(observation.id, {
        observedAtMs: enrichment.data.fetchedAt.getTime(),
        observedPriceSol: observed.priceSol,
        observedPriceUsd: observed.priceUsd,
        observedLiquidityUsd: observed.liquidityUsd,
        observedVolume5mUsd: observed.volume5mUsd,
        observedVolume1hUsd: observed.volume1hUsd,
        observedSource: observed.source,
        returnPctSol,
        returnPctUsd,
        rawDataJson: stringifyJson({
          sourcesUsed: enrichment.data.sourcesUsed,
          warnings: enrichment.data.warnings,
          price: enrichment.data.price,
          bestPair: enrichment.data.bestPair,
        }),
      });
    }
  }
}

function readBaselineFromStrategySnapshot(decision: StrategyDecisionRecord): BaselineSnapshot {
  const fallback: BaselineSnapshot = {
    mintAddress: decision.mintAddress,
    observedAtMs: decision.decidedAtMs,
    source: "MISSING_BASELINE_PRICE",
  };

  if (!decision.inputSnapshotJson) {
    return fallback;
  }

  try {
    const parsed = parseJson<unknown>(decision.inputSnapshotJson);
    const tokenRadar = getRecord(getRecord(parsed)?.tokenRadar);

    if (!tokenRadar) {
      return fallback;
    }

    return {
      tokenRadarId: readString(tokenRadar, "id"),
      mintAddress: readString(tokenRadar, "mintAddress") ?? decision.mintAddress,
      pairAddress: readString(tokenRadar, "pairAddress"),
      symbol: readString(tokenRadar, "symbol"),
      priceSol: normalizeDecimalString(readString(tokenRadar, "priceSol")),
      priceUsd: normalizeDecimalString(readString(tokenRadar, "priceUsd")),
      liquidityUsd: normalizeDecimalString(readString(tokenRadar, "liquidityUsd")),
      volume5mUsd: normalizeDecimalString(readString(tokenRadar, "volume5mUsd")),
      volume1hUsd: normalizeDecimalString(readString(tokenRadar, "volume1hUsd")),
      observedAtMs: readNumber(tokenRadar, "updatedAtMs") ?? decision.decidedAtMs,
      source: "STRATEGY_SNAPSHOT",
    };
  } catch {
    return fallback;
  }
}

function buildObservedSnapshot(enrichment: TokenEnrichmentSnapshot): {
  readonly priceSol?: string | undefined;
  readonly priceUsd?: string | undefined;
  readonly liquidityUsd?: string | undefined;
  readonly volume5mUsd?: string | undefined;
  readonly volume1hUsd?: string | undefined;
  readonly source: string;
} {
  return {
    priceSol: decimalFromNumber(enrichment.price?.priceSol ?? enrichment.bestPair?.priceNative),
    priceUsd: decimalFromNumber(enrichment.price?.priceUsd ?? enrichment.bestPair?.priceUsd),
    liquidityUsd: decimalFromNumber(enrichment.bestPair?.liquidityUsd),
    volume5mUsd: decimalFromNumber(enrichment.bestPair?.volume5m),
    volume1hUsd: decimalFromNumber(enrichment.bestPair?.volume1h),
    source:
      enrichment.price?.source ??
      enrichment.bestPair?.source ??
      enrichment.sourcesUsed[0] ??
      "UNKNOWN",
  };
}

function calculateReturnPercent(
  baselineValue: string | null | undefined,
  observedValue: string | undefined,
): string | undefined {
  const baseline = parsePositiveDecimal(baselineValue);
  const observed = parsePositiveDecimal(observedValue);

  if (baseline === undefined || observed === undefined) {
    return undefined;
  }

  return (((observed - baseline) / baseline) * 100).toString();
}

function parsePositiveDecimal(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeDecimalString(value: string | null | undefined): string | undefined {
  const parsed = parsePositiveDecimal(value);

  return parsed === undefined ? undefined : value?.trim();
}

function decimalFromNumber(value: number | undefined): string | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value.toString() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function createEmptyCounts(): MutableWatchlistReturnCounts {
  return {
    selectedStrategyDecisions: 0,
    scheduledCount: 0,
    alreadyScheduledCount: 0,
    dueCount: 0,
    observedCount: 0,
    missedCount: 0,
    failedCount: 0,
  };
}
