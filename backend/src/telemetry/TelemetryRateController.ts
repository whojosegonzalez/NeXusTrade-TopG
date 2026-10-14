import type { StratificationTier } from "./TelemetryTypes.js";

export interface RateControllerConfig {
  readonly maxRequestsPerSec: number; // e.g. 4.0
  readonly bucketCapacity: number; // e.g. 8.0
  readonly minTokensForLowTier: number; // e.g. 2.0
}

export const DEFAULT_RATE_CONFIG: RateControllerConfig = {
  maxRequestsPerSec: 4.0,
  bucketCapacity: 8.0,
  minTokensForLowTier: 2.0,
};

export interface RateControllerMetrics {
  totalAcquisitions: number;
  totalShed: number;
  acquisitionsByTier: Record<StratificationTier, number>;
  shedByTier: Record<StratificationTier, number>;
}

export class TelemetryRateController {
  private readonly config: RateControllerConfig;
  private availableTokens: number;
  private lastRefillMs: number;
  private readonly metrics: RateControllerMetrics;

  constructor(config: Partial<RateControllerConfig> = {}) {
    this.config = { ...DEFAULT_RATE_CONFIG, ...config };
    this.availableTokens = this.config.bucketCapacity;
    this.lastRefillMs = Date.now();
    this.metrics = {
      totalAcquisitions: 0,
      totalShed: 0,
      acquisitionsByTier: {
        EXECUTED_POSITION: 0,
        WATCHLIST_ACTIVE: 0,
        NEAR_MISS_CANDIDATE: 0,
        HARD_REJECT_BASELINE: 0,
        EXCLUDED_SPAM: 0,
      },
      shedByTier: {
        EXECUTED_POSITION: 0,
        WATCHLIST_ACTIVE: 0,
        NEAR_MISS_CANDIDATE: 0,
        HARD_REJECT_BASELINE: 0,
        EXCLUDED_SPAM: 0,
      },
    };
  }

  private refillTokens(nowMs: number): void {
    const elapsedSec = (nowMs - this.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      const added = elapsedSec * this.config.maxRequestsPerSec;
      this.availableTokens = Math.min(this.config.bucketCapacity, this.availableTokens + added);
      this.lastRefillMs = nowMs;
    }
  }

  public tryAcquire(tier: StratificationTier, nowMs: number = Date.now()): boolean {
    this.refillTokens(nowMs);

    const isHighPriority = tier === "EXECUTED_POSITION" || tier === "WATCHLIST_ACTIVE";

    if (isHighPriority) {
      if (this.availableTokens >= 1.0) {
        this.availableTokens -= 1.0;
        this.metrics.totalAcquisitions++;
        this.metrics.acquisitionsByTier[tier]++;
        return true;
      }
      this.metrics.totalShed++;
      this.metrics.shedByTier[tier]++;
      return false;
    }

    // Lower priority tiers (near-miss, baseline hard reject) require safety buffer
    if (this.availableTokens >= this.config.minTokensForLowTier + 1.0) {
      this.availableTokens -= 1.0;
      this.metrics.totalAcquisitions++;
      this.metrics.acquisitionsByTier[tier]++;
      return true;
    }

    // Shed lower priority request to protect active positions
    this.metrics.totalShed++;
    this.metrics.shedByTier[tier]++;
    return false;
  }

  public getAvailableTokens(): number {
    this.refillTokens(Date.now());
    return this.availableTokens;
  }

  public getMetrics(): Readonly<RateControllerMetrics> {
    return {
      totalAcquisitions: this.metrics.totalAcquisitions,
      totalShed: this.metrics.totalShed,
      acquisitionsByTier: { ...this.metrics.acquisitionsByTier },
      shedByTier: { ...this.metrics.shedByTier },
    };
  }
}
