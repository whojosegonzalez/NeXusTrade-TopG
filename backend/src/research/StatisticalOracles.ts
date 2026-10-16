/**
 * Phase 12.94-D Milestone D.2.1: Reference Mathematical & Financial Test Oracles
 *
 * Implements authoritative mathematical reference oracles for:
 * 1. Hájek & Horvitz-Thompson weighted survey estimators using valid persisted inclusion probabilities.
 * 2. Cameron-Gelbach-Miller (2011) two-way cluster-robust covariance matrix with small-cluster safeguards.
 * 3. Authoritative Phase 12.94-C stateful AMM execution waterfall with exact single-internal LP fee deduction.
 */

export interface HajekResult {
  readonly estimate: number;
  readonly sumWeights: number;
  readonly effectiveSampleSize: number;
}

export const MIN_SUPPORTED_INCLUSION_PROBABILITY = 1e-15;

/**
 * Computes the design-based Hájek estimator of the population mean:
 * \hat{\mu}_{Hajek} = (\sum Y_i / \pi_i) / (\sum 1 / \pi_i)
 */
export function computeHajekMean(
  values: readonly number[],
  inclusionProbabilities: readonly number[],
): HajekResult {
  if (values.length === 0) {
    throw new Error("[StatisticalOracles] computeHajekMean: sample values cannot be empty.");
  }
  if (values.length !== inclusionProbabilities.length) {
    throw new Error(
      `[StatisticalOracles] computeHajekMean: length mismatch (values: ${values.length}, probs: ${inclusionProbabilities.length}).`,
    );
  }

  let weightedSum = 0;
  let sumWeights = 0;
  let sumWeightsSquared = 0;

  for (let i = 0; i < values.length; i++) {
    const y = values[i]!;
    const pi = inclusionProbabilities[i]!;

    if (typeof y !== "number" || !Number.isFinite(y)) {
      throw new Error(
        `[StatisticalOracles] computeHajekMean: invalid non-finite value at index ${i}: ${y}`,
      );
    }
    if (typeof pi !== "number" || !Number.isFinite(pi) || pi <= 0 || pi > 1) {
      throw new Error(
        `[StatisticalOracles] computeHajekMean: invalid inclusion probability at index ${i}: ${pi} (must be in (0, 1]).`,
      );
    }
    if (pi < MIN_SUPPORTED_INCLUSION_PROBABILITY) {
      throw new Error(
        `[StatisticalOracles] computeHajekMean: inclusion probability at index ${i} (${pi}) is below minimum supported threshold (${MIN_SUPPORTED_INCLUSION_PROBABILITY}), causing numerical overflow.`,
      );
    }

    const w = 1 / pi;
    if (!Number.isFinite(w) || w <= 0) {
      throw new Error(
        `[StatisticalOracles] computeHajekMean: inverse weight overflow at index ${i} (w = ${w}).`,
      );
    }

    const term = y * w;
    if (!Number.isFinite(term)) {
      throw new Error(
        `[StatisticalOracles] computeHajekMean: weighted value term overflow at index ${i}.`,
      );
    }

    weightedSum += term;
    sumWeights += w;
    sumWeightsSquared += w * w;

    if (
      !Number.isFinite(weightedSum) ||
      !Number.isFinite(sumWeights) ||
      !Number.isFinite(sumWeightsSquared)
    ) {
      throw new Error(
        `[StatisticalOracles] computeHajekMean: intermediate sum overflow at index ${i}.`,
      );
    }
  }

  if (sumWeights <= 0 || sumWeightsSquared <= 0) {
    throw new Error("[StatisticalOracles] computeHajekMean: sum of weights is non-positive.");
  }

  const estimate = weightedSum / sumWeights;
  // Kish's effective sample size: (sum w)^2 / sum(w^2)
  const effectiveSampleSize = (sumWeights * sumWeights) / sumWeightsSquared;

  if (!Number.isFinite(estimate)) {
    throw new Error(
      `[StatisticalOracles] computeHajekMean: calculated estimate is non-finite (${estimate}).`,
    );
  }
  if (!Number.isFinite(effectiveSampleSize) || effectiveSampleSize <= 0) {
    throw new Error(
      `[StatisticalOracles] computeHajekMean: calculated effectiveSampleSize is non-positive or non-finite (${effectiveSampleSize}).`,
    );
  }

  return {
    estimate,
    sumWeights,
    effectiveSampleSize,
  };
}

/**
 * Computes the Horvitz-Thompson estimator of the population total:
 * \hat{Y}_{HT} = \sum Y_i / \pi_i
 */
