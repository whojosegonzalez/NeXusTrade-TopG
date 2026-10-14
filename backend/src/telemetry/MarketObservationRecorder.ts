import crypto from "node:crypto";
import type {
  MarketObservationRecord,
  MeasurementWindow,
  PriceSourceType,
} from "./TelemetryTypes.js";
import type { TelemetryStorageManager } from "./TelemetryStorageManager.js";

function getStrategyRevision(): string {
  return process.env.GIT_COMMIT || "7e58ea5";
}

export interface RecordObservationInput {
  readonly sessionId: string;
  readonly generationId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly sourceTimestampMs: number;
  readonly measurementWindow: MeasurementWindow;
  readonly providerIdentity: string;
  readonly priceMetrics: {
    readonly spotPriceUsd: number;
    readonly spotPriceSol: number;
    readonly priceSource: PriceSourceType;
  };
  readonly liquidityMetrics: {
    readonly baseReserve: number;
    readonly quoteReserve: number;
    readonly liquidityUsd: number;
  };
  readonly flowMetrics: {
    readonly txCount: number;
    readonly buys: number;
    readonly sells: number;
    readonly volumeUsd: number;
    readonly netBuyerVolumeUsd: number;
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
    const ingestionTimestampMs = Date.now();
    const observationId = crypto.randomUUID();
    const dataFreshnessMs = Math.max(0, ingestionTimestampMs - input.sourceTimestampMs);

    const record: MarketObservationRecord = {
      observationId,
      sessionId: input.sessionId,
      generationId: input.generationId,
      mintAddress: input.mintAddress,
      poolId: input.poolId,
      sourceTimestampMs: input.sourceTimestampMs,
      ingestionTimestampMs,
      dataFreshnessMs,
      measurementWindow: input.measurementWindow,
      providerIdentity: input.providerIdentity,
      priceMetrics: input.priceMetrics,
      liquidityMetrics: input.liquidityMetrics,
      flowMetrics: input.flowMetrics,
      holderMetrics: input.holderMetrics,
      missingFields: input.missingFields ?? [],
      strategyRevision: getStrategyRevision(),
    };

    this.storage.appendMarketObservation(record);

    // Update in-memory ring buffer
    const list = this.recentObservations.get(input.mintAddress) ?? [];
    list.push(record);
    if (list.length > this.maxCachedPerMint) {
      list.shift();
    }
    this.recentObservations.set(input.mintAddress, list);

    return record;
  }

  public getCachedObservations(mintAddress: string): readonly MarketObservationRecord[] {
    return this.recentObservations.get(mintAddress) ?? [];
  }
}
