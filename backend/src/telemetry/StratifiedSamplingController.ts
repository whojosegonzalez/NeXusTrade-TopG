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
  // Keyed by composite key: `${generationId}:${sessionId}:${poolId}:${mintAddress}`
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

  private buildTrackerKey(
    generationId: string,
    sessionId: string,
    poolId: string,
    mintAddress: string,
  ): string {
    return `${generationId}:${sessionId}:${poolId}:${mintAddress}`;
  }

  public classifyTier(decision: CandidateDecisionRecord): StratificationTier {
    if (decision.decisionCohort === "EXECUTED_BUY") {
      return "EXECUTED_POSITION";
    }
    if (decision.decisionCohort === "WATCHLIST_RADAR") {
      return "WATCHLIST_ACTIVE";
    }

    // Exclude complete spam (zero / negligible liquidity)
    if (decision.metricsSnapshot.liquidityUsd < this.config.minLiquidityForTrackingUsd) {
      return "EXCLUDED_SPAM";
    }

    // Near-miss detection: check if candidate failed by a narrow margin
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
    const key = this.buildTrackerKey(
      decision.generationId,
      decision.sessionId,
      decision.poolId,
      decision.mintAddress,
    );

    if (this.activeTrackers.has(key)) {
      return this.activeTrackers.get(key)!;
    }

    const tier = this.classifyTier(decision);
    let stratumProbability = 0;
    let ipwEstimable = false;

    switch (tier) {
      case "EXECUTED_POSITION":
        stratumProbability = 1.0;
        ipwEstimable = true;
        break;
      case "WATCHLIST_ACTIVE":
        stratumProbability = 1.0;
        ipwEstimable = true;
        break;
      case "NEAR_MISS_CANDIDATE":
        stratumProbability = this.config.nearMissSamplingRate;
        ipwEstimable = true;
        break;
      case "HARD_REJECT_BASELINE":
        stratumProbability = this.config.baselineSamplingRate;
        ipwEstimable = true;
        break;
      case "EXCLUDED_SPAM":
        stratumProbability = 0.0;
        ipwEstimable = false; // p=0 stratum cannot be estimated via IPW
        break;
    }

    const now = Date.now();
    const trackingId = crypto.randomUUID();
    const trackingExpiresMs = now + this.config.maxTrackingDurationMs;

    // Handle Excluded Spam: record drop event and return null
    if (tier === "EXCLUDED_SPAM") {
      const spamRecord: StratifiedSamplingRecord = {
        trackingId,
        sessionId: decision.sessionId,
        generationId: decision.generationId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        decisionEventId: decision.eventId,
        tier,
        samplingProbability: 0.0,
        effectiveInclusionProbability: 0.0,
        ipwEstimable: false,
        selectionSeed: this.sessionSeed,
        selectionReason: "EXCLUDED_SPAM_BELOW_MIN_LIQUIDITY",
        trackingStartedMs: now,
        trackingExpiresMs,
        currentSamplingIntervalMs: 0,
        observationCount: 0,
        initialPriceSol,
        peakPriceSol: initialPriceSol,
        peakGainPct: 0.0,
        troughPriceSol: initialPriceSol,
        maxDrawdownPct: 0.0,
        latestPriceSol: initialPriceSol,
        status: "EXCLUDED_SPAM",
      };
      this.storage.appendStratifiedSample(spamRecord);
      return null;
    }

    // Capacity Handling:
    // EXECUTED_POSITION is mandatory (100% guarantee). It bypasses or preempts capacity.
    const isCapacityFull = this.activeTrackers.size >= this.config.maxConcurrentTracked;
    if (isCapacityFull && tier !== "EXECUTED_POSITION") {
      // Try to evict a lower-priority baseline tracker if this is a high-priority watchlist item
      let evicted = false;
      if (tier === "WATCHLIST_ACTIVE") {
        for (const [existingKey, existingTracker] of this.activeTrackers.entries()) {
          if (existingTracker.tier === "HARD_REJECT_BASELINE") {
            this.activeTrackers.delete(existingKey);
            evicted = true;
            break;
          }
        }
      }

      if (!evicted) {
        // Record capacity drop outcome
        const dropRecord: StratifiedSamplingRecord = {
          trackingId,
          sessionId: decision.sessionId,
          generationId: decision.generationId,
          mintAddress: decision.mintAddress,
          poolId: decision.poolId,
          decisionEventId: decision.eventId,
          tier,
          samplingProbability: stratumProbability,
          effectiveInclusionProbability: 0.0,
          ipwEstimable: false,
          selectionSeed: this.sessionSeed,
          selectionReason: "CAPACITY_EXCEEDED",
          trackingStartedMs: now,
          trackingExpiresMs,
          currentSamplingIntervalMs: 0,
          observationCount: 0,
          initialPriceSol,
          peakPriceSol: initialPriceSol,
          peakGainPct: 0.0,
          troughPriceSol: initialPriceSol,
          maxDrawdownPct: 0.0,
          latestPriceSol: initialPriceSol,
          status: "DROPPED_CAPACITY",
        };
        this.storage.appendStratifiedSample(dropRecord);
        return null;
      }
    }

    // Deterministic selection using sessionSeed
    const u = computeDeterministicUniform(this.sessionSeed, decision.mintAddress);
    const isSelected = stratumProbability >= 1.0 || u < stratumProbability;

    if (!isSelected) {
      // Record not-selected outcome with effective inclusion probability preserved for IPW
      const notSelectedRecord: StratifiedSamplingRecord = {
        trackingId,
        sessionId: decision.sessionId,
        generationId: decision.generationId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        decisionEventId: decision.eventId,
        tier,
        samplingProbability: stratumProbability,
        effectiveInclusionProbability: stratumProbability,
        ipwEstimable: true,
        selectionSeed: this.sessionSeed,
        selectionReason: "DETERMINISTIC_SAMPLE_NOT_SELECTED",
        trackingStartedMs: now,
        trackingExpiresMs,
        currentSamplingIntervalMs: 0,
        observationCount: 0,
        initialPriceSol,
        peakPriceSol: initialPriceSol,
        peakGainPct: 0.0,
        troughPriceSol: initialPriceSol,
        maxDrawdownPct: 0.0,
        latestPriceSol: initialPriceSol,
        status: "NOT_SELECTED",
      };
      this.storage.appendStratifiedSample(notSelectedRecord);
      return null;
    }

    const record: StratifiedSamplingRecord = {
      trackingId,
      sessionId: decision.sessionId,
      generationId: decision.generationId,
      mintAddress: decision.mintAddress,
      poolId: decision.poolId,
      decisionEventId: decision.eventId,
      tier,
      samplingProbability: stratumProbability,
      effectiveInclusionProbability: stratumProbability,
      ipwEstimable,
      selectionSeed: this.sessionSeed,
      selectionReason: "SELECTED_FOR_TRACKING",
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

    this.activeTrackers.set(key, record);
    this.storage.appendStratifiedSample(record);
    return record;
  }

  public updateObservation(
    identifier: string, // mintAddress or composite key
    currentPriceSol: number,
    nowMs: number = Date.now(),
  ): StratifiedSamplingRecord | undefined {
    let key = identifier;
    let tracker = this.activeTrackers.get(key);

    // If identifier is just mintAddress, find matching tracker
    if (!tracker) {
      for (const [k, v] of this.activeTrackers.entries()) {
        if (k.endsWith(`:${identifier}`) || v.mintAddress === identifier) {
          key = k;
          tracker = v;
          break;
        }
      }
    }

    if (!tracker) return undefined;

    if (nowMs >= tracker.trackingExpiresMs) {
      const expired: StratifiedSamplingRecord = {
        ...tracker,
        status: "EXPIRED",
        latestPriceSol: currentPriceSol,
      };
      this.activeTrackers.delete(key);
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

    this.activeTrackers.set(key, updated);
    this.storage.appendStratifiedSample(updated);
    return updated;
  }

  public getActiveTrackers(): readonly StratifiedSamplingRecord[] {
    return Array.from(this.activeTrackers.values());
  }

  public getActiveTracker(identifier: string): StratifiedSamplingRecord | undefined {
    let tracker = this.activeTrackers.get(identifier);
    if (!tracker) {
      for (const [k, v] of this.activeTrackers.entries()) {
        if (k.endsWith(`:${identifier}`) || v.mintAddress === identifier) {
          tracker = v;
          break;
        }
      }
    }
    return tracker;
  }
}
