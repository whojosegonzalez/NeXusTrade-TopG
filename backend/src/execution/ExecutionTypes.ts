/**
 * Phase 12.94-C: Quote-Aware Execution Realism Core Types & Schemas
 *
 * Implements 5-tier price execution taxonomy, bidirectional buy/sell modeling,
 * route and pool integrity verification, sellability/honeypot classification,
 * capital capacity sweeps, and research telemetry linkages.
 */

export type PriceTier =
  | "TIER_1_INDEXED_SPOT"
  | "TIER_2_POOL_RESERVE"
  | "TIER_3_ROUTE_QUOTE"
  | "TIER_4_SIMULATED_FILL"
  | "TIER_5_ON_CHAIN_EXECUTION";

export type RouteType = "DIRECT_TRACKED_POOL" | "MULTI_HOP" | "CROSS_POOL_DIVERGENCE";

export type SellabilityStatus =
  | "FULLY_SELLABLE"
  | "HIGH_IMPACT_IMPAIRED"
  | "UNSELLABLE_NO_ROUTE"
  | "UNSELLABLE_TRANSFER_RESTRICTION"
  | "UNSELLABLE_LIQUIDITY_DRAINED"
  | "UNSELLABLE_EXCESSIVE_IMPACT"
  | "UNSELLABLE_SLIPPAGE_EXCEEDED";

export interface RoutePlanStep {
  readonly ammKey: string;
  readonly label: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly feePct: number;
}

export interface ExecutableQuoteRecord {
  readonly quoteId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly decisionEventId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly side: "BUY" | "SELL";
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmountRaw: string;
  readonly inAmountUi: number;
  readonly outAmountRaw: string;
  readonly outAmountUi: number;
  readonly minimumOutAmountRaw: string;
  readonly priceImpactPct: number;
  readonly slippageBps: number;
  readonly feeLamports: number;
  readonly providerIdentity: "jupiter" | "raydium_amm" | "simulated_clmm";
  readonly routeType: RouteType;
  readonly routePlan: readonly RoutePlanStep[];
  readonly quoteInitiatedMs: number;
  readonly quoteReceivedMs: number;
  readonly contextSlot: number;
  readonly validUntilMs: number;
}

export interface SimulatedFillRecord {
  readonly fillId: string;
  readonly quoteId: string;
  readonly decisionEventId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly side: "BUY" | "SELL";
  readonly attemptedSizeSol: number;
  readonly filledSizeSol: number;
  readonly filledTokens: number;
  readonly effectivePriceSol: number;
  readonly grossProceedsSol?: number | undefined;
  readonly netProceedsSol?: number | undefined;
  readonly priceImpactBps: number;
  readonly realizedSlippageBps: number;
  readonly networkFeeLamports: number;
  readonly priorityFeeLamports: number;
  readonly sellabilityStatus: SellabilityStatus;
  readonly fillTimestampMs: number;
  readonly fillSlot: number;
  readonly executionDelayMs: number;
}

export interface ExecutionFeeBreakdown {
  readonly baseFeeLamports: number;
  readonly priorityFeeLamports: number;
  readonly dexFeeLamports: number;
  readonly ataCreationRentLamports: number;
  readonly ataRebateLamports: number;
  readonly totalFeeLamports: number;
  readonly totalFeeSol: number;
}

export interface CapacityTierSweep {
  readonly tierSizeSol: number;
  readonly tokensReceived: number;
  readonly effectivePriceSol: number;
  readonly grossExitProceedsSol: number;
  readonly netExitProceedsSol: number;
  readonly netPnlSol: number;
  readonly netReturnPct: number;
  readonly priceImpactBps: number;
  readonly totalFeeDragBps: number;
  readonly isViable: boolean;
}

export interface CapacityCurveResult {
  readonly mintAddress: string;
  readonly poolId: string;
  readonly sweeps: readonly CapacityTierSweep[];
  readonly optimalSizeSol: number | null;
  readonly alphaExtinctionThresholdSol: number | null;
  readonly isEconomicallyViable: boolean;
}

export interface CrossFileConsistencyCheckResult {
  readonly valid: boolean;
  readonly reason?: string | undefined;
}
