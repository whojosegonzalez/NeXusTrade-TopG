/**
 * Phase 12.94-C: Capital Scaling & Capacity Curve Analyzer
 *
 * Implements state-conserving AMM round-trip execution sweeps across
 * 0.1, 0.5, 2.0, and 10.0 SOL tiers:
 * - Accurately updates pool reserve state after buying:
 *     R'_{sol} = R_{sol} + S_in,  R'_{token} = R_{token} - T_bought
 * - Coherently models exogenous price shocks (R''_{sol} = R'_{sol} * sqrt(M), R''_{token} = R'_{token} / sqrt(M))
 *   and liquidity withdrawals / independent observed exit reserves
 * - Sells tokens back into the coherent post-buy reserve state
 * - Deducts out-of-pocket network fees once; does not double-count pool-internal LP fees
 * - Computes Optimal Size (S*) and the Alpha Extinction Threshold (S_extinct)
 */

import type { CapacityCurveResult, CapacityTierSweep } from "./ExecutionTypes.js";
import {
  calculateAmmBuyQuote,
  calculateAmmSellQuote,
  validateMintDecimals,
  validateStrictlyPositiveFinite,
} from "./QuoteExecutionEngine.js";
import {
  calculateEntryFees,
  calculateExitFees,
  DEFAULT_RAYDIUM_AMM_FEE_RATE,
  LAMPORTS_PER_SOL,
  validateFeeRate,
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
  /**
   * Optional liquidity withdrawal ratio (0.0 to 0.99) between entry and exit.
   * E.g. 0.25 means 25% of pool liquidity was withdrawn by other market participants.
   */
  readonly reserveWithdrawalRatio?: number | undefined;
  /**
   * Optional independently observed exit reserves from a later telemetry observation.
   */
  readonly observedExitReserveSol?: number | undefined;
  readonly observedExitReserveTokens?: number | undefined;
  readonly dexFeeRate?: number | undefined;
  readonly priorityFeeMicroLamports?: number | undefined;
  readonly computeUnits?: number | undefined;
  readonly capitalTiersSol?: readonly number[] | undefined;
}

/**
 * Analyzes the capital capacity curve across multiple trade sizes using
 * state-conserving AMM reserve transitions.
 */
