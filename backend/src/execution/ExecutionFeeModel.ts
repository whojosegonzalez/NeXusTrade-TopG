/**
 * Phase 12.94-C: Execution Fee Modeling
 *
 * Implements granular fee modeling for Solana transaction execution:
 * - Base signature network fee (5,000 lamports)
 * - Dynamic priority fees based on Compute Units (CU) and compute unit price (micro-lamports)
 * - Separation of pool-internal AMM swap fees (embedded in curve) vs external out-of-pocket fees
 * - Associated Token Account (ATA) rent creation (2,039,280 lamports) and close rebate
 *
 * Mathematically sound accounting:
 * Pool LP fees are internalized in AMM quote outputs and are NOT debited separately
 * from wallet cash balance.
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
 * Validates that an economic parameter is a non-negative finite number.
 */
function validateNonNegativeNumber(value: number, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Number.isNaN(value) || value < 0) {
    throw new Error(
      `[ExecutionFeeModel] [INVALID_PARAM] ${fieldName} must be a non-negative finite number, received: ${String(value)}`,
    );
  }
  return value;
}

/**
 * Validates that a fee rate is between 0 and 1 exclusive of 1.
 * Rates >= 1 cause zero effective output or infinite effective price and are rejected.
 */
export function validateFeeRate(rate: number): number {
  if (
    typeof rate !== "number" ||
    !Number.isFinite(rate) ||
    Number.isNaN(rate) ||
    rate < 0 ||
    rate >= 1
  ) {
    throw new Error(
      `[ExecutionFeeModel] [INVALID_FEE_RATE] Fee rate must be a finite number between 0 (inclusive) and 1 (exclusive), received: ${String(rate)}`,
    );
  }
  return rate;
}

/**
 * Computes priority fee in lamports: (computeUnits * microLamportsPerCu) / 1,000,000.
 */
export function computePriorityFeeLamports(options?: ComputePriorityFeeOptions): number {
  const rawCu = options?.computeUnits ?? DEFAULT_COMPUTE_UNITS;
  const rawMicroLamports =
    options?.microLamportsPerCu ?? DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS_PER_CU;

  validateNonNegativeNumber(rawCu, "computeUnits");
  validateNonNegativeNumber(rawMicroLamports, "microLamportsPerCu");

  const cu = Math.max(0, Math.min(MAX_COMPUTE_UNITS, Math.floor(rawCu)));
  const microLamports = Math.floor(rawMicroLamports);
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
 * Note: dexFeeLamports is recorded as poolInternalFeeLamports (informational only);
 * it is NOT debited from out-of-pocket wallet cash because it is already deducted in AMM output.
 */
export function calculateEntryFees(options: EntryFeeCalculationOptions): ExecutionFeeBreakdown {
  validateNonNegativeNumber(options.sizeLamports, "sizeLamports");
  const dexFeeRate = validateFeeRate(options.dexFeeRate ?? DEFAULT_RAYDIUM_AMM_FEE_RATE);

  const baseNetworkFeeLamports = BASE_NETWORK_FEE_LAMPORTS;
  const priorityFeeLamports = computePriorityFeeLamports({
    computeUnits: options.computeUnits,
    microLamportsPerCu: options.microLamportsPerCu,
  });

  const externalNetworkFeeLamports = baseNetworkFeeLamports + priorityFeeLamports;
  const externalNetworkFeeSol = externalNetworkFeeLamports / LAMPORTS_PER_SOL;

  const poolInternalFeeLamports = Math.round(options.sizeLamports * dexFeeRate);
  const poolInternalFeeSol = poolInternalFeeLamports / LAMPORTS_PER_SOL;

  const ataRentDepositLamports = options.isNewAta ? ATA_RENT_EXEMPT_LAMPORTS : 0;
  const ataRentRefundLamports = 0;

  const totalOutOfPocketFeeLamports = externalNetworkFeeLamports + ataRentDepositLamports;
  const totalOutOfPocketFeeSol = totalOutOfPocketFeeLamports / LAMPORTS_PER_SOL;

  return {
    baseNetworkFeeLamports,
    priorityFeeLamports,
    externalNetworkFeeLamports,
    externalNetworkFeeSol,
    poolInternalFeeLamports,
    poolInternalFeeSol,
    ataRentDepositLamports,
    ataRentRefundLamports,
    totalOutOfPocketFeeLamports,
    totalOutOfPocketFeeSol,
  };
}

export interface ExitFeeCalculationOptions {
  readonly grossSolProceedsLamports: number;
  readonly dexFeeRate?: number | undefined;
  readonly closeAta?: boolean | undefined;
  /**
   * Indicates whether an ATA was actually opened and funded for this token.
   * Required for rent refund rebate eligibility. If closeAta is requested without
   * prior funding, refund entitlement is absent (0 lamports).
   */
  readonly hasFundedAta?: boolean | undefined;
  readonly computeUnits?: number | undefined;
  readonly microLamportsPerCu?: number | undefined;
}

/**
 * Calculates complete fee breakdown for an exit (Token -> SOL) trade.
 * Note: dexFeeLamports is recorded as poolInternalFeeLamports (informational only);
 * it is NOT debited from out-of-pocket wallet cash.
 * If closeAta is true and hasFundedAta is true, the ATA rent deposit is refunded,
 * producing a signed net cash credit if the refund exceeds external network fees.
 */
export function calculateExitFees(options: ExitFeeCalculationOptions): ExecutionFeeBreakdown {
  validateNonNegativeNumber(options.grossSolProceedsLamports, "grossSolProceedsLamports");
  const dexFeeRate = validateFeeRate(options.dexFeeRate ?? DEFAULT_RAYDIUM_AMM_FEE_RATE);

  const baseNetworkFeeLamports = BASE_NETWORK_FEE_LAMPORTS;
  const priorityFeeLamports = computePriorityFeeLamports({
    computeUnits: options.computeUnits,
    microLamportsPerCu: options.microLamportsPerCu,
  });

  const externalNetworkFeeLamports = baseNetworkFeeLamports + priorityFeeLamports;
  const externalNetworkFeeSol = externalNetworkFeeLamports / LAMPORTS_PER_SOL;

  const poolInternalFeeLamports = Math.round(options.grossSolProceedsLamports * dexFeeRate);
  const poolInternalFeeSol = poolInternalFeeLamports / LAMPORTS_PER_SOL;

  const ataRentDepositLamports = 0;
  // Rebate eligibility requires BOTH closeAta === true AND an established funded ATA (hasFundedAta === true)
  // If closeAta is requested without prior funded status, refund entitlement is absent (0 lamports).
  const isEligibleForRefund = options.closeAta === true && options.hasFundedAta === true;
  const ataRentRefundLamports = isEligibleForRefund ? ATA_RENT_EXEMPT_LAMPORTS : 0;

  // Signed net out-of-pocket cash movement:
  // Positive = wallet cash debited (fees paid)
  // Negative = wallet cash credited (rent refund exceeds external network fees)
  const totalOutOfPocketFeeLamports =
    externalNetworkFeeLamports + ataRentDepositLamports - ataRentRefundLamports;
  const totalOutOfPocketFeeSol = totalOutOfPocketFeeLamports / LAMPORTS_PER_SOL;

  return {
    baseNetworkFeeLamports,
    priorityFeeLamports,
    externalNetworkFeeLamports,
    externalNetworkFeeSol,
    poolInternalFeeLamports,
    poolInternalFeeSol,
    ataRentDepositLamports,
    ataRentRefundLamports,
    totalOutOfPocketFeeLamports,
    totalOutOfPocketFeeSol,
  };
}
