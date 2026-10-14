import type { TelemetryStorageManager } from "./TelemetryStorageManager.js";
import type { MarketObservationRecorder } from "./MarketObservationRecorder.js";
import type { StratifiedSamplingController } from "./StratifiedSamplingController.js";
import type { TelemetryRateController } from "./TelemetryRateController.js";
import type { PriceSourceType, StratificationTier } from "./TelemetryTypes.js";

export interface FollowUpObservationResult {
  spotPriceUsd: number | null;
  spotPriceSol: number | null;
  liquidityUsd?: number | null | undefined;
  baseReserve?: number | null | undefined;
  quoteReserve?: number | null | undefined;
  txCount?: number | null | undefined;
  buys?: number | null | undefined;
  sells?: number | null | undefined;
  volumeUsd?: number | null | undefined;
  netBuyerVolumeUsd?: number | null | undefined;
  priceSource: PriceSourceType;
  actualPoolId?: string | undefined;
  sourceTimestampMs?: number | undefined;
  measurementWindowSec?: number | undefined;
  derivationStatus?:
    | "RAW"
    | "DERIVED_FROM_5M"
    | "DERIVED_FROM_1H"
    | "DIRECT_OBSERVATION"
    | undefined;
}

export type FollowUpObservationFetcher = (
  poolId: string,
  mintAddress: string,
) => Promise<FollowUpObservationResult | null>;

export interface FollowUpPollSummary {
  polledCount: number;
  skippedShedCount: number;
}

const TIER_PRIORITY: Record<StratificationTier, number> = {
  EXECUTED_POSITION: 4,
  WATCHLIST_ACTIVE: 3,
  NEAR_MISS_CANDIDATE: 2,
  HARD_REJECT_BASELINE: 1,
  EXCLUDED_SPAM: 0,
};

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
    // Prioritize high-tier trackers (EXECUTED_POSITION) over lower tiers before permit acquisition
    const activeTrackers = [...this.samplingController.getActiveTrackers()].sort(
      (a, b) => (TIER_PRIORITY[b.tier] ?? 0) - (TIER_PRIORITY[a.tier] ?? 0),
    );
    let polledCount = 0;
    let skippedShedCount = 0;

    for (const tracker of activeTrackers) {
      const lastObs = tracker.lastObservationMs ?? tracker.trackingStartedMs;
      const elapsed = nowMs - lastObs;

      if (elapsed < tracker.currentSamplingIntervalMs) {
        continue; // Not yet due for next sample
      }

      // Check token bucket permit BEFORE issuing optional telemetry fetch (B2-03 / B3-02)
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

      // Cross-pool contamination check (B3-03):
      // Discard observation if response pool does not match the tracked pool
      if (res.actualPoolId) {
        const normActual = res.actualPoolId.replace(/^dexscreener-/, "");
        const normTracked = tracker.poolId.replace(/^dexscreener-/, "");
        if (normActual !== normTracked) {
          console.warn(
            `[TelemetryFollowUpScheduler] Discarding observation: pool mismatch for ${tracker.mintAddress}. Tracked=${tracker.poolId}, Actual=${res.actualPoolId}`,
          );
          continue;
        }
      }

      const key = this.samplingController.buildTrackerKey(
        tracker.generationId,
        tracker.sessionId,
        tracker.poolId,
        tracker.mintAddress,
      );

      const missingFields: string[] = [];
      if (res.spotPriceUsd === null) missingFields.push("spotPriceUsd");
      if (res.spotPriceSol === null) missingFields.push("spotPriceSol");
      if (res.liquidityUsd === null) missingFields.push("liquidityUsd");
      if (res.baseReserve === null) missingFields.push("baseReserve");
      if (res.quoteReserve === null) missingFields.push("quoteReserve");
      if (res.txCount === null) missingFields.push("txCount");
      if (res.buys === null) missingFields.push("buys");
      if (res.sells === null) missingFields.push("sells");
      if (res.volumeUsd === null) missingFields.push("volumeUsd");
      if (res.netBuyerVolumeUsd === null || res.netBuyerVolumeUsd === undefined) {
        missingFields.push("netBuyerVolumeUsd");
      }

      const windowDurationSec = res.measurementWindowSec ?? 300;
      const sourceTimestampMs = res.sourceTimestampMs ?? responseReceivedMs;
      const windowEndMs = sourceTimestampMs;
      const windowStartMs = windowEndMs - windowDurationSec * 1000;

      this.observationRecorder.recordObservation({
        sessionId: tracker.sessionId,
        generationId: tracker.generationId,
        mintAddress: tracker.mintAddress,
        poolId: tracker.poolId,
        sourceTimestampMs,
        ingestionTimestampMs: responseReceivedMs,
        requestInitiatedMs,
        responseReceivedMs,
        measurementWindow: {
          windowStartMs,
          windowEndMs,
          durationSec: windowDurationSec,
        },
        derivationStatus: res.derivationStatus ?? "DERIVED_FROM_5M",
        providerIdentity: "followup_scheduler",
        actualResponsePoolId: res.actualPoolId ?? tracker.poolId,
        priceMetrics: {
          spotPriceUsd: res.spotPriceUsd,
          spotPriceSol: res.spotPriceSol,
          priceSource: res.priceSource,
        },
        liquidityMetrics: {
          baseReserve: res.baseReserve ?? null,
          quoteReserve: res.quoteReserve ?? null,
          liquidityUsd: res.liquidityUsd ?? null,
        },
        flowMetrics: {
          txCount: res.txCount ?? null,
          buys: res.buys ?? null,
          sells: res.sells ?? null,
          volumeUsd: res.volumeUsd ?? null,
          netBuyerVolumeUsd: res.netBuyerVolumeUsd ?? null,
        },
        missingFields,
      });

      if (res.spotPriceSol !== null && res.spotPriceSol > 0) {
        this.samplingController.updateObservation(key, res.spotPriceSol, nowMs);
      }

      polledCount++;
    }

    return { polledCount, skippedShedCount };
  }
}
