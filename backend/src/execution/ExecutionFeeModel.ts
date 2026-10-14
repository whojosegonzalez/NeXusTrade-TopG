/**
 * Phase 12.94-C: Execution Fee Modeling
 *
 * Implements granular fee modeling for Solana transaction execution:
 * - Base signature fee (5,000 lamports)
 * - Dynamic priority fees based on Compute Units (CU) and compute unit price (micro-lamports)
 * - DEX liquidity provider swap fees (e.g. 25 bps for Raydium V4)
 * - Associated Token Account (ATA) rent creation (2,039,280 lamports) and close rebate
 */

import type { ExecutionFeeBreakdown } from "./ExecutionTypes.js";

export const BASE_NETWORK_FEE_LAMPORTS = 5_000;
export const DEFAULT_COMPUTE_UNITS = 200_000;
export const MAX_COMPUTE_UNITS = 1_400_000;
export const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS_PER_CU = 50_000;
export const ATA_RENT_EXEMPT_LAMPORTS = 2_039_280;
export const DEFAULT_RAYDIUM_AMM_FEE_RATE = 0.0025; // 25 bps
export const LAMPORTS_PER_SOL = 1_000_000_000;

export interface ComputePriorityFeeOptions {
  readonly computeUnits?: number | undefined;
  readonly microLamportsPerCu?: number | undefined;
}

/**
 * Computes priority fee in lamports: (computeUnits * microLamportsPerCu) / 1,000,000.
 */
export function computePriorityFeeLamports(options?: ComputePriorityFeeOptions): number {
  const cu = Math.max(
    0,
    Math.min(MAX_COMPUTE_UNITS, options?.computeUnits ?? DEFAULT_COMPUTE_UNITS),
  );
  const microLamports = Math.max(
    0,
    options?.microLamportsPerCu ?? DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS_PER_CU,
  );
  return Math.round((cu * microLamports) / 1_000_000);
}

export interface EntryFeeCalculationOptions {
  readonly sizeLamports: number;
  readonly dexFeeRate?: number | undefined;
  readonly isNewAta?: boolean | undefined;
  readonly computeUnits?: number | undefined;
  readonly microLamportsPerCu?: number | undefined;
}

/**
 * Calculates complete fee breakdown for an entry (SOL -> Token) trade.
 */
export function calculateEntryFees(options: EntryFeeCalculationOptions): ExecutionFeeBreakdown {
  if (options.sizeLamports < 0) {
    throw new Error("[ExecutionFeeModel] Size in lamports cannot be negative.");
  }
  const baseFeeLamports = BASE_NETWORK_FEE_LAMPORTS;
  const priorityFeeLamports = computePriorityFeeLamports({
    computeUnits: options.computeUnits,
    microLamportsPerCu: options.microLamportsPerCu,
  });
  const dexFeeRate = options.dexFeeRate ?? DEFAULT_RAYDIUM_AMM_FEE_RATE;
  const dexFeeLamports = Math.round(options.sizeLamports * dexFeeRate);
  const ataCreationRentLamports = options.isNewAta ? ATA_RENT_EXEMPT_LAMPORTS : 0;
  const ataRebateLamports = 0;

  const totalFeeLamports =
    baseFeeLamports + priorityFeeLamports + dexFeeLamports + ataCreationRentLamports;
  const totalFeeSol = totalFeeLamports / LAMPORTS_PER_SOL;

  return {
    baseFeeLamports,
    priorityFeeLamports,
    dexFeeLamports,
    ataCreationRentLamports,
    ataRebateLamports,
    totalFeeLamports,
    totalFeeSol,
  };
}

export interface ExitFeeCalculationOptions {
  readonly grossSolProceedsLamports: number;
  readonly dexFeeRate?: number | undefined;
  readonly closeAta?: boolean | undefined;
  readonly computeUnits?: number | undefined;
  readonly microLamportsPerCu?: number | undefined;
}

/**
 * Calculates complete fee breakdown for an exit (Token -> SOL) trade.
 * Note: If closeAta is true, rent exemption is rebated, reducing the net fee drag.
 */
export function calculateExitFees(options: ExitFeeCalculationOptions): ExecutionFeeBreakdown {
  if (options.grossSolProceedsLamports < 0) {
    throw new Error("[ExecutionFeeModel] Gross proceeds in lamports cannot be negative.");
  }
  const baseFeeLamports = BASE_NETWORK_FEE_LAMPORTS;
  const priorityFeeLamports = computePriorityFeeLamports({
    computeUnits: options.computeUnits,
    microLamportsPerCu: options.microLamportsPerCu,
  });
  const dexFeeRate = options.dexFeeRate ?? DEFAULT_RAYDIUM_AMM_FEE_RATE;
  const dexFeeLamports = Math.round(options.grossSolProceedsLamports * dexFeeRate);
  const ataCreationRentLamports = 0;
  const ataRebateLamports = options.closeAta ? ATA_RENT_EXEMPT_LAMPORTS : 0;

  const totalFeeLamports = Math.max(
    0,
    baseFeeLamports + priorityFeeLamports + dexFeeLamports - ataRebateLamports,
  );
  const totalFeeSol = totalFeeLamports / LAMPORTS_PER_SOL;

  return {
    baseFeeLamports,
    priorityFeeLamports,
    dexFeeLamports,
    ataCreationRentLamports,
    ataRebateLamports,
    totalFeeLamports,
    totalFeeSol,
  };
}
