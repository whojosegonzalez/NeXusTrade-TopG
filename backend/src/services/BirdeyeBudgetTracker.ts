export interface BirdeyeMonthlyBudgetConfig {
  readonly monthlyCuLimit?: number; // default 30_000 CU (Standard Active Plan)
  readonly trendingPollIntervalMs?: number; // default 150_000ms (2.5 minutes)
  readonly trendingCuCost?: number; // default 25 CU
}

export interface BirdeyeQuotaSnapshot {
  readonly monthlyCuLimit: number;
  readonly monthlyCuUsed: number;
  readonly monthlyCuRemaining: number;
  readonly lastTrendingPollMs: number;
  readonly totalTrendingPolls: number;
}

export class BirdeyeBudgetTracker {
  private readonly monthlyCuLimit: number;
  private readonly trendingPollIntervalMs: number;
  private readonly trendingCuCost: number;

  private monthlyCuUsed = 0;
  private lastTrendingPollMs = 0;
  private totalTrendingPolls = 0;

  constructor(config: BirdeyeMonthlyBudgetConfig = {}) {
    this.monthlyCuLimit = config.monthlyCuLimit ?? 30_000;
    this.trendingPollIntervalMs = config.trendingPollIntervalMs ?? 150_000;
    this.trendingCuCost = config.trendingCuCost ?? 25;
  }

  canConsume(cu: number): boolean {
    if (cu <= 0) return true;
    return this.monthlyCuUsed + cu <= this.monthlyCuLimit;
  }

  consume(cu: number): boolean {
    if (!this.canConsume(cu)) {
      return false;
    }
    this.monthlyCuUsed += cu;
    return true;
  }

  canPollTrending(nowMs: number = Date.now()): boolean {
    if (
      this.lastTrendingPollMs > 0 &&
      nowMs - this.lastTrendingPollMs < this.trendingPollIntervalMs
    ) {
      return false;
    }
    return this.canConsume(this.trendingCuCost);
  }

  recordTrendingPoll(nowMs: number = Date.now()): boolean {
    if (!this.canPollTrending(nowMs)) {
      return false;
    }
    const consumed = this.consume(this.trendingCuCost);
    if (!consumed) {
      return false;
    }
    this.lastTrendingPollMs = nowMs;
    this.totalTrendingPolls += 1;
    return true;
  }

  getSnapshot(): BirdeyeQuotaSnapshot {
    return {
      monthlyCuLimit: this.monthlyCuLimit,
      monthlyCuUsed: this.monthlyCuUsed,
      monthlyCuRemaining: Math.max(0, this.monthlyCuLimit - this.monthlyCuUsed),
      lastTrendingPollMs: this.lastTrendingPollMs,
      totalTrendingPolls: this.totalTrendingPolls,
    };
  }

  reset(): void {
    this.monthlyCuUsed = 0;
    this.lastTrendingPollMs = 0;
    this.totalTrendingPolls = 0;
  }
}