export function computeHorvitzThompsonTotal(
  values: readonly number[],
  inclusionProbabilities: readonly number[],
): number {
  if (values.length === 0) {
    throw new Error(
      "[StatisticalOracles] computeHorvitzThompsonTotal: sample values cannot be empty.",
    );
  }
  if (values.length !== inclusionProbabilities.length) {
    throw new Error("[StatisticalOracles] computeHorvitzThompsonTotal: length mismatch.");
  }

  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const y = values[i]!;
    const pi = inclusionProbabilities[i]!;
    if (typeof y !== "number" || !Number.isFinite(y)) {
      throw new Error(
        `[StatisticalOracles] computeHorvitzThompsonTotal: invalid non-finite value at index ${i}: ${y}`,
      );
    }
    if (typeof pi !== "number" || !Number.isFinite(pi) || pi <= 0 || pi > 1) {
      throw new Error(
        `[StatisticalOracles] computeHorvitzThompsonTotal: invalid inclusion probability at index ${i}: ${pi}`,
      );
    }
    if (pi < MIN_SUPPORTED_INCLUSION_PROBABILITY) {
      throw new Error(
        `[StatisticalOracles] computeHorvitzThompsonTotal: inclusion probability at index ${i} (${pi}) is below minimum supported threshold (${MIN_SUPPORTED_INCLUSION_PROBABILITY}).`,
      );
    }
    const term = y / pi;
    if (!Number.isFinite(term)) {
      throw new Error(
        `[StatisticalOracles] computeHorvitzThompsonTotal: term overflow at index ${i}.`,
      );
    }
    total += term;
    if (!Number.isFinite(total)) {
      throw new Error(
        `[StatisticalOracles] computeHorvitzThompsonTotal: total overflowed to non-finite.`,
      );
    }
  }
  return total;
}

export interface TwoWayClusterResult {
  readonly vcovMatrix: number[][];
  readonly standardErrors: number[];
  readonly numClustersSession: number;
  readonly numClustersMint: number;
  readonly isSmallClusterWarning: boolean;
  readonly smallClusterNote?: string | undefined;
}

/**
 * Inverts a small 2x2 matrix analytically: (X^T X)^{-1}
 */
function invert2x2(matrix: number[][]): number[][] {
  const a = matrix[0]![0]!;
  const b = matrix[0]![1]!;
  const c = matrix[1]![0]!;
  const d = matrix[1]![1]!;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) {
    throw new Error("[StatisticalOracles] Matrix is singular or near-singular.");
  }
  return [
    [d / det, -b / det],
    [-c / det, a / det],
  ];
}

/**
 * Multiplies two matrices A (m x n) and B (n x p).
 */
function multiplyMatrices(A: number[][], B: number[][]): number[][] {
  const m = A.length;
  const n = A[0]!.length;
  const p = B[0]!.length;
  const C: number[][] = Array.from({ length: m }, () => Array(p).fill(0));
  for (let i = 0; i < m; i++) {
    const rowC = C[i]!;
    const rowA = A[i]!;
    for (let k = 0; k < n; k++) {
      const a_ik = rowA[k]!;
      const rowB = B[k]!;
      for (let j = 0; j < p; j++) {
        rowC[j] = (rowC[j] ?? 0) + a_ik * rowB[j]!;
      }
    }
  }
  return C;
}

/**
 * Computes single-cluster sandwich component: (X^T X)^{-1} [ \sum_g X_g^T u_g u_g^T X_g ] (X^T X)^{-1}
 */
function computeSingleClusterSandwich(
  X: readonly number[][],
  residuals: readonly number[],
  invXtX: number[][],
  clusters: readonly string[],
): number[][] {
  const p = X[0]!.length;
  // Group row indices by cluster ID
  const clusterGroups = new Map<string, number[]>();
  for (let i = 0; i < clusters.length; i++) {
    const cid = clusters[i]!;
    if (!clusterGroups.has(cid)) clusterGroups.set(cid, []);
    clusterGroups.get(cid)!.push(i);
  }

  // Sum outer products of score vectors: S_g = \sum_{i \in g} X_i * u_i
  const meat: number[][] = Array.from({ length: p }, () => Array(p).fill(0));

  for (const indices of clusterGroups.values()) {
    const score_g: number[] = Array(p).fill(0);
    for (const idx of indices) {
      const u = residuals[idx]!;
      const rowX = X[idx]!;
      for (let col = 0; col < p; col++) {
        score_g[col] = (score_g[col] ?? 0) + rowX[col]! * u;
      }
    }
    for (let r = 0; r < p; r++) {
      const rowMeat = meat[r]!;
      for (let c = 0; c < p; c++) {
        rowMeat[c] = (rowMeat[c] ?? 0) + score_g[r]! * score_g[c]!;
      }
    }
  }

  return multiplyMatrices(multiplyMatrices(invXtX, meat), invXtX);
}

