import crypto from "node:crypto";
import type {
  MarketObservationRecord,
  MeasurementWindow,
  PriceSourceType,
} from "./TelemetryTypes.js";
import type { TelemetryStorageManager } from "./TelemetryStorageManager.js";
import { resolveStrategyRevision } from "./RevisionHelper.js";

export interface RecordObservationInput {
  readonly sessionId: string;
  readonly generationId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly sourceTimestampMs: number;
  readonly ingestionTimestampMs?: number | undefined;
  readonly requestInitiatedMs?: number | undefined;
  readonly responseReceivedMs?: number | undefined;
  readonly measurementWindow: MeasurementWindow;
  readonly derivationStatus?:
    | "RAW"
    | "DERIVED_FROM_5M"
    | "DERIVED_FROM_1H"
    | "DIRECT_OBSERVATION"
    | undefined;
  readonly providerIdentity: string;
  readonly actualResponsePoolId?: string | undefined;
  readonly priceMetrics: {
    readonly spotPriceUsd: number | null;
    readonly spotPriceSol: number | null;
    readonly priceSource: PriceSourceType;
  };
  readonly liquidityMetrics: {
    readonly baseReserve: number | null;
    readonly quoteReserve: number | null;
    readonly liquidityUsd: number | null;
  };
  readonly flowMetrics: {
    readonly txCount: number | null;
    readonly buys: number | null;
    readonly sells: number | null;
    readonly volumeUsd: number | null;
    readonly netBuyerVolumeUsd: number | null;
  };
  readonly holderMetrics?:
    | {
        readonly top10ConcentrationPct: number;
        readonly devHoldingPct: number;
        readonly totalHolders: number;
      }
    | undefined;
  readonly missingFields?: readonly string[] | undefined;
}

export class MarketObservationRecorder {
  private readonly storage: TelemetryStorageManager;
  private readonly recentObservations = new Map<string, MarketObservationRecord[]>();
  private readonly maxCachedPerMint = 50;

  constructor(storage: TelemetryStorageManager) {
    this.storage = storage;
  }

  public recordObservation(input: RecordObservationInput): MarketObservationRecord {
    const ingestionTimestampMs =
      input.ingestionTimestampMs ?? input.responseReceivedMs ?? Date.now();
    const observationId = crypto.randomUUID();

    // 1. Validate Measurement Window Boundaries
    const { windowStartMs, windowEndMs } = input.measurementWindow;
    if (windowStartMs > windowEndMs) {
      throw new Error(
        `[MarketObservationRecorder] [FATAL_INVALID_MEASUREMENT_WINDOW] windowStartMs (${windowStartMs}) must be <= windowEndMs (${windowEndMs}).`,
      );
    }
    if (windowEndMs > input.sourceTimestampMs + 5000) {
      throw new Error(
        `[MarketObservationRecorder] [FATAL_INVALID_MEASUREMENT_WINDOW] windowEndMs (${windowEndMs}) cannot exceed sourceTimestampMs (${input.sourceTimestampMs}) by more than clock tolerance.`,
      );
    }

    // 2. Validate Clock Skew & Freshness
    let clockSkewWarning: string | undefined;
    if (input.sourceTimestampMs > ingestionTimestampMs + 5000) {
      clockSkewWarning = `[WARN_CLOCK_SKEW_FUTURE_SOURCE] sourceTimestampMs (${input.sourceTimestampMs}) is ahead of ingestion clock (${ingestionTimestampMs})`;
    }

    const dataFreshnessMs = Math.max(0, ingestionTimestampMs - input.sourceTimestampMs);

    const record: MarketObservationRecord = {
      observationId,
      sessionId: input.sessionId,
      generationId: input.generationId,
      mintAddress: input.mintAddress,
      poolId: input.poolId,
      sourceTimestampMs: input.sourceTimestampMs,
      ingestionTimestampMs,
      requestInitiatedMs: input.requestInitiatedMs,
      responseReceivedMs: input.responseReceivedMs,
      dataFreshnessMs,
      measurementWindow: input.measurementWindow,
      derivationStatus: input.derivationStatus ?? "RAW",
      providerIdentity: input.providerIdentity,
      actualResponsePoolId: input.actualResponsePoolId ?? input.poolId,
      priceMetrics: input.priceMetrics,
      liquidityMetrics: input.liquidityMetrics,
      flowMetrics: input.flowMetrics,
      holderMetrics: input.holderMetrics,
      missingFields: input.missingFields ?? [],
      strategyRevision: resolveStrategyRevision(),
      clockSkewWarning,
    };

    this.storage.appendMarketObservation(record);

    // Update in-memory ring buffer (keyed by pool:mint to avoid multi-pool collision)
    const key = `${input.poolId}:${input.mintAddress}`;
    const list = this.recentObservations.get(key) ?? [];
    list.push(record);
    if (list.length > this.maxCachedPerMint) {
      list.shift();
    }
    this.recentObservations.set(key, list);

    return record;
  }

  public getCachedObservations(
    mintAddress: string,
    poolId?: string,
  ): readonly MarketObservationRecord[] {
    if (poolId) {
      return this.recentObservations.get(`${poolId}:${mintAddress}`) ?? [];
    }
    // Return all observations matching mint
    const results: MarketObservationRecord[] = [];
    for (const [k, v] of this.recentObservations.entries()) {
      if (k.endsWith(`:${mintAddress}`)) {
        results.push(...v);
      }
    }
    return results;
  }
}
