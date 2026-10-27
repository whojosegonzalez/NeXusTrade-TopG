/**
 * Phase 12.94-D Milestone D.3.3: Pure Calculation Helper for Legacy Raydium AMM v4 LP Accounting
 *
 * Implements strict integer arithmetic (BigInt) for evaluating the mathematical relation
 * between protocol-tracked LP amount (L = amm.lp_amount / lpReserve) and circulating
 * SPL Token mint supply (S = lpMint.supply).
 *
 * Requirements:
 * 1. Require valid unsigned 64-bit integer quantities (0 <= val <= 2^64 - 1).
 * 2. Require L > 0.
 * 3. Reject S > L.
 * 4. Calculate raw difference (L - S) and denominator (L).
 * 5. Exact 90% comparison via integer cross-multiplication: 100n * (L - S) >= 90n * L.
 * 6. Convert only display values to floating-point percentage.
 * 7. Distinguish mathematical calculation success from evidence qualification and trading eligibility.
 * 8. Retain raw numerator and denominator for independent verification.
 */

const U64_MAX = 0xffff_ffff_ffff_ffffn; // 18_446_744_073_709_551_615n

export type AmmV4LpAccountingFailureCategory =
  | "INVALID_U64_RANGE"
  | "ZERO_PROTOCOL_LP"
  | "SUPPLY_EXCEEDS_PROTOCOL_LP";

export interface AmmV4LpAccountingSuccess {
  readonly ok: true;
  /** Protocol-tracked LP amount (L = lpReserve / amm.lp_amount) */
  readonly protocolLp: bigint;
  /** Circulating SPL mint supply (S = lpMint.supply) */
  readonly circulatingSupply: bigint;
  /** Raw difference (L - S), representing inaccessible claims */
  readonly rawInaccessibleLp: bigint;
  /** Denominator (L) used for proportional claims */
  readonly rawDenominator: bigint;
  /** Exact integer cross-multiplication: 100n * (L - S) >= 90n * L */
  readonly meetsNinetyPercentThreshold: boolean;
  /** Floating-point display percentage (0.0 to 100.0) with integer pre-scaling */
  readonly displayInaccessiblePct: number;
}

export interface AmmV4LpAccountingFailure {
  readonly ok: false;
  readonly category: AmmV4LpAccountingFailureCategory;
  readonly message: string;
  readonly protocolLp?: bigint | undefined;
  readonly circulatingSupply?: bigint | undefined;
}

export type AmmV4LpAccountingResult = AmmV4LpAccountingSuccess | AmmV4LpAccountingFailure;

/**
 * Pure calculation helper for legacy Raydium AMM v4 LP accounting.
 *
 * Evaluates the mathematical relation between protocol-tracked LP amount (L)
 * and circulating SPL mint supply (S) without side effects or automatic strategy qualification.
 */
export function calculateAmmV4LpInaccessibleClaims(
  protocolLp: bigint,
  circulatingSupply: bigint,
): AmmV4LpAccountingResult {
  if (
    typeof protocolLp !== "bigint" ||
    typeof circulatingSupply !== "bigint" ||
    protocolLp < 0n ||
    protocolLp > U64_MAX ||
    circulatingSupply < 0n ||
    circulatingSupply > U64_MAX
  ) {
    return {
      ok: false,
      category: "INVALID_U64_RANGE",
      message: "Inputs must be valid unsigned 64-bit integer BigInt values (0 <= val <= 2^64 - 1)",
      protocolLp: typeof protocolLp === "bigint" ? protocolLp : undefined,
      circulatingSupply: typeof circulatingSupply === "bigint" ? circulatingSupply : undefined,
    };
  }

  if (protocolLp === 0n) {
    return {
      ok: false,
      category: "ZERO_PROTOCOL_LP",
      message: "Protocol-tracked LP amount (L) must be greater than zero",
      protocolLp,
      circulatingSupply,
    };
  }

  if (circulatingSupply > protocolLp) {
    return {
      ok: false,
      category: "SUPPLY_EXCEEDS_PROTOCOL_LP",
      message: `Circulating supply S (${circulatingSupply}) cannot exceed protocol-tracked LP L (${protocolLp})`,
      protocolLp,
      circulatingSupply,
    };
  }

  const rawInaccessibleLp = protocolLp - circulatingSupply;
  const rawDenominator = protocolLp;

  // Exact integer cross-multiplication for the 90% threshold: 100n * (L - S) >= 90n * L
  const meetsNinetyPercentThreshold = 100n * rawInaccessibleLp >= 90n * protocolLp;

  // Compute presentation percentage to six decimal places using integer truncation:
  // Number(((L - S) * 100_000_000n) / L) / 1_000_000
  const scaledNumerator = (rawInaccessibleLp * 100_000_000n) / protocolLp;
  const displayInaccessiblePct = Number(scaledNumerator) / 1_000_000;

  return {
    ok: true,
    protocolLp,
    circulatingSupply,
    rawInaccessibleLp,
    rawDenominator,
    meetsNinetyPercentThreshold,
    displayInaccessiblePct,
  };
}