/**
 * Computes Cameron-Gelbach-Miller (2011) two-way cluster covariance matrix:
 * V_{two-way} = V_{session} + V_{mint} - V_{session \cap mint}
 */
export function computeTwoWayClusterCovariance(
  residuals: readonly number[],
  X: readonly number[][],
  sessionIds: readonly string[],
  mintAddresses: readonly string[],
): TwoWayClusterResult {
  const n = residuals.length;
  if (n === 0 || X.length !== n || sessionIds.length !== n || mintAddresses.length !== n) {
    throw new Error("[StatisticalOracles] Input array lengths must match and be non-empty.");
  }

  // 1. Validate residuals and identifiers
  for (let i = 0; i < n; i++) {
    const u = residuals[i];
    if (typeof u !== "number" || !Number.isFinite(u)) {
      throw new Error(
        `[StatisticalOracles] computeTwoWayClusterCovariance: non-finite residual at index ${i}: ${u}`,
      );
    }
    const sid = sessionIds[i];
    if (typeof sid !== "string" || sid.trim().length === 0) {
      throw new Error(
        `[StatisticalOracles] computeTwoWayClusterCovariance: empty or invalid sessionId at index ${i}`,
      );
    }
    const mid = mintAddresses[i];
    if (typeof mid !== "string" || mid.trim().length === 0) {
      throw new Error(
        `[StatisticalOracles] computeTwoWayClusterCovariance: empty or invalid mintAddress at index ${i}`,
      );
    }
  }

  // 2. Validate design matrix X
  const p = X[0]?.length;
  if (p !== 2) {
    throw new Error(
      "[StatisticalOracles] Currently supporting 2-parameter design matrix (intercept + feature).",
    );
  }
  for (let i = 0; i < n; i++) {
    const row = X[i];
    if (!Array.isArray(row) || row.length !== p) {
      throw new Error(
        `[StatisticalOracles] computeTwoWayClusterCovariance: invalid row length at X[${i}]`,
      );
    }
    for (let c = 0; c < p; c++) {
      const val = row[c];
      if (typeof val !== "number" || !Number.isFinite(val)) {
        throw new Error(
          `[StatisticalOracles] computeTwoWayClusterCovariance: non-finite entry at X[${i}][${c}]: ${val}`,
        );
      }
    }
  }

  // Compute X^T X
  const XtX: number[][] = Array.from({ length: p }, () => Array(p).fill(0));
  for (let i = 0; i < n; i++) {
    const rowX = X[i]!;
    for (let r = 0; r < p; r++) {
      const rowXtX = XtX[r]!;
      for (let c = 0; c < p; c++) {
        rowXtX[c] = (rowXtX[c] ?? 0) + rowX[r]! * rowX[c]!;
      }
    }
  }
  const invXtX = invert2x2(XtX);

  // Form intersection cluster ID: `${sessionId}::${mintAddress}`
  const intersectionIds = sessionIds.map((s, idx) => `${s}::${mintAddresses[idx]}`);

  const uniqueSessions = new Set(sessionIds);
  const uniqueMints = new Set(mintAddresses);

  const vSession = computeSingleClusterSandwich(X, residuals, invXtX, sessionIds);
  const vMint = computeSingleClusterSandwich(X, residuals, invXtX, mintAddresses);
  const vIntersection = computeSingleClusterSandwich(X, residuals, invXtX, intersectionIds);

  const vcovMatrix: number[][] = Array.from({ length: p }, () => Array(p).fill(0));
  for (let r = 0; r < p; r++) {
    const rowVcov = vcovMatrix[r]!;
    const rowSession = vSession[r]!;
    const rowMint = vMint[r]!;
    const rowInter = vIntersection[r]!;
    for (let c = 0; c < p; c++) {
      const entry = (rowSession[c] ?? 0) + (rowMint[c] ?? 0) - (rowInter[c] ?? 0);
      if (!Number.isFinite(entry)) {
        throw new Error(
          `[StatisticalOracles] computeTwoWayClusterCovariance: non-finite covariance entry at [${r}][${c}].`,
        );
      }
      rowVcov[c] = entry;
    }
  }

  const standardErrors: number[] = [];
  for (let r = 0; r < p; r++) {
    const variance = vcovMatrix[r]![r]!;
    if (typeof variance !== "number" || !Number.isFinite(variance) || variance <= 0) {
      throw new Error(
        `[StatisticalOracles] computeTwoWayClusterCovariance: diagonal variance at parameter ${r} is non-positive or non-finite (${variance}). Covariance matrix is non-positive semi-definite; standard errors cannot be computed.`,
      );
    }
    standardErrors.push(Math.sqrt(variance));
  }

  const isSmallClusterWarning = uniqueSessions.size < 30;
  const smallClusterNote = isSmallClusterWarning
    ? `Small cluster count (${uniqueSessions.size} sessions < 30) risks downward bias in asymptotic standard errors.`
    : undefined;

  return {
    vcovMatrix,
    standardErrors,
    numClustersSession: uniqueSessions.size,
    numClustersMint: uniqueMints.size,
    isSmallClusterWarning,
    smallClusterNote,
  };
}