export function analyzeCapacityCurve(params: AnalyzeCapacityCurveParams): CapacityCurveResult {
  const decimals = validateMintDecimals(params.tokenDecimals);
  validateStrictlyPositiveFinite(params.quoteReserveSol, "quoteReserveSol");
  validateStrictlyPositiveFinite(params.baseReserveTokens, "baseReserveTokens");

  if (params.exitPriceMultiplier !== undefined) {
    if (
      typeof params.exitPriceMultiplier !== "number" ||
      !Number.isFinite(params.exitPriceMultiplier) ||
      Number.isNaN(params.exitPriceMultiplier) ||
      params.exitPriceMultiplier <= 0
    ) {
      throw new Error(
        `[CapacityCurveAnalyzer] [INVALID_PARAM] exitPriceMultiplier must be a strictly positive finite number, received: ${String(params.exitPriceMultiplier)}`,
      );
    }
  }
  const exitMultiplier = params.exitPriceMultiplier ?? 1.0;

  if (params.reserveWithdrawalRatio !== undefined) {
    if (
      typeof params.reserveWithdrawalRatio !== "number" ||
      !Number.isFinite(params.reserveWithdrawalRatio) ||
      Number.isNaN(params.reserveWithdrawalRatio) ||
      params.reserveWithdrawalRatio < 0 ||
      params.reserveWithdrawalRatio >= 1.0
    ) {
      throw new Error(
        `[CapacityCurveAnalyzer] [INVALID_PARAM] reserveWithdrawalRatio must be a finite number between 0 (inclusive) and 1 (exclusive), received: ${String(params.reserveWithdrawalRatio)}`,
      );
    }
  }
  const withdrawalRatio = params.reserveWithdrawalRatio ?? 0;

  if (params.observedExitReserveSol !== undefined) {
    validateStrictlyPositiveFinite(params.observedExitReserveSol, "observedExitReserveSol");
  }
  if (params.observedExitReserveTokens !== undefined) {
    validateStrictlyPositiveFinite(params.observedExitReserveTokens, "observedExitReserveTokens");
  }
  if (params.capitalTiersSol !== undefined) {
    if (!Array.isArray(params.capitalTiersSol) || params.capitalTiersSol.length === 0) {
      throw new Error(
        `[CapacityCurveAnalyzer] [INVALID_PARAM] capitalTiersSol must be a non-empty array of positive numbers`,
      );
    }
    for (const t of params.capitalTiersSol) {
      validateStrictlyPositiveFinite(t, "capitalTier");
    }
  }

  const tiers = params.capitalTiersSol ?? DEFAULT_CAPITAL_TIERS_SOL;
  const withdrawalFactor = 1 - withdrawalRatio;
  const dexFeeRate = validateFeeRate(params.dexFeeRate ?? DEFAULT_RAYDIUM_AMM_FEE_RATE);

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

    // Out-of-pocket cash cost = trade size + external network fees (LP fee is inside the curve)
    const totalEntryCostSol = tierSizeSol + entryFees.externalNetworkFeeSol;

    // 1. Buy Quote on Initial Pool Reserves (R_sol,0, R_token,0)
    const buyQuote = calculateAmmBuyQuote({
      inputSol: tierSizeSol,
      baseReserveTokens: params.baseReserveTokens,
      quoteReserveSol: params.quoteReserveSol,
      tokenDecimals: decimals,
      dexFeeRate,
    });

    const tokensReceived = buyQuote.tokensGross;
    const effectivePriceSol = buyQuote.effectivePriceSol;

    // 2. Coherent Post-Buy Pool Reserve State (R_sol,1, R_token,1)
    // SOL was added to pool, tokens were withdrawn from pool
    const postBuyReserveSol = params.quoteReserveSol + tierSizeSol;
    const postBuyReserveTokens = Math.max(0.000001, params.baseReserveTokens - tokensReceived);

    // 3. Exogenous Market Price Movement / Reserve Shift Scenario
    let exitReserveSol: number;
    let exitReserveTokens: number;

    if (
      params.observedExitReserveSol !== undefined &&
      params.observedExitReserveTokens !== undefined
    ) {
      exitReserveSol = params.observedExitReserveSol;
      exitReserveTokens = params.observedExitReserveTokens;
    } else {
      const sqrtM = Math.sqrt(exitMultiplier);
      exitReserveSol = postBuyReserveSol * sqrtM * withdrawalFactor;
      exitReserveTokens = (postBuyReserveTokens / sqrtM) * withdrawalFactor;
    }

    // 4. Sell Leg Executed on Coherent Exit Pool Reserves
    const sellQuote = calculateAmmSellQuote({
      inputTokens: tokensReceived,
      baseReserveTokens: exitReserveTokens,
      quoteReserveSol: exitReserveSol,
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

    // Net exit cash proceeds: gross proceeds minus external network fee
    const netExitProceedsSol = Math.max(0, grossExitProceedsSol - exitFees.externalNetworkFeeSol);
    const netPnlSol = netExitProceedsSol - totalEntryCostSol;
    const netReturnPct = (netPnlSol / totalEntryCostSol) * 100;

    const totalExternalFeeSol = entryFees.externalNetworkFeeSol + exitFees.externalNetworkFeeSol;
    const priceImpactBps = Math.round((buyQuote.priceImpactPct + sellQuote.priceImpactPct) * 10000);
    const externalFeeDragBps = Math.round((totalExternalFeeSol / tierSizeSol) * 10000);
    const poolInternalFeeBps = Math.round(2 * dexFeeRate * 10000); // 2 legs of LP fee
    const isViable = netReturnPct > 0;

    sweeps.push({
      tierSizeSol,
      tokensReceived,
      effectivePriceSol,
      postBuyReserveSol,
      postBuyReserveTokens,
      grossExitProceedsSol,
      netExitProceedsSol,
      netPnlSol,
      netReturnPct,
      priceImpactBps,
      externalFeeDragBps,
      poolInternalFeeBps,
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

  // Baseline tier (0.50 SOL) viability check
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
