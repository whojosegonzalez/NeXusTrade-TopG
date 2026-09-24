import type { ProviderName } from "../providers/provider.types.js";

export interface PriorityFeeLevels {
  readonly min?: number;
  readonly low?: number;
  readonly medium?: number;
  readonly high?: number;
  readonly veryHigh?: number;
  readonly unsafeMax?: number;
}

export interface PriorityFeeEstimateSnapshot {
  readonly source: ProviderName;
  readonly fetchedAt: Date;
  readonly recommendedMicroLamports?: number;
  readonly levels?: PriorityFeeLevels;
}
