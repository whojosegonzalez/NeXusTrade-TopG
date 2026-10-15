/**
 * Phase 12.94-C: Quote Execution Engine
 *
 * Implements deterministic AMM constant-product liquidity math (Tier 2 Model),
 * full route plan mint and sequence verification, zero-lookahead validation,
 * quote TTL expiration checks, BigInt atomic amount conversions, and
 * simulated fill processing (Tier 4 Model).
 *
 * Explicit Scope Boundary:
 * All quotes generated here represent synthetic Tier 2 constant-product reserve
 * models (providerIdentity: "synthetic_amm_reserve"). Live provider quotes (Tier 3)
 * and execution-time price verification remain decoupled and unimplemented.
 */

import crypto from "node:crypto";
import type {
  ExecutableQuoteRecord,
  RoutePlanStep,
  RouteType,
  SimulatedFillRecord,
  SellabilityStatus,
} from "./ExecutionTypes.js";
import {
  calculateEntryFees,
  calculateExitFees,
  DEFAULT_RAYDIUM_AMM_FEE_RATE,
  LAMPORTS_PER_SOL,
  validateFeeRate,
} from "./ExecutionFeeModel.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const DEFAULT_QUOTE_TTL_MS = 25_000; // 25 seconds (typical Solana block TTL)

function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/^dexscreener-/, "");
}

/**
 * Validates token mint decimals. Fails closed on invalid or out-of-range decimals.
 */
export function validateMintDecimals(decimals: unknown): number {
  if (
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18
  ) {
    throw new Error(
      `[QuoteExecutionEngine] [INVALID_DECIMALS] Mint decimals must be an integer between 0 and 18, received: ${String(decimals)}`,
    );
  }
  return decimals;
}

/**
 * Validates slippage tolerance in basis points (0 to 10,000).
 */
