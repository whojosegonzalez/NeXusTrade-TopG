import crypto from "node:crypto";
import type {
  CandidateDecisionRecord,
  StratifiedSamplingRecord,
  StratificationTier,
} from "./TelemetryTypes.js";
import type { TelemetryStorageManager } from "./TelemetryStorageManager.js";

export interface SamplingRuleConfig {
  readonly nearMissSamplingRate: number; // e.g. 0.20 (20%)
  readonly baselineSamplingRate: number; // e.g. 0.02 (2%)
  readonly maxTrackingDurationMs: number; // e.g. 3,600,000 (1 hour)
  readonly maxConcurrentTracked: number; // e.g. 50
  readonly minLiquidityForTrackingUsd: number; // e.g. 500
}

export const DEFAULT_SAMPLING_CONFIG: SamplingRuleConfig = {
  nearMissSamplingRate: 0.2,
  baselineSamplingRate: 0.02,
  maxTrackingDurationMs: 60 * 60 * 1000,
  maxConcurrentTracked: 50,
  minLiquidityForTrackingUsd: 500,
};

function computeDeterministicUniform(seed: string, key: string): number {
  const hash = crypto.createHash("sha256").update(`${seed}:${key}`).digest("hex");
  const slice = hash.slice(0, 8);
  const intVal = parseInt(slice, 16);
  return intVal / 0xffffffff;
}

export class StratifiedSamplingController {
  private readonly storage: TelemetryStorageManager;
  private readonly config: SamplingRuleConfig;
  private readonly sessionSeed: string;
  private readonly activeTrackers = new Map<string, StratifiedSamplingRecord>();

  constructor(
    storage: TelemetryStorageManager,
    sessionSeed: string = crypto.randomUUID(),
    config: Partial<SamplingRuleConfig> = {},
  ) {
    this.storage = storage;
    this.sessionSeed = sessionSeed;
    this.config = { ...DEFAULT_SAMPLING_CONFIG, ...config };
  }

  public classifyTier(decision: CandidateDecisionRecord): StratificationTier {
    if (decision.decisionCohort === "EXECUTED_BUY") {
      return "EXECUTED_POSITION";
    }
    if (decision.decisionCohort === "WATCHLIST_RADAR") {
      return "WATCHLIST_ACTIVE";
    }

    // Exclude complete spam
    if (decision.metricsSnapshot.liquidityUsd < this.config.minLiquidityForTrackingUsd) {
      return "EXCLUDED_SPAM";
    }

    // Near-miss detection: check if candidate failed by a narrow margin
    // e.g. Failed net buyer flow but had healthy LP (> $5,000) or high tx count (> 15)
    const isNearMiss =
      (decision.primaryRejectionReason === "REJECTED_NET_SELLER_DOMINANCE" &&
        decision.metricsSnapshot.liquidityUsd >= 5000) ||
      (decision.primaryRejectionReason === "REJECTED_INSUFFICIENT_TRANSACTION_COUNT" &&
        decision.metricsSnapshot.txCount5m >= 10);

    if (isNearMiss) {
      return "NEAR_MISS_CANDIDATE";
    }

    return "HARD_REJECT_BASELINE";
  }