export interface AmmRoundTripParams {
  readonly initialBaseReserve: number; // Token units
  readonly initialQuoteReserveSol: number; // SOL units
  readonly buySizeSol: number; // SOL spent on BUY
  readonly lpFeeBps: number; // e.g. 25 bps = 0.0025
  readonly networkFeeSol: number; // per transaction
  readonly ataRentSol: number; // ATA creation rent (refunded on close)
  readonly priceMultiplier?: number | undefined; // 1.0 = flat zero-alpha market
}

export interface AmmRoundTripResult {
  readonly tokensReceivedBuy: number;
  readonly postBuyBaseReserve: number;
  readonly postBuyQuoteReserveSol: number;
  readonly solProceedsSell: number;
  readonly finalBaseReserve: number;
  readonly finalQuoteReserveSol: number;
  readonly totalNetworkFeesSol: number;
  readonly ataRentNetSol: number;
  readonly netCashDeltaSol: number;
  readonly netCashReturnPct: number;
  readonly lpFeeTotalChargedSol: number;
}

/**
 * Bounded floating-point round-trip test oracle for constant-product AMM execution.
 *
 * NOTE: This is an analytical reference oracle for research simulation and offline verification.
 * It is NOT an atomic-exact substitute for the Phase 12.94-C execution state machine,
 * which enforces discrete integer lamport arithmetic, slippage bounds, partial fills,
 * liquidation impairments, and separate SPL token account rent lifecycle.
 *
 * Conservation: (x + dx_net) * (y - dy) = x * y.
 * LP fee is deducted strictly inside swap input pricing.
 * Zero duplicate LP fees from cash.
 */
