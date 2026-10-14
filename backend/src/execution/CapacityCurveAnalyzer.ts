/**
 * Phase 12.94-C: Capital Scaling & Capacity Curve Analyzer
 *
 * Implements multi-size capital sweeps across 0.1, 0.5, 2.0, and 10.0 SOL tiers
 * to evaluate liquidity capacity, price impact scaling, fee drag, optimal allocation (S*),
 * and the Alpha Extinction Threshold (S_extinct).
 */

import type { CapacityCurveResult, CapacityTierSweep } from "./ExecutionTypes.js";
import {
  calculateAmmBuyQuote,
  calculateAmmSellQuote,
  validateMintDecimals,
} from "./QuoteExecutionEngine.js";
import {
  calculateEntryFees,
  calculateExitFees,
  DEFAULT_RAYDIUM_AMM_FEE_RATE,
  LAMPORTS_PER_SOL,
} from "./ExecutionFeeModel.js";

export const DEFAULT_CAPITAL_TIERS_SOL: readonly number[] = [0.1, 0.5, 2.0, 10.0];

export interface AnalyzeCapacityCurveParams {
  readonly mintAddress: string;
  readonly poolId: string;
  readonly baseReserveTokens: number;
  readonly quoteReserveSol: number;
  readonly tokenDecimals: number;
  /**
   * Price movement multiplier for the exit leg.
   * Default: 1.0 (evaluates pure roundtrip liquidity/fee frictional viability).
   * E.g., 1.5 tests viability if the token moved +50% at peak.
   */
  readonly exitPriceMultiplier?: number | undefined;
  readonly dexFeeRate?: number | undefined;
  readonly priorityFeeMicroLamports?: number | undefined;
  readonly computeUnits?: number | undefined;
  readonly capitalTiersSol?: readonly number[] | undefined;
}

/**
 * Analyzes the capital capacity curve across multiple trade sizes.
 */
export function analyzeCapacityCurve(params: AnalyzeCapacityCurveParams): CapacityCurveResult {
  const decimals = validateMintDecimals(params.tokenDecimals);
  const tiers = params.capitalTiersSol ?? DEFAULT_CAPITAL_TIERS_SOL;
  const exitMultiplier = params.exitPriceMultiplier ?? 1.0;
  const dexFeeRate = params.dexFeeRate ?? DEFAULT_RAYDIUM_AMM_FEE_RATE;

  const sweeps: CapacityTierSweep[] = [];

  for (const tierSizeSol of tiers) {
    if (tierSizeSol <= 0) continue;

    const inputLamports = Math.round(tierSizeSol * LAMPORTS_PER_SOL);
    const entryFees = calculateEntryFees({
      sizeLamports: inputLamports,
      dexFeeRate,
      isNewAta: false,
      computeUnits: params.computeUnits,
      microLamportsPerCu: params.priorityFeeMicroLamports,
    });

    const totalEntryCostSol = tierSizeSol + entryFees.totalFeeSol;

    // 1. Buy Quote
    const buyQuote = calculateAmmBuyQuote({
      inputSol: tierSizeSol,
      baseReserveTokens: params.baseReserveTokens,
      quoteReserveSol: params.quoteReserveSol,
      tokenDecimals: decimals,
      dexFeeRate,
    });

    const tokensReceived = buyQuote.tokensGross;
    const effectivePriceSol = buyQuote.effectivePriceSol;

    // 2. Simulated Exit Leg
    // Adjust reserves for exit leg based on exitMultiplier (if token appreciated, quoteReserve increased)
    const adjustedQuoteReserveSol = params.quoteReserveSol * exitMultiplier;
    const adjustedBaseReserveTokens = params.baseReserveTokens;

    const sellQuote = calculateAmmSellQuote({
      inputTokens: tokensReceived,
      baseReserveTokens: adjustedBaseReserveTokens,
      quoteReserveSol: adjustedQuoteReserveSol,
      tokenDecimals: decimals,
      dexFeeRate,
    });

    const grossExitProceedsSol = sellQuote.solGross;
    const grossExitLamports = Math.round(grossExitProceedsSol * LAMPORTS_PER_SOL);

    const exitFees = calculateExitFees({
      grossSolProceedsLamports: grossExitLamports,
      dexFeeRate,
      closeAta: false,
      computeUnits: params.computeUnits,
      microLamportsPerCu: params.priorityFeeMicroLamports,
    });

    const netExitProceedsSol = Math.max(0, grossExitProceedsSol - exitFees.totalFeeSol);
    const netPnlSol = netExitProceedsSol - totalEntryCostSol;
    const netReturnPct = (netPnlSol / totalEntryCostSol) * 100;

    const totalFeeSol = entryFees.totalFeeSol + exitFees.totalFeeSol;
    const priceImpactBps = Math.round((buyQuote.priceImpactPct + sellQuote.priceImpactPct) * 10000);
    const totalFeeDragBps = Math.round((totalFeeSol / tierSizeSol) * 10000);
    const isViable = netReturnPct > 0;

    sweeps.push({
      tierSizeSol,
      tokensReceived,
      effectivePriceSol,
      grossExitProceedsSol,
      netExitProceedsSol,
      netPnlSol,
      netReturnPct,
      priceImpactBps,
      totalFeeDragBps,
      isViable,
    });
  }

  // Find Optimal Size (S*) - Size maximizing absolute Net SOL profit
  let optimalSizeSol: number | null = null;
  let maxPnlSol = -Infinity;
  for (const sweep of sweeps) {
    if (sweep.netPnlSol > 0 && sweep.netPnlSol > maxPnlSol) {
      maxPnlSol = sweep.netPnlSol;
      optimalSizeSol = sweep.tierSizeSol;
    }
  }

  // Find Alpha Extinction Threshold (S_extinct) - Capital size where netReturnPct drops to <= 0%
  let alphaExtinctionThresholdSol: number | null = null;
  for (let i = 0; i < sweeps.length; i++) {
    const current = sweeps[i]!;
    if (current.netReturnPct <= 0) {
      if (i === 0) {
        // Even the smallest tier is non-viable
        alphaExtinctionThresholdSol = current.tierSizeSol;
      } else {
        const prev = sweeps[i - 1]!;
        // Linear interpolation between prev (positive) and current (negative/zero)
        const returnDiff = prev.netReturnPct - current.netReturnPct;
        if (returnDiff > 0) {
          const fraction = prev.netReturnPct / returnDiff;
          const sizeDiff = current.tierSizeSol - prev.tierSizeSol;
          alphaExtinctionThresholdSol = prev.tierSizeSol + fraction * sizeDiff;
        } else {
          alphaExtinctionThresholdSol = current.tierSizeSol;
        }
      }
      break;
    }
  }

  // Viable if baseline tier (0.50 SOL) or any standard tier is viable
  const baselineSweep = sweeps.find((s) => Math.abs(s.tierSizeSol - 0.5) < 0.01) ?? sweeps[0];
  const isEconomicallyViable = baselineSweep ? baselineSweep.isViable : false;

  return {
    mintAddress: params.mintAddress,
    poolId: params.poolId,
    sweeps,
    optimalSizeSol,
    alphaExtinctionThresholdSol:
      alphaExtinctionThresholdSol !== null
        ? Math.round(alphaExtinctionThresholdSol * 1000) / 1000
        : null,
    isEconomicallyViable,
  };
}
