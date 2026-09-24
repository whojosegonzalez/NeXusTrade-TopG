export interface BirdeyeBudgetConfig {
  readonly maxRequestsPerRun: number;
  readonly maxCuPerRun: number;
}

export interface BirdeyeBudgetSnapshot {
  readonly requestsUsed: number;
  readonly cuUsed: number;
  readonly requestsRemaining: number;
  readonly cuRemaining: number;
}

export interface BirdeyeBudgetReservation {
  readonly ok: boolean;
  readonly reason?: "REQUEST_BUDGET_EXHAUSTED" | "CU_BUDGET_EXHAUSTED";
  readonly snapshot: BirdeyeBudgetSnapshot;
}

export class BirdeyeBudgetTracker {
  private requestsUsed = 0;
  private cuUsed = 0;

  constructor(private readonly config: BirdeyeBudgetConfig) {}

  reserve(cuCost: number): BirdeyeBudgetReservation {
    if (this.requestsUsed + 1 > this.config.maxRequestsPerRun) {
      return {
        ok: false,
        reason: "REQUEST_BUDGET_EXHAUSTED",
        snapshot: this.snapshot(),
      };
    }

    if (this.cuUsed + cuCost > this.config.maxCuPerRun) {
      return {
        ok: false,
        reason: "CU_BUDGET_EXHAUSTED",
        snapshot: this.snapshot(),
      };
    }

    this.requestsUsed += 1;
    this.cuUsed += cuCost;

    return {
      ok: true,
      snapshot: this.snapshot(),
    };
  }

  snapshot(): BirdeyeBudgetSnapshot {
    return {
      requestsUsed: this.requestsUsed,
      cuUsed: this.cuUsed,
      requestsRemaining: Math.max(0, this.config.maxRequestsPerRun - this.requestsUsed),
      cuRemaining: Math.max(0, this.config.maxCuPerRun - this.cuUsed),
    };
  }
}