  public evaluateForTracking(
    decision: CandidateDecisionRecord,
    initialPriceSol: number,
  ): StratifiedSamplingRecord | null {
    if (this.activeTrackers.has(decision.mintAddress)) {
      return this.activeTrackers.get(decision.mintAddress)!;
    }

    if (this.activeTrackers.size >= this.config.maxConcurrentTracked) {
      return null; // Concurrency budget reached
    }

    const tier = this.classifyTier(decision);
    let probability = 0;

    switch (tier) {
      case "EXECUTED_POSITION":
        probability = 1.0;
        break;
      case "WATCHLIST_ACTIVE":
        probability = 1.0;
        break;
      case "NEAR_MISS_CANDIDATE":
        probability = this.config.nearMissSamplingRate;
        break;
      case "HARD_REJECT_BASELINE":
        probability = this.config.baselineSamplingRate;
        break;
      case "EXCLUDED_SPAM":
        probability = 0.0;
        break;
    }

    if (probability <= 0) {
      return null;
    }

    // Deterministic selection using sessionSeed
    const u = computeDeterministicUniform(this.sessionSeed, decision.mintAddress);
    const isSelected = u < probability;

    if (!isSelected) {
      return null;
    }

    const now = Date.now();
    const trackingId = crypto.randomUUID();
    const trackingExpiresMs = now + this.config.maxTrackingDurationMs;

    const record: StratifiedSamplingRecord = {
      trackingId,
      sessionId: decision.sessionId,
      generationId: decision.generationId,
      mintAddress: decision.mintAddress,
      poolId: decision.poolId,
      decisionEventId: decision.eventId,
      tier,
      samplingProbability: probability,
      selectionSeed: this.sessionSeed,
      trackingStartedMs: now,
      trackingExpiresMs,
      currentSamplingIntervalMs: tier === "EXECUTED_POSITION" ? 5000 : 30000,
      observationCount: 1,
      initialPriceSol,
      peakPriceSol: initialPriceSol,
      peakGainPct: 0.0,
      troughPriceSol: initialPriceSol,
      maxDrawdownPct: 0.0,
      latestPriceSol: initialPriceSol,
      status: "TRACKING_ACTIVE",
    };

    this.activeTrackers.set(decision.mintAddress, record);
    this.storage.appendStratifiedSample(record);
    return record;
  }

  public updateObservation(
    mintAddress: string,
    currentPriceSol: number,
    nowMs: number = Date.now(),
  ): StratifiedSamplingRecord | undefined {
    const tracker = this.activeTrackers.get(mintAddress);
    if (!tracker) return undefined;

    if (nowMs >= tracker.trackingExpiresMs) {
      const expired: StratifiedSamplingRecord = {
        ...tracker,
        status: "EXPIRED",
        latestPriceSol: currentPriceSol,
      };
      this.activeTrackers.delete(mintAddress);
      this.storage.appendStratifiedSample(expired);
      return expired;
    }

    const peakPrice = Math.max(tracker.peakPriceSol, currentPriceSol);
    const troughPrice =
      tracker.troughPriceSol > 0
        ? Math.min(tracker.troughPriceSol, currentPriceSol)
        : currentPriceSol;

    const peakGainPct =
      tracker.initialPriceSol > 0
        ? ((peakPrice - tracker.initialPriceSol) / tracker.initialPriceSol) * 100
        : 0;

    // Drawdown is measured from running peak to current/subsequent price
    const currentDrawdownPct =
      peakPrice > 0 ? ((peakPrice - currentPriceSol) / peakPrice) * 100 : 0;
    const maxDrawdownPct = Math.max(tracker.maxDrawdownPct, currentDrawdownPct);

    // Decay sampling interval over time
    const ageMs = nowMs - tracker.trackingStartedMs;
    let nextInterval = tracker.currentSamplingIntervalMs;
    if (tracker.tier !== "EXECUTED_POSITION") {
      if (ageMs > 30 * 60 * 1000) {
        nextInterval = 600 * 1000; // 10 minutes
      } else if (ageMs > 5 * 60 * 1000) {
        nextInterval = 120 * 1000; // 2 minutes
      }
    }

    const updated: StratifiedSamplingRecord = {
      ...tracker,
      observationCount: tracker.observationCount + 1,
      currentSamplingIntervalMs: nextInterval,
      peakPriceSol: Number(peakPrice.toFixed(8)),
      peakGainPct: Number(peakGainPct.toFixed(2)),
      troughPriceSol: Number(troughPrice.toFixed(8)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      latestPriceSol: Number(currentPriceSol.toFixed(8)),
    };

    this.activeTrackers.set(mintAddress, updated);
    this.storage.appendStratifiedSample(updated);
    return updated;
  }

  public getActiveTrackers(): readonly StratifiedSamplingRecord[] {
    return Array.from(this.activeTrackers.values());
  }

  public getActiveTracker(mintAddress: string): StratifiedSamplingRecord | undefined {
    return this.activeTrackers.get(mintAddress);
  }
}
