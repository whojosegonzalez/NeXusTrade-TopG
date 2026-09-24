export interface FormulationBQuantileResult {
  readonly q3: number;
  readonly n: number;
  readonly index0Based: number;
  readonly sortedValues: readonly number[];
}

/**
 * Derives the non-parametric third quartile (Q3) from an array of finite values
 * using the pre-registered 0-based indexing convention:
 *   k = Math.ceil(0.75 * (n - 1))
 *   Q3 = sortedValues[k]
 *
 * Constraints:
 * - n >= 1 (caller should verify support minimums, e.g., n >= 8)
 * - 0 <= k <= n - 1
 */
export function deriveThirdQuartile0Based(values: readonly number[]): FormulationBQuantileResult {
  if (values.length === 0) {
    throw new Error("FORMULATION_B_QUANTILE_EMPTY_ARRAY");
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const index0Based = Math.ceil(0.75 * (n - 1));

  if (index0Based < 0 || index0Based >= n) {
    throw new Error(`FORMULATION_B_QUANTILE_INDEX_OUT_OF_BOUNDS: ${index0Based} for length ${n}`);
  }

  const q3 = sorted[index0Based];
  if (q3 === undefined) {
    throw new Error(`FORMULATION_B_QUANTILE_ELEMENT_UNDEFINED at index ${index0Based}`);
  }

  return {
    q3,
    n,
    index0Based,
    sortedValues: sorted,
  };
}
