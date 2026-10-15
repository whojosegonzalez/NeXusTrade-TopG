/**
 * Phase 12.94-C: Quote-Aware Execution Realism Core Types & Schemas
 *
 * Implements 5-tier price execution taxonomy, bidirectional buy/sell modeling,
 * route and pool integrity verification, sellability/honeypot classification,
 * capital capacity sweeps, and research telemetry linkages.
 *
 * Current Phase 12.94-C Implemented Scope:
 * Standalone Conservative AMM Research-Model Foundation.
 * All deterministic reserve-based quotes are classified as TIER_2_POOL_RESERVE,
 * simulated fills are classified as TIER_4_SIMULATED_FILL, and provider identity
 * is labeled as synthetic_amm_reserve. Live Tier 3 executable provider quoting
 * remains decoupled and unimplemented.
 */

export type PriceTier =
  | "TIER_1_INDEXED_SPOT"
  | "TIER_2_POOL_RESERVE"
  | "TIER_3_ROUTE_QUOTE"
  | "TIER_4_SIMULATED_FILL"
  | "TIER_5_ON_CHAIN_EXECUTION";

export type ProviderIdentity =
  | "synthetic_amm_reserve"
  | "jupiter"
  | "raydium_amm"
  | "simulated_clmm";

export type RouteType = "DIRECT_TRACKED_POOL" | "MULTI_HOP" | "CROSS_POOL_DIVERGENCE";

export type ExecutionOutcome =
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "NO_ROUTE_REJECTED"
  | "PREFLIGHT_SIMULATION_REJECTED"
  | "SUBMITTED_TRANSACTION_FAILED"
  | "SLIPPAGE_BREACH_REJECTED";

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
  readonly priceTier: PriceTier;
  readonly providerIdentity: ProviderIdentity;
  readonly side: "BUY" | "SELL";
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmountRaw: string;
  readonly inAmountUi: number;
  readonly expectedOutAmountRaw: string;
  readonly expectedOutAmountUi: number;
  readonly minimumOutAmountRaw: string;
  readonly minimumOutAmountUi: number;
  readonly priceImpactPct: number;
  readonly maxSlippageBps: number;
  /**
   * Notional LP swap fee internalized by the constant-product curve.
   * Embedded in the output token/SOL amount; NOT debited separately from wallet cash.
   */
  readonly poolInternalFeeLamports: number;
  readonly poolInternalFeeSol: number;
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
  readonly priceTier: PriceTier;
  readonly providerIdentity: ProviderIdentity;
  readonly side: "BUY" | "SELL";
  readonly executionOutcome: ExecutionOutcome;
  readonly attemptedSizeSol: number;
  readonly filledSizeSol: number;
  readonly attemptedTokens: number;
  readonly filledTokens: number;
  /**
   * Tokens remaining in wallet inventory.
   * On a failed sell, filledTokens === 0 and remainingTokens === attemptedTokens.
   */
  readonly remainingTokens: number;
  readonly effectivePriceSol: number;
  readonly grossProceedsSol?: number | undefined;
  readonly netProceedsSol?: number | undefined;
  readonly priceImpactBps: number;
  readonly maxSlippageBps: number;
  readonly realizedSlippageBps: number;
  /**
   * Actual out-of-pocket Solana transaction fee charged to wallet.
   * 0 for preflight or no-route rejections; base + priority fee if submitted on-chain.
   */
  readonly networkFeeLamports: number;
  readonly priorityFeeLamports: number;
  /**
   * Explicit ATA rent creation deposit in lamports (if a new ATA was opened).
   */
  readonly ataRentDepositLamports?: number | undefined;
  /**
   * Explicit ATA rent refund in lamports (if an established funded ATA was closed).
   */
  readonly ataRentRefundLamports?: number | undefined;
  readonly sellabilityStatus: SellabilityStatus;
  /**
   * Conservative valuation stress write-down (risk metric, not a realized liquidation).
   */
  readonly conservativeWriteDownSol?: number | undefined;
  /**
   * Realized P&L in SOL. Only populated upon confirmed on-chain liquidation.
   */
  readonly realizedPnlSol?: number | undefined;
  readonly fillTimestampMs: number;
  readonly fillSlot: number;
  readonly executionDelayMs: number;
}

export interface ExecutionFeeBreakdown {
  readonly baseNetworkFeeLamports: number;
  readonly priorityFeeLamports: number;
  readonly externalNetworkFeeLamports: number;
  readonly externalNetworkFeeSol: number;
  /**
   * Liquidity provider fee embedded inside the AMM pool curve.
   * Reflected in reduced tokens/SOL output; not debited separately from wallet cash.
   */
  readonly poolInternalFeeLamports: number;
  readonly poolInternalFeeSol: number;
  readonly ataRentDepositLamports: number;
  readonly ataRentRefundLamports: number;
  /**
   * Signed net out-of-pocket cash movement:
   * (externalNetworkFeeLamports + ataRentDepositLamports - ataRentRefundLamports).
   * Positive = net cash debit paid by wallet.
   * Negative = net cash credit received by wallet (when rent refund exceeds network fees).
   */
  readonly totalOutOfPocketFeeLamports: number;
  readonly totalOutOfPocketFeeSol: number;
}

export interface CapacityTierSweep {
  readonly tierSizeSol: number;
  readonly tokensReceived: number;
  readonly effectivePriceSol: number;
  readonly postBuyReserveSol: number;
  readonly postBuyReserveTokens: number;
  readonly grossExitProceedsSol: number;
  readonly netExitProceedsSol: number;
  readonly netPnlSol: number;
  readonly netReturnPct: number;
  readonly priceImpactBps: number;
  readonly externalFeeDragBps: number;
  readonly poolInternalFeeBps: number;
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
