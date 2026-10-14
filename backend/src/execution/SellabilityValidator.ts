/**
 * Phase 12.94-C: Sellability and Honeypot Detection Engine
 *
 * Implements formal classification and accounting for the "Unsellable Winner"
 * problem in micro-cap and meme tokens:
 * - Detects route absence (UNSELLABLE_NO_ROUTE)
 * - Detects honeypots, transfer restrictions, freeze authority (UNSELLABLE_TRANSFER_RESTRICTION)
 * - Detects liquidity pull rugs (UNSELLABLE_LIQUIDITY_DRAINED)
 * - Detects catastrophic price impact (UNSELLABLE_EXCESSIVE_IMPACT)
 * - Enforces -100% total loss P&L accounting whenever an unsellable failure state occurs
 */

import type { SellabilityStatus } from "./ExecutionTypes.js";

export const CATASTROPHIC_PRICE_IMPACT_THRESHOLD = 0.3; // 30% price impact
export const HIGH_PRICE_IMPACT_THRESHOLD = 0.15; // 15% price impact
export const MAX_ACCEPTABLE_TRANSFER_TAX_BPS = 1500; // 15% transfer tax threshold
export const RUG_DRAIN_RESERVE_COLLAPSE_RATIO = 0.1; // >90% drop in liquidity reserves

export interface EvaluateSellabilityParams {
  readonly hasRoute: boolean;
  readonly priceImpactPct?: number | undefined;
  readonly transferTaxBps?: number | undefined;
  readonly simulationError?: string | undefined;
  readonly freezeAuthorityActive?: boolean | undefined;
  readonly currentBaseReserve?: number | undefined;
  readonly initialBaseReserve?: number | undefined;
  readonly slippageBreached?: boolean | undefined;
}

export interface SellabilityEvaluationResult {
  readonly status: SellabilityStatus;
  readonly isSellable: boolean;
  readonly reason?: string | undefined;
}

/**
 * Evaluates token sellability against multi-factor failure criteria.
 */
export function evaluateSellability(
  params: EvaluateSellabilityParams,
): SellabilityEvaluationResult {
  // 1. Route Absence Check
  if (!params.hasRoute) {
    return {
      status: "UNSELLABLE_NO_ROUTE",
      isSellable: false,
      reason: "No executable swap route exists back to SOL",
    };
  }

  // 2. Transfer Restriction / Honeypot Check
  if (params.freezeAuthorityActive) {
    return {
      status: "UNSELLABLE_TRANSFER_RESTRICTION",
      isSellable: false,
      reason: "Freeze authority active on mint account",
    };
  }

  if (
    params.transferTaxBps !== undefined &&
    params.transferTaxBps > MAX_ACCEPTABLE_TRANSFER_TAX_BPS
  ) {
    return {
      status: "UNSELLABLE_TRANSFER_RESTRICTION",
      isSellable: false,
      reason: `Transfer tax ${params.transferTaxBps} bps exceeds maximum safe threshold ${MAX_ACCEPTABLE_TRANSFER_TAX_BPS} bps`,
    };
  }

  if (params.simulationError && params.simulationError.trim().length > 0) {
    return {
      status: "UNSELLABLE_TRANSFER_RESTRICTION",
      isSellable: false,
      reason: `Preflight simulation failed: ${params.simulationError}`,
    };
  }

  // 3. Liquidity Drain / Rug Pull Check
  if (
    params.initialBaseReserve !== undefined &&
    params.currentBaseReserve !== undefined &&
    params.initialBaseReserve > 0
  ) {
    const reserveRatio = params.currentBaseReserve / params.initialBaseReserve;
    if (reserveRatio <= RUG_DRAIN_RESERVE_COLLAPSE_RATIO) {
      return {
        status: "UNSELLABLE_LIQUIDITY_DRAINED",
        isSellable: false,
        reason: `Base liquidity reserve collapsed by ${((1 - reserveRatio) * 100).toFixed(1)}% since entry`,
      };
    }
  }

  // 4. Catastrophic Price Impact Check
  if (
    params.priceImpactPct !== undefined &&
    params.priceImpactPct >= CATASTROPHIC_PRICE_IMPACT_THRESHOLD
  ) {
    return {
      status: "UNSELLABLE_EXCESSIVE_IMPACT",
      isSellable: false,
      reason: `Exit price impact ${(params.priceImpactPct * 100).toFixed(2)}% exceeds catastrophic threshold ${(CATASTROPHIC_PRICE_IMPACT_THRESHOLD * 100).toFixed(2)}%`,
    };
  }

  // 5. Slippage Breach Check
  if (params.slippageBreached) {
    return {
      status: "UNSELLABLE_SLIPPAGE_EXCEEDED",
      isSellable: false,
      reason: "Realized price moved beyond maximum slippage tolerance",
    };
  }

  // 6. High Impact Impairment (Warning tier, still sellable with heavy haircut)
  if (params.priceImpactPct !== undefined && params.priceImpactPct >= HIGH_PRICE_IMPACT_THRESHOLD) {
    return {
      status: "HIGH_IMPACT_IMPAIRED",
      isSellable: true,
      reason: `High exit price impact ${(params.priceImpactPct * 100).toFixed(2)}%`,
    };
  }

  return {
    status: "FULLY_SELLABLE",
    isSellable: true,
  };
}

/**
 * Computes realized net PnL and percentage return.
 * Strictly enforces -100% total loss whenever unsellable failure states occur.
 */
export function computeRealizedExitReturn(
  entryNetCostSol: number,
  exitNetProceedsSol: number,
  sellabilityStatus: SellabilityStatus,
): {
  readonly netPnlSol: number;
  readonly netReturnPct: number;
} {
  if (entryNetCostSol <= 0) {
    throw new Error(
      "[SellabilityValidator] Entry net cost must be strictly positive to compute return.",
    );
  }

  const isUnsellable =
    sellabilityStatus === "UNSELLABLE_NO_ROUTE" ||
    sellabilityStatus === "UNSELLABLE_TRANSFER_RESTRICTION" ||
    sellabilityStatus === "UNSELLABLE_LIQUIDITY_DRAINED" ||
    sellabilityStatus === "UNSELLABLE_EXCESSIVE_IMPACT" ||
    sellabilityStatus === "UNSELLABLE_SLIPPAGE_EXCEEDED";

  if (isUnsellable) {
    return {
      netPnlSol: -entryNetCostSol,
      netReturnPct: -100.0,
    };
  }

  const netPnlSol = exitNetProceedsSol - entryNetCostSol;
  const netReturnPct = (netPnlSol / entryNetCostSol) * 100;

  return {
    netPnlSol,
    netReturnPct,
  };
}
