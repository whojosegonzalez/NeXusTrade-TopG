import type { PriorityFeeEstimateSnapshot, ProviderResult } from "@nexustrade/shared";

import type { ProviderAdapter } from "./ProviderAdapter.js";

export interface PriorityFeeRequest {
  readonly accountKeys?: readonly string[];
}

export interface PriorityFeeProvider extends ProviderAdapter {
  readonly getPriorityFeeEstimate: (
    request?: PriorityFeeRequest,
  ) => Promise<ProviderResult<PriorityFeeEstimateSnapshot>>;
}
