import type { TelemetryStorageManager } from "./TelemetryStorageManager.js";
import type { MarketObservationRecorder } from "./MarketObservationRecorder.js";
import type { StratifiedSamplingController } from "./StratifiedSamplingController.js";
import type { TelemetryRateController } from "./TelemetryRateController.js";
import type { PriceSourceType } from "./TelemetryTypes.js";

export interface FollowUpObservationResult {
  spotPriceUsd: number | null;
  spotPriceSol: number | null;
  liquidityUsd: number;
  txCount: number;
  buys: number;
  sells: number;
  volumeUsd: number;
  priceSource: PriceSourceType;
  actualPoolId?: string | undefined;
}

export type FollowUpObservationFetcher = (
  poolId: string,
  mintAddress: string,
) => Promise<FollowUpObservationResult | null>;

export interface FollowUpPollSummary {
  polledCount: number;
  skippedShedCount: number;
}

export class TelemetryFollowUpScheduler {
  private readonly storage: TelemetryStorageManager;
  private readonly observationRecorder: MarketObservationRecorder;
  private readonly samplingController: StratifiedSamplingController;
  private readonly rateController: TelemetryRateController;
  private readonly fetcher: FollowUpObservationFetcher;

  constructor(
    storage: TelemetryStorageManager,
    observationRecorder: MarketObservationRecorder,
    samplingController: StratifiedSamplingController,
    rateController: TelemetryRateController,
    fetcher: FollowUpObservationFetcher,
  ) {
    this.storage = storage;
    this.observationRecorder = observationRecorder;
    this.samplingController = samplingController;
    this.rateController = rateController;
    this.fetcher = fetcher;
  }

  public async pollPendingTrackers(nowMs: number = Date.now()): Promise<FollowUpPollSummary> {
    const activeTrackers = this.samplingController.getActiveTrackers();
    let polledCount = 0;
    let skippedShedCount = 0;

    for (const tracker of activeTrackers) {
      const lastObs = tracker.lastObservationMs ?? tracker.trackingStartedMs;
      const elapsed = nowMs - lastObs;

      if (elapsed < tracker.currentSamplingIntervalMs) {
        continue; // Not yet due for next sample
      }

      // Check token bucket permit (B2-03: honor permit check before optional fetch!)
      const permit = this.rateController.tryAcquire(tracker.tier, nowMs);
      if (!permit) {
        skippedShedCount++;
        continue;
      }

      // Permit acquired -> issue fetch
      const requestInitiatedMs = Date.now();
      let res: FollowUpObservationResult | null = null;
      try {
        res = await this.fetcher(tracker.poolId, tracker.mintAddress);
      } catch (err) {
        console.warn(
          `[TelemetryFollowUpScheduler] Error fetching observation for ${tracker.mintAddress}:`,
          err,
        );
        continue;
      }

      const responseReceivedMs = Date.now();
      if (!res) continue;

      const key = this.samplingController.buildTrackerKey(
        tracker.generationId,
        tracker.sessionId,
        tracker.poolId,
        tracker.mintAddress,
      );

      this.observationRecorder.recordObservation({
        sessionId: tracker.sessionId,
        generationId: tracker.generationId,
        mintAddress: tracker.mintAddress,
        poolId: tracker.poolId,
        sourceTimestampMs: nowMs,
        ingestionTimestampMs: responseReceivedMs,
        requestInitiatedMs,
        responseReceivedMs,
        measurementWindow: {
          windowStartMs: nowMs - 60000,
          windowEndMs: nowMs,
          durationSec: 60,
        },
        derivationStatus: "RAW",
        providerIdentity: "followup_scheduler",
        actualResponsePoolId: res.actualPoolId ?? tracker.poolId,
        priceMetrics: {
          spotPriceUsd: res.spotPriceUsd,
          spotPriceSol: res.spotPriceSol,
          priceSource: res.priceSource,
        },
        liquidityMetrics: {
          baseReserve: 0,
          quoteReserve: 0,
          liquidityUsd: res.liquidityUsd,
        },
        flowMetrics: {
          txCount: res.txCount,
          buys: res.buys,
          sells: res.sells,
          volumeUsd: res.volumeUsd,
          netBuyerVolumeUsd: 0,
        },
      });

      if (res.spotPriceSol !== null && res.spotPriceSol > 0) {
        this.samplingController.updateObservation(key, res.spotPriceSol, nowMs);
      }

      polledCount++;
    }

    return { polledCount, skippedShedCount };
  }
}
