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

export class TelemetryRateController {
  private readonly config: RateControllerConfig;
  private availableTokens: number;
  private lastRefillMs: number;

  constructor(config: Partial<RateControllerConfig> = {}) {
    this.config = { ...DEFAULT_RATE_CONFIG, ...config };
    this.availableTokens = this.config.bucketCapacity;
    this.lastRefillMs = Date.now();
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
        return true;
      }
      return false;
    }

    // Lower priority tiers (near-miss, baseline hard reject)
    if (this.availableTokens >= this.config.minTokensForLowTier + 1.0) {
      this.availableTokens -= 1.0;
      return true;
    }

    return false; // Shed lower priority request to protect active positions
  }

  public getAvailableTokens(): number {
    this.refillTokens(Date.now());
    return this.availableTokens;
  }
}