export function validateSlippageBps(slippageBps: number): number {
  if (
    typeof slippageBps !== "number" ||
    !Number.isFinite(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 10_000
  ) {
    throw new Error(
      `[QuoteExecutionEngine] [INVALID_SLIPPAGE] Slippage BPS must be a finite number between 0 and 10,000, received: ${String(slippageBps)}`,
    );
  }
  return slippageBps;
}

/**
 * Validates that an economic parameter is a finite, strictly positive number (> 0 and not NaN).
 */
export function validateStrictlyPositiveFinite(val: unknown, name: string): number {
  if (typeof val !== "number" || !Number.isFinite(val) || Number.isNaN(val) || val <= 0) {
    throw new Error(
      `[QuoteExecutionEngine] [INVALID_PARAM] ${name} must be a strictly positive finite number, received: ${String(val)}`,
    );
  }
  return val;
}

/**
 * Validates that a parameter is a finite, non-negative number (>= 0 and not NaN).
 */
export function validateNonNegativeFinite(val: unknown, name: string): number {
  if (
    typeof val !== "number" ||
    !Number.isFinite(val) ||
    Number.isNaN(val) ||
    val < 0 ||
    Object.is(val, -0)
  ) {
    throw new Error(
      `[QuoteExecutionEngine] [INVALID_PARAM] ${name} must be a non-negative finite number, received: ${String(val)}`,
    );
  }
  return val;
}

/**
 * Canonical nonnegative decimal string regex:
 * Matches "0", "0.xxx", or integer > 0 with optional decimal digits.
 * Rejects negative signs, leading zeros (like 007), scientific notation (1e21, 1e+21), NaN, Infinity.
 */
export const CANONICAL_DECIMAL_REGEX = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Converts a UI amount or numeric string to an exact integer atomic-units string
 * using BigInt arithmetic, strictly rejecting non-canonical, negative, or scientific notation strings.
 */
export function toAtomicUnitsString(amount: number | string, decimals: number): string {
  validateMintDecimals(decimals);
  let str: string;

  if (typeof amount === "string") {
    str = amount.trim();
    if (!CANONICAL_DECIMAL_REGEX.test(str)) {
      throw new Error(
        `[QuoteExecutionEngine] [INVALID_AMOUNT] Invalid non-canonical decimal string: '${amount}'`,
      );
    }
  } else if (typeof amount === "number") {
    if (!Number.isFinite(amount) || Number.isNaN(amount) || amount < 0 || Object.is(amount, -0)) {
      throw new Error(
        `[QuoteExecutionEngine] [INVALID_AMOUNT] Invalid numeric amount: ${String(amount)}`,
      );
    }
    // Convert number to fixed decimal string
    str = amount.toFixed(Math.min(18, Math.max(decimals, 8)));
    if (!CANONICAL_DECIMAL_REGEX.test(str)) {
      throw new Error(
        `[QuoteExecutionEngine] [INVALID_AMOUNT] Numeric amount produced non-canonical decimal string: '${str}'`,
      );
    }
  } else {
    throw new Error(
      `[QuoteExecutionEngine] [INVALID_AMOUNT] Amount must be a number or string, received: ${typeof amount}`,
    );
  }

  const parts = str.split(".");
  const wholePart = parts[0] || "0";
  let fracPart = parts[1] || "";

  if (fracPart.length > decimals) {
    fracPart = fracPart.slice(0, decimals);
  } else {
    fracPart = fracPart.padEnd(decimals, "0");
  }

  const wholeBig = BigInt(wholePart);
  const fracBig = decimals > 0 ? BigInt(fracPart) : 0n;
  const multiplier = 10n ** BigInt(decimals);
  const total = wholeBig * multiplier + fracBig;
  return total.toString();
}

/**
 * Converts atomic integer string to UI numeric value.
 */
export function atomicToUiNumber(rawString: string, decimals: number): number {
  validateMintDecimals(decimals);
  const rawBig = BigInt(rawString);
  const divisor = 10n ** BigInt(decimals);
  const whole = Number(rawBig / divisor);
  const rem = Number(rawBig % divisor);
  return whole + rem / 10 ** decimals;
}

export interface VerifyRoutePlanOptions {
  readonly routePlan: readonly RoutePlanStep[];
  readonly expectedPoolId: string;
  readonly side: "BUY" | "SELL";
  readonly targetMintAddress: string;
}

/**
 * Verifies that a quote's route plan satisfies complete route integrity:
 * 1. Side and Mint Pair:
 *    - BUY: inputMint === WSOL_MINT and outputMint === targetMintAddress
 *    - SELL: inputMint === targetMintAddress and outputMint === WSOL_MINT
 * 2. Multi-hop Sequence: for all hops i, step[i].outputMint === step[i+1].inputMint
 * 3. Tracked Pool Matching: direct routes must match tracked pool; multi-hop must contain tracked pool.
 */
export function verifyRoutePlanPool(options: VerifyRoutePlanOptions): {
  readonly routeType: RouteType;
  readonly valid: boolean;
  readonly primaryAmmKey?: string | undefined;
  readonly reason?: string | undefined;
} {
  const { routePlan, expectedPoolId, side, targetMintAddress } = options;

  if (!expectedPoolId || typeof expectedPoolId !== "string") {
    return {
      routeType: "CROSS_POOL_DIVERGENCE",
      valid: false,
      reason: "Expected pool ID is missing or invalid",
    };
  }
  if (!routePlan || routePlan.length === 0) {
    return {
      routeType: "CROSS_POOL_DIVERGENCE",
      valid: false,
      reason: "Route plan is empty",
    };
  }

  const expectedInputMint = side === "BUY" ? WSOL_MINT : targetMintAddress;
  const expectedOutputMint = side === "BUY" ? targetMintAddress : WSOL_MINT;

  // 1. Verify Entry and Exit Mints
  const firstStep = routePlan[0]!;
  const lastStep = routePlan[routePlan.length - 1]!;

  if (firstStep.inputMint !== expectedInputMint) {
    return {
      routeType: "CROSS_POOL_DIVERGENCE",
      valid: false,
      reason: `Route initial input mint '${firstStep.inputMint}' does not match expected '${expectedInputMint}'`,
    };
  }
  if (lastStep.outputMint !== expectedOutputMint) {
    return {
      routeType: "CROSS_POOL_DIVERGENCE",
      valid: false,
      reason: `Route terminal output mint '${lastStep.outputMint}' does not match expected '${expectedOutputMint}'`,
    };
  }

  // 2. Verify Multi-hop Sequence Continuity
  for (let i = 0; i < routePlan.length - 1; i++) {
    const currentHop = routePlan[i]!;
    const nextHop = routePlan[i + 1]!;
    if (currentHop.outputMint !== nextHop.inputMint) {
      return {
        routeType: "CROSS_POOL_DIVERGENCE",
        valid: false,
        reason: `Disconnected multi-hop sequence at index ${i}: hop output '${currentHop.outputMint}' does not match next input '${nextHop.inputMint}'`,
      };
    }
  }

  // 3. Verify Pool Key
  const normExpected = normalizeKey(expectedPoolId);
  const primaryAmmKey = firstStep.ammKey;
  const normPrimary = normalizeKey(primaryAmmKey);

  if (routePlan.length === 1) {
    if (normPrimary.length > 0 && normPrimary === normExpected) {
      return {
        routeType: "DIRECT_TRACKED_POOL",
        valid: true,
        primaryAmmKey,
      };
    }
    return {
      routeType: "CROSS_POOL_DIVERGENCE",
      valid: false,
      primaryAmmKey,
      reason: `Route plan direct AMM key '${primaryAmmKey}' does not match tracked pool '${expectedPoolId}'`,
    };
  }

  // Multi-hop route: ensure tracked pool is an active step in the route
  const matchesHop = routePlan.some((step) => normalizeKey(step.ammKey) === normExpected);
  if (matchesHop) {
    return {
      routeType: "MULTI_HOP",
      valid: true,
      primaryAmmKey,
    };
  }

  return {
    routeType: "CROSS_POOL_DIVERGENCE",
    valid: false,
    primaryAmmKey,
    reason: `Multi-hop route did not contain tracked pool '${expectedPoolId}'`,
  };
}

/**
 * Validates point-in-time and zero-lookahead invariants for quotes.
 */
export function validateQuoteLookahead(
  quote: ExecutableQuoteRecord,
  decisionTimestampMs: number,
  decisionSlot?: number,
): { readonly valid: boolean; readonly reason?: string | undefined } {
  if (quote.quoteInitiatedMs < decisionTimestampMs) {
    return {
      valid: false,
      reason: `[LOOKAHEAD_VIOLATION] Quote initiated at ${quote.quoteInitiatedMs} is prior to decision at ${decisionTimestampMs}`,
    };
  }
  if (decisionSlot !== undefined && quote.contextSlot < decisionSlot) {
    return {
      valid: false,
      reason: `[STALE_SLOT_VIOLATION] Quote context slot ${quote.contextSlot} is prior to decision slot ${decisionSlot}`,
    };
  }
  return { valid: true };
}

/**
 * Validates quote TTL expiration against a given reference timestamp.
 */
export function validateQuoteExpiration(
  quote: ExecutableQuoteRecord,
  currentTimestampMs: number,
): boolean {
  return currentTimestampMs <= quote.validUntilMs;
}

export interface AmmBuyQuoteParams {
  readonly inputSol: number;
  readonly baseReserveTokens: number;
  readonly quoteReserveSol: number;
  readonly tokenDecimals: number;
  readonly dexFeeRate?: number | undefined;
  readonly maxSlippageBps?: number | undefined;
}

/**
 * Calculates deterministic constant-product (x * y = k) buy quote (SOL -> Token).
 * Applies LP fee inside the curve: input after fee = inputSol * (1 - dexFeeRate).
 */
export function calculateAmmBuyQuote(params: AmmBuyQuoteParams): {
  readonly tokensGross: number;
  readonly tokensMinimum: number;
  readonly priceImpactPct: number;
  readonly effectivePriceSol: number;
} {
  validateMintDecimals(params.tokenDecimals);
  const rFee = validateFeeRate(params.dexFeeRate ?? DEFAULT_RAYDIUM_AMM_FEE_RATE);
  const maxSlippageBps = validateSlippageBps(params.maxSlippageBps ?? 25);

  validateStrictlyPositiveFinite(params.inputSol, "inputSol");
  validateStrictlyPositiveFinite(params.quoteReserveSol, "quoteReserveSol");
  validateStrictlyPositiveFinite(params.baseReserveTokens, "baseReserveTokens");

  const effectiveInputSol = params.inputSol * (1 - rFee);
  const tokensGross =
    params.baseReserveTokens * (effectiveInputSol / (params.quoteReserveSol + effectiveInputSol));

  if (!Number.isFinite(tokensGross) || tokensGross <= 0) {
    throw new Error(
      `[QuoteExecutionEngine] [ZERO_OUTPUT] Constant-product calculation yielded zero or non-finite output tokens: ${tokensGross}`,
    );
  }

  const priceImpactPct = params.inputSol / (params.quoteReserveSol + params.inputSol);
  const tokensMinimum = tokensGross * (1 - maxSlippageBps / 10000);
  const effectivePriceSol = params.inputSol / tokensGross;

  return {
    tokensGross,
    tokensMinimum,
    priceImpactPct,
    effectivePriceSol,
  };
}

export interface AmmSellQuoteParams {
  readonly inputTokens: number;
  readonly baseReserveTokens: number;
  readonly quoteReserveSol: number;
  readonly tokenDecimals: number;
  readonly dexFeeRate?: number | undefined;
  readonly maxSlippageBps?: number | undefined;
}

/**
 * Calculates deterministic constant-product (x * y = k) sell quote (Token -> SOL).
 * Applies LP fee inside the curve: tokens after fee = inputTokens * (1 - dexFeeRate).
 */
export function calculateAmmSellQuote(params: AmmSellQuoteParams): {
  readonly solGross: number;
  readonly solMinimum: number;
  readonly priceImpactPct: number;
  readonly effectivePriceSol: number;
} {
  validateMintDecimals(params.tokenDecimals);
  const rFee = validateFeeRate(params.dexFeeRate ?? DEFAULT_RAYDIUM_AMM_FEE_RATE);
  const maxSlippageBps = validateSlippageBps(params.maxSlippageBps ?? 25);

  validateStrictlyPositiveFinite(params.inputTokens, "inputTokens");
  validateStrictlyPositiveFinite(params.quoteReserveSol, "quoteReserveSol");
  validateStrictlyPositiveFinite(params.baseReserveTokens, "baseReserveTokens");

  const effectiveInputTokens = params.inputTokens * (1 - rFee);
  const solGross =
    params.quoteReserveSol *
    (effectiveInputTokens / (params.baseReserveTokens + effectiveInputTokens));

  if (!Number.isFinite(solGross) || solGross <= 0) {
    throw new Error(
      `[QuoteExecutionEngine] [ZERO_OUTPUT] Constant-product calculation yielded zero or non-finite output SOL: ${solGross}`,
    );
  }

  const priceImpactPct = params.inputTokens / (params.baseReserveTokens + params.inputTokens);
  const solMinimum = solGross * (1 - maxSlippageBps / 10000);
  const effectivePriceSol = solGross / params.inputTokens;

  return {
    solGross,
    solMinimum,
    priceImpactPct,
    effectivePriceSol,
  };
}

export interface CreateDeterministicAmmQuoteParams {
  readonly sessionId: string;
  readonly generationId: string;
  readonly decisionEventId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly side: "BUY" | "SELL";
  readonly tradeSizeSolOrTokens: number;
  readonly baseReserveTokens: number;
  readonly quoteReserveSol: number;
  readonly tokenDecimals: number;
  readonly quoteInitiatedMs: number;
  readonly contextSlot: number;
  readonly quoteLatencyMs?: number | undefined;
  readonly ttlMs?: number | undefined;
  readonly dexFeeRate?: number | undefined;
  readonly maxSlippageBps?: number | undefined;
  readonly simulatedRoutePlan?: readonly RoutePlanStep[] | undefined;
}

/**
 * Creates a fully populated ExecutableQuoteRecord backed by verified Tier 2 AMM reserve math.
 * Explicitly labeled as TIER_2_POOL_RESERVE with providerIdentity: "synthetic_amm_reserve".
 */
export function createDeterministicAmmQuote(
  params: CreateDeterministicAmmQuoteParams,
): ExecutableQuoteRecord {
  validateStrictlyPositiveFinite(params.tradeSizeSolOrTokens, "tradeSizeSolOrTokens");
  validateNonNegativeFinite(params.quoteInitiatedMs, "quoteInitiatedMs");
  validateNonNegativeFinite(params.contextSlot, "contextSlot");
  if (params.quoteLatencyMs !== undefined) {
    validateNonNegativeFinite(params.quoteLatencyMs, "quoteLatencyMs");
  }
  if (params.ttlMs !== undefined) {
    validateStrictlyPositiveFinite(params.ttlMs, "ttlMs");
  }

  const quoteId = `quote-${crypto.randomUUID()}`;
  const latency = params.quoteLatencyMs ?? 25;
  const quoteReceivedMs = params.quoteInitiatedMs + latency;
  const validUntilMs = quoteReceivedMs + (params.ttlMs ?? DEFAULT_QUOTE_TTL_MS);
  const decimals = validateMintDecimals(params.tokenDecimals);
  const maxSlippageBps = validateSlippageBps(params.maxSlippageBps ?? 25);
  const dexFeeRate = validateFeeRate(params.dexFeeRate ?? DEFAULT_RAYDIUM_AMM_FEE_RATE);

  const defaultRoutePlan: readonly RoutePlanStep[] = params.simulatedRoutePlan ?? [
    {
      ammKey: params.poolId,
      label: "Synthetic AMM Pool",
      inputMint: params.side === "BUY" ? WSOL_MINT : params.mintAddress,
      outputMint: params.side === "BUY" ? params.mintAddress : WSOL_MINT,
      feePct: dexFeeRate,
    },
  ];

  const routeVerification = verifyRoutePlanPool({
    routePlan: defaultRoutePlan,
    expectedPoolId: params.poolId,
    side: params.side,
    targetMintAddress: params.mintAddress,
  });

  if (!routeVerification.valid) {
    throw new Error(
      `[QuoteExecutionEngine] [ROUTE_VERIFICATION_FAILED] ${routeVerification.reason}`,
    );
  }

  if (routeVerification.routeType === "MULTI_HOP") {
    throw new Error(
      `[QuoteExecutionEngine] [UNSUPPORTED_MULTIHOP_ROUTE] Multi-hop routes (${defaultRoutePlan.length} hops) cannot be accurately priced with single-pool synthetic AMM reserve math. Route pricing rejected.`,
    );
  }

  if (params.side === "BUY") {
    const buyResult = calculateAmmBuyQuote({
      inputSol: params.tradeSizeSolOrTokens,
      baseReserveTokens: params.baseReserveTokens,
      quoteReserveSol: params.quoteReserveSol,
      tokenDecimals: decimals,
      dexFeeRate,
      maxSlippageBps,
    });

    const inAmountRaw = toAtomicUnitsString(params.tradeSizeSolOrTokens, 9);
    const expectedOutAmountRaw = toAtomicUnitsString(buyResult.tokensGross, decimals);
    const minimumOutAmountRaw = toAtomicUnitsString(buyResult.tokensMinimum, decimals);

    const poolInternalFeeSol = params.tradeSizeSolOrTokens * dexFeeRate;
    const poolInternalFeeLamports = Math.round(poolInternalFeeSol * LAMPORTS_PER_SOL);

    return {
      quoteId,
      sessionId: params.sessionId,
      generationId: params.generationId,
      decisionEventId: params.decisionEventId,
      mintAddress: params.mintAddress,
      poolId: params.poolId,
      priceTier: "TIER_2_POOL_RESERVE",
      providerIdentity: "synthetic_amm_reserve",
      side: "BUY",
      inputMint: WSOL_MINT,
      outputMint: params.mintAddress,
      inAmountRaw,
      inAmountUi: params.tradeSizeSolOrTokens,
      expectedOutAmountRaw,
      expectedOutAmountUi: buyResult.tokensGross,
      minimumOutAmountRaw,
      minimumOutAmountUi: buyResult.tokensMinimum,
      priceImpactPct: buyResult.priceImpactPct,
      maxSlippageBps,
      poolInternalFeeLamports,
      poolInternalFeeSol,
      routeType: routeVerification.routeType,
      routePlan: defaultRoutePlan,
      quoteInitiatedMs: params.quoteInitiatedMs,
      quoteReceivedMs,
      contextSlot: params.contextSlot,
      validUntilMs,
    };
  } else {
    const sellResult = calculateAmmSellQuote({
      inputTokens: params.tradeSizeSolOrTokens,
      baseReserveTokens: params.baseReserveTokens,
      quoteReserveSol: params.quoteReserveSol,
      tokenDecimals: decimals,
      dexFeeRate,
      maxSlippageBps,
    });

    const inAmountRaw = toAtomicUnitsString(params.tradeSizeSolOrTokens, decimals);
    const expectedOutAmountRaw = toAtomicUnitsString(sellResult.solGross, 9);
    const minimumOutAmountRaw = toAtomicUnitsString(sellResult.solMinimum, 9);

    const poolInternalFeeSol = sellResult.solGross * dexFeeRate;
    const poolInternalFeeLamports = Math.round(poolInternalFeeSol * LAMPORTS_PER_SOL);

    return {
      quoteId,
      sessionId: params.sessionId,
      generationId: params.generationId,
      decisionEventId: params.decisionEventId,
      mintAddress: params.mintAddress,
      poolId: params.poolId,
      priceTier: "TIER_2_POOL_RESERVE",
      providerIdentity: "synthetic_amm_reserve",
      side: "SELL",
      inputMint: params.mintAddress,
      outputMint: WSOL_MINT,
      inAmountRaw,
      inAmountUi: params.tradeSizeSolOrTokens,
      expectedOutAmountRaw,
      expectedOutAmountUi: sellResult.solGross,
      minimumOutAmountRaw,
      minimumOutAmountUi: sellResult.solMinimum,
      priceImpactPct: sellResult.priceImpactPct,
      maxSlippageBps,
      poolInternalFeeLamports,
      poolInternalFeeSol,
      routeType: routeVerification.routeType,
      routePlan: defaultRoutePlan,
      quoteInitiatedMs: params.quoteInitiatedMs,
      quoteReceivedMs,
      contextSlot: params.contextSlot,
      validUntilMs,
    };
  }
}

export interface SimulateFillOptions {
  readonly decisionTimestampMs: number;
  readonly decisionSlot: number;
  readonly executionDelayMs?: number | undefined;
  readonly priorityFeeMicroLamports?: number | undefined;
  readonly computeUnits?: number | undefined;
  readonly isNewAta?: boolean | undefined;
  readonly closeAta?: boolean | undefined;
  /**
   * Indicates whether an ATA was actually opened and funded for this token.
   * Required for rent refund rebate eligibility.
   */
  readonly hasFundedAta?: boolean | undefined;
  readonly sellabilityStatus?: SellabilityStatus | undefined;
  /**
   * Simulated price degradation in bps experienced during execution delay.
   * Default: 0 bps (neutral fill at quoted price).
   */
  readonly arrivalSlippageBps?: number | undefined;
  /**
   * Prior entry cost in SOL, used to calculate realized P&L on sell liquidation.
   */
  readonly priorEntryCostSol?: number | undefined;
}

/**
 * Simulates fill execution based on an executable quote record.
 * Labeled as TIER_4_SIMULATED_FILL.
 * Strictly verifies zero lookahead, expiration, and cross-pool divergence.
 * Accurately models failed execution vs failed quote:
 * - NO_ROUTE / PREFLIGHT_SIMULATION: network fee = 0, unsold inventory preserved.
 * - SUBMITTED_FAILED: on-chain network fee charged, unsold inventory preserved.
 */
export function simulateFill(
  quote: ExecutableQuoteRecord,
  options: SimulateFillOptions,
): SimulatedFillRecord {
  // 1. Zero-Lookahead and Stale Slot Check
  const lookaheadCheck = validateQuoteLookahead(
    quote,
    options.decisionTimestampMs,
    options.decisionSlot,
  );
  if (!lookaheadCheck.valid) {
    throw new Error(`[QuoteExecutionEngine] ${lookaheadCheck.reason}`);
  }

  // 2. Cross-Pool Divergence Check (Fail Closed)
  if (quote.routeType === "CROSS_POOL_DIVERGENCE") {
    throw new Error(
      `[QuoteExecutionEngine] [CROSS_POOL_CONTAMINATION] Cannot fill quote with cross-pool divergence on pool '${quote.poolId}'.`,
    );
  }

  // Reject unsupported multi-hop route fills
  if (quote.routeType === "MULTI_HOP") {
    throw new Error(
      `[QuoteExecutionEngine] [UNSUPPORTED_MULTIHOP_ROUTE] Cannot fill quote with multi-hop route on single-pool synthetic model.`,
    );
  }

  // 3. Execution Latency & Expiration
  const executionDelayMs = options.executionDelayMs ?? 150;
  const fillTimestampMs = quote.quoteReceivedMs + executionDelayMs;
  if (!validateQuoteExpiration(quote, fillTimestampMs)) {
    throw new Error(
      `[QuoteExecutionEngine] [QUOTE_EXPIRED] Quote expired at ${quote.validUntilMs}, fill attempted at ${fillTimestampMs}.`,
    );
  }

  // Validate finite non-negative arrival slippage
  if (options.arrivalSlippageBps !== undefined) {
    if (
      typeof options.arrivalSlippageBps !== "number" ||
      !Number.isFinite(options.arrivalSlippageBps) ||
      Number.isNaN(options.arrivalSlippageBps) ||
      options.arrivalSlippageBps < 0 ||
      options.arrivalSlippageBps > 10000
    ) {
      throw new Error(
        `[QuoteExecutionEngine] [INVALID_SLIPPAGE] arrivalSlippageBps must be a finite number between 0 and 10000, received: ${String(options.arrivalSlippageBps)}`,
      );
    }
  }

  const fillSlot = quote.contextSlot + Math.max(1, Math.floor(executionDelayMs / 400));
  const fillId = `fill-${crypto.randomUUID()}`;
  const status: SellabilityStatus = options.sellabilityStatus ?? "FULLY_SELLABLE";
  const arrivalSlippageBps = options.arrivalSlippageBps ?? 0;

  if (quote.side === "BUY") {
    const feeBreakdown = calculateEntryFees({
      sizeLamports: Number(quote.inAmountRaw),
      dexFeeRate: quote.poolInternalFeeLamports / Number(quote.inAmountRaw),
      isNewAta: options.isNewAta,
      computeUnits: options.computeUnits,
      microLamportsPerCu: options.priorityFeeMicroLamports,
    });

    // Check slippage breach
    if (arrivalSlippageBps > quote.maxSlippageBps) {
      return {
        fillId,
        quoteId: quote.quoteId,
        decisionEventId: quote.decisionEventId,
        mintAddress: quote.mintAddress,
        poolId: quote.poolId,
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: quote.providerIdentity,
        side: "BUY",
        executionOutcome: "SLIPPAGE_BREACH_REJECTED",
        attemptedSizeSol: quote.inAmountUi,
        filledSizeSol: 0,
        attemptedTokens: quote.expectedOutAmountUi,
        filledTokens: 0,
        remainingTokens: 0,
        effectivePriceSol: 0,
        priceImpactBps: Math.round(quote.priceImpactPct * 10000),
        maxSlippageBps: quote.maxSlippageBps,
        realizedSlippageBps: arrivalSlippageBps,
        networkFeeLamports: 0, // Preflight slippage abort does not submit on-chain
        priorityFeeLamports: 0,
        sellabilityStatus: "UNSELLABLE_SLIPPAGE_EXCEEDED",
        fillTimestampMs,
        fillSlot,
        executionDelayMs,
      };
    }

    const filledTokens = quote.expectedOutAmountUi * (1 - arrivalSlippageBps / 10000);
    const effectivePriceSol = quote.inAmountUi / filledTokens;

    return {
      fillId,
      quoteId: quote.quoteId,
      decisionEventId: quote.decisionEventId,
      mintAddress: quote.mintAddress,
      poolId: quote.poolId,
      priceTier: "TIER_4_SIMULATED_FILL",
      providerIdentity: quote.providerIdentity,
      side: "BUY",
      executionOutcome: "FILLED",
      attemptedSizeSol: quote.inAmountUi,
      filledSizeSol: quote.inAmountUi,
      attemptedTokens: quote.expectedOutAmountUi,
      filledTokens,
      remainingTokens: filledTokens, // Acquired tokens now in inventory
      effectivePriceSol,
      priceImpactBps: Math.round(quote.priceImpactPct * 10000),
      maxSlippageBps: quote.maxSlippageBps,
      realizedSlippageBps: arrivalSlippageBps,
      networkFeeLamports: feeBreakdown.externalNetworkFeeLamports,
      priorityFeeLamports: feeBreakdown.priorityFeeLamports,
      ataRentDepositLamports: feeBreakdown.ataRentDepositLamports,
      ataRentRefundLamports: feeBreakdown.ataRentRefundLamports,
      sellabilityStatus: "FULLY_SELLABLE",
      fillTimestampMs,
      fillSlot,
      executionDelayMs,
    };
  } else {
    // SELL Leg
    const attemptedTokens = quote.inAmountUi;
    const feeBreakdown = calculateExitFees({
      grossSolProceedsLamports: Number(quote.expectedOutAmountRaw),
      dexFeeRate: quote.poolInternalFeeLamports / Number(quote.expectedOutAmountRaw),
      closeAta: options.closeAta,
      hasFundedAta: options.hasFundedAta,
      computeUnits: options.computeUnits,
      microLamportsPerCu: options.priorityFeeMicroLamports,
    });

    // 1. Failed Execution: No Route Available
    if (status === "UNSELLABLE_NO_ROUTE") {
      return {
        fillId,
        quoteId: quote.quoteId,
        decisionEventId: quote.decisionEventId,
        mintAddress: quote.mintAddress,
        poolId: quote.poolId,
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: quote.providerIdentity,
        side: "SELL",
        executionOutcome: "NO_ROUTE_REJECTED",
        attemptedSizeSol: quote.expectedOutAmountUi,
        filledSizeSol: 0,
        attemptedTokens,
        filledTokens: 0,
        remainingTokens: attemptedTokens, // Inventory preserved!
        effectivePriceSol: 0,
        grossProceedsSol: 0,
        netProceedsSol: 0,
        priceImpactBps: Math.round(quote.priceImpactPct * 10000),
        maxSlippageBps: quote.maxSlippageBps,
        realizedSlippageBps: 0,
        networkFeeLamports: 0, // No transaction submitted
        priorityFeeLamports: 0,
        sellabilityStatus: status,
        conservativeWriteDownSol: options.priorEntryCostSol ?? quote.expectedOutAmountUi,
        fillTimestampMs,
        fillSlot,
        executionDelayMs,
      };
    }

    // 2. Failed Execution: Preflight Simulation Failed (Honeypot / Freeze Authority)
    if (status === "UNSELLABLE_TRANSFER_RESTRICTION") {
      return {
        fillId,
        quoteId: quote.quoteId,
        decisionEventId: quote.decisionEventId,
        mintAddress: quote.mintAddress,
        poolId: quote.poolId,
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: quote.providerIdentity,
        side: "SELL",
        executionOutcome: "PREFLIGHT_SIMULATION_REJECTED",
        attemptedSizeSol: quote.expectedOutAmountUi,
        filledSizeSol: 0,
        attemptedTokens,
        filledTokens: 0,
        remainingTokens: attemptedTokens, // Inventory preserved!
        effectivePriceSol: 0,
        grossProceedsSol: 0,
        netProceedsSol: 0,
        priceImpactBps: Math.round(quote.priceImpactPct * 10000),
        maxSlippageBps: quote.maxSlippageBps,
        realizedSlippageBps: 0,
        networkFeeLamports: 0, // Preflight rejects before submission
        priorityFeeLamports: 0,
        sellabilityStatus: status,
        conservativeWriteDownSol: options.priorEntryCostSol ?? quote.expectedOutAmountUi,
        fillTimestampMs,
        fillSlot,
        executionDelayMs,
      };
    }

    // 3. Failed Execution: Submitted Transaction Failed On-Chain (Pool Liquidity Collapse)
    if (status === "UNSELLABLE_LIQUIDITY_DRAINED") {
      return {
        fillId,
        quoteId: quote.quoteId,
        decisionEventId: quote.decisionEventId,
        mintAddress: quote.mintAddress,
        poolId: quote.poolId,
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: quote.providerIdentity,
        side: "SELL",
        executionOutcome: "SUBMITTED_TRANSACTION_FAILED",
        attemptedSizeSol: quote.expectedOutAmountUi,
        filledSizeSol: 0,
        attemptedTokens,
        filledTokens: 0,
        remainingTokens: attemptedTokens, // Inventory preserved!
        effectivePriceSol: 0,
        grossProceedsSol: 0,
        netProceedsSol: 0,
        priceImpactBps: Math.round(quote.priceImpactPct * 10000),
        maxSlippageBps: quote.maxSlippageBps,
        realizedSlippageBps: 0,
        networkFeeLamports: feeBreakdown.externalNetworkFeeLamports, // On-chain failure burns network fee
        priorityFeeLamports: feeBreakdown.priorityFeeLamports,
        sellabilityStatus: status,
        conservativeWriteDownSol: options.priorEntryCostSol ?? quote.expectedOutAmountUi,
        fillTimestampMs,
        fillSlot,
        executionDelayMs,
      };
    }

    // 4. Failed Execution: Slippage Breach
    if (arrivalSlippageBps > quote.maxSlippageBps || status === "UNSELLABLE_SLIPPAGE_EXCEEDED") {
      return {
        fillId,
        quoteId: quote.quoteId,
        decisionEventId: quote.decisionEventId,
        mintAddress: quote.mintAddress,
        poolId: quote.poolId,
        priceTier: "TIER_4_SIMULATED_FILL",
        providerIdentity: quote.providerIdentity,
        side: "SELL",
        executionOutcome: "SLIPPAGE_BREACH_REJECTED",
        attemptedSizeSol: quote.expectedOutAmountUi,
        filledSizeSol: 0,
        attemptedTokens,
        filledTokens: 0,
        remainingTokens: attemptedTokens, // Inventory preserved!
        effectivePriceSol: 0,
        grossProceedsSol: 0,
        netProceedsSol: 0,
        priceImpactBps: Math.round(quote.priceImpactPct * 10000),
        maxSlippageBps: quote.maxSlippageBps,
        realizedSlippageBps: arrivalSlippageBps,
        networkFeeLamports: 0,
        priorityFeeLamports: 0,
        sellabilityStatus: "UNSELLABLE_SLIPPAGE_EXCEEDED",
        fillTimestampMs,
        fillSlot,
        executionDelayMs,
      };
    }

    // 5. Successful Liquidation (FILLED)
    const grossProceedsSol = quote.expectedOutAmountUi * (1 - arrivalSlippageBps / 10000);
    const netProceedsSol = Math.max(0, grossProceedsSol - feeBreakdown.totalOutOfPocketFeeSol);
    const effectivePriceSol = attemptedTokens > 0 ? grossProceedsSol / attemptedTokens : 0;
    const realizedPnlSol =
      options.priorEntryCostSol !== undefined
        ? netProceedsSol - options.priorEntryCostSol
        : undefined;

    return {
      fillId,
      quoteId: quote.quoteId,
      decisionEventId: quote.decisionEventId,
      mintAddress: quote.mintAddress,
      poolId: quote.poolId,
      priceTier: "TIER_4_SIMULATED_FILL",
      providerIdentity: quote.providerIdentity,
      side: "SELL",
      executionOutcome: "FILLED",
      attemptedSizeSol: quote.expectedOutAmountUi,
      filledSizeSol: netProceedsSol,
      attemptedTokens,
      filledTokens: attemptedTokens,
      remainingTokens: 0, // Fully liquidated!
      effectivePriceSol,
      grossProceedsSol,
      netProceedsSol,
      priceImpactBps: Math.round(quote.priceImpactPct * 10000),
      maxSlippageBps: quote.maxSlippageBps,
      realizedSlippageBps: arrivalSlippageBps,
      networkFeeLamports: feeBreakdown.externalNetworkFeeLamports,
      priorityFeeLamports: feeBreakdown.priorityFeeLamports,
      ataRentDepositLamports: feeBreakdown.ataRentDepositLamports,
      ataRentRefundLamports: feeBreakdown.ataRentRefundLamports,
      sellabilityStatus: status,
      realizedPnlSol,
      fillTimestampMs,
      fillSlot,
      executionDelayMs,
    };
  }
}