export function computeAmmRoundTripWaterfall(params: AmmRoundTripParams): AmmRoundTripResult {
  const {
    initialBaseReserve,
    initialQuoteReserveSol,
    buySizeSol,
    lpFeeBps,
    networkFeeSol,
    ataRentSol,
    priceMultiplier = 1.0,
  } = params;

  const isFinitePos = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v > 0;
  const isFiniteNonNeg = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;

  if (!isFinitePos(initialBaseReserve)) {
    throw new Error(
      `[StatisticalOracles] computeAmmRoundTripWaterfall: initialBaseReserve must be a positive finite number, got: ${initialBaseReserve}`,
    );
  }
  if (!isFinitePos(initialQuoteReserveSol)) {
    throw new Error(
      `[StatisticalOracles] computeAmmRoundTripWaterfall: initialQuoteReserveSol must be a positive finite number, got: ${initialQuoteReserveSol}`,
    );
  }
  if (!isFinitePos(buySizeSol)) {
    throw new Error(
      `[StatisticalOracles] computeAmmRoundTripWaterfall: buySizeSol must be a positive finite number, got: ${buySizeSol}`,
    );
  }
  if (!isFiniteNonNeg(lpFeeBps) || lpFeeBps > 10000) {
    throw new Error(
      `[StatisticalOracles] computeAmmRoundTripWaterfall: lpFeeBps must be a finite number between 0 and 10000 (bps), got: ${lpFeeBps}`,
    );
  }
  if (!isFiniteNonNeg(networkFeeSol)) {
    throw new Error(
      `[StatisticalOracles] computeAmmRoundTripWaterfall: networkFeeSol must be a non-negative finite number, got: ${networkFeeSol}`,
    );
  }
  if (!isFiniteNonNeg(ataRentSol)) {
    throw new Error(
      `[StatisticalOracles] computeAmmRoundTripWaterfall: ataRentSol must be a non-negative finite number, got: ${ataRentSol}`,
    );
  }
  if (!isFinitePos(priceMultiplier)) {
    throw new Error(
      `[StatisticalOracles] computeAmmRoundTripWaterfall: priceMultiplier must be a positive finite number, got: ${priceMultiplier}`,
    );
  }

  const feeRate = lpFeeBps / 10000;

  // Leg 1: BUY
  // Gross SOL input = buySizeSol
  const netBuySolInput = buySizeSol * (1 - feeRate);
  const lpFeeBuySol = buySizeSol * feeRate;

  // dy = (y0 * dx_net) / (x0 + dx_net)
  const tokensReceivedBuy =
    (initialBaseReserve * netBuySolInput) / (initialQuoteReserveSol + netBuySolInput);
  if (
    !Number.isFinite(tokensReceivedBuy) ||
    tokensReceivedBuy <= 0 ||
    tokensReceivedBuy >= initialBaseReserve
  ) {
    throw new Error(
      `[StatisticalOracles] computeAmmRoundTripWaterfall: invalid tokensReceivedBuy (${tokensReceivedBuy}) exceeding pool reserves or non-finite.`,
    );
  }

  const postBuyQuoteReserveSol = initialQuoteReserveSol + buySizeSol;
  const postBuyBaseReserve = initialBaseReserve - tokensReceivedBuy;
  if (!Number.isFinite(postBuyBaseReserve) || postBuyBaseReserve <= 0) {
    throw new Error(
      `[StatisticalOracles] computeAmmRoundTripWaterfall: postBuyBaseReserve (${postBuyBaseReserve}) is non-positive or non-finite.`,
    );
  }

  // Intermediate state adjusted by exogenous priceMultiplier if specified
  const sqrtM = Math.sqrt(priceMultiplier);
  const intermediateQuoteReserveSol = postBuyQuoteReserveSol * sqrtM;
  const intermediateBaseReserve = postBuyBaseReserve / sqrtM;

  // Leg 2: SELL (entire token inventory)
  const netTokensToSell = tokensReceivedBuy * (1 - feeRate);
  // dx' = (x_int * dy_net) / (y_int + dy_net)
  const solProceedsSell =
    (intermediateQuoteReserveSol * netTokensToSell) / (intermediateBaseReserve + netTokensToSell);

  if (
    !Number.isFinite(solProceedsSell) ||
    solProceedsSell <= 0 ||
    solProceedsSell >= intermediateQuoteReserveSol
  ) {
    throw new Error(
      `[StatisticalOracles] computeAmmRoundTripWaterfall: invalid solProceedsSell (${solProceedsSell}) exceeding reserves or non-finite.`,
    );
  }

  const finalQuoteReserveSol = intermediateQuoteReserveSol - solProceedsSell;
  const finalBaseReserve = intermediateBaseReserve + tokensReceivedBuy;

  // Total LP fee incurred in SOL equivalent
  const lpFeeSellSol =
    (intermediateQuoteReserveSol * (tokensReceivedBuy * feeRate)) / intermediateBaseReserve;
  const lpFeeTotalChargedSol = lpFeeBuySol + lpFeeSellSol;

  // Net Cash Flow Waterfall:
  // Outlay: -buySizeSol - networkFeeSol - ataRentSol
  // Inflow: +solProceedsSell - networkFeeSol + ataRentSol
  // Net cash delta = solProceedsSell - buySizeSol - 2 * networkFeeSol (ATA rent cancels out upon close)
  const totalNetworkFeesSol = 2 * networkFeeSol;
  const ataRentNetSol = 0; // Deposit refunded upon account closure in closed round trip (net 0)
  const netCashDeltaSol = solProceedsSell - buySizeSol - totalNetworkFeesSol;
  const netCashReturnPct = (netCashDeltaSol / buySizeSol) * 100;

  if (!Number.isFinite(netCashDeltaSol) || !Number.isFinite(netCashReturnPct)) {
    throw new Error(
      `[StatisticalOracles] computeAmmRoundTripWaterfall: non-finite net return calculation.`,
    );
  }

  return {
    tokensReceivedBuy,
    postBuyBaseReserve,
    postBuyQuoteReserveSol,
    solProceedsSell,
    finalBaseReserve,
    finalQuoteReserveSol,
    totalNetworkFeesSol,
    ataRentNetSol,
    netCashDeltaSol,
    netCashReturnPct,
    lpFeeTotalChargedSol,
  };
}
