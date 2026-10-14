/**
 * Phase 12.94-C: Quote Execution Engine
 *
 * Implements realistic execution quote generation, local AMM constant-product
 * liquidity math, route plan and pool ID verification, zero-lookahead validation,
 * quote TTL expiration checks, and deterministic simulated fill processing.
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
} from "./ExecutionFeeModel.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const DEFAULT_QUOTE_TTL_MS = 25_000; // 25 seconds (typical Solana block TTL)

function normalizePoolId(poolId: string): string {
  return poolId
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
 * Verifies that a quote's route plan routes through the candidate's tracked pool.
 * Rejects cross-pool substitutions where liquidity from an untracked pool is used.
 */
export function verifyRoutePlanPool(
  routePlan: readonly RoutePlanStep[],
  expectedPoolId: string,
): {
  readonly routeType: RouteType;
  readonly valid: boolean;
  readonly primaryAmmKey?: string | undefined;
  readonly reason?: string | undefined;
} {
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

  const normExpected = normalizePoolId(expectedPoolId);
  const primaryStep = routePlan[0];
  const primaryAmmKey = primaryStep?.ammKey ?? "";
  const normPrimary = normalizePoolId(primaryAmmKey);

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

  // Multi-hop route: ensure at least one hop matches the tracked pool
  const matchesHop = routePlan.some((step) => normalizePoolId(step.ammKey) === normExpected);
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
  readonly slippageBps?: number | undefined;
}

/**
 * Calculates deterministic constant-product (x * y = k) buy quote (SOL -> Token).
 */
export function calculateAmmBuyQuote(params: AmmBuyQuoteParams): {
  readonly tokensGross: number;
  readonly tokensNet: number;
  readonly priceImpactPct: number;
  readonly effectivePriceSol: number;
} {
  validateMintDecimals(params.tokenDecimals);
  const rFee = params.dexFeeRate ?? DEFAULT_RAYDIUM_AMM_FEE_RATE;
  const slippageBps = params.slippageBps ?? 25; // 25 bps default

  if (params.inputSol <= 0 || params.quoteReserveSol <= 0 || params.baseReserveTokens <= 0) {
    throw new Error("[QuoteExecutionEngine] Reserves and trade size must be strictly positive.");
  }

  const effectiveInputSol = params.inputSol * (1 - rFee);
  const tokensGross =
    params.baseReserveTokens * (effectiveInputSol / (params.quoteReserveSol + effectiveInputSol));

  const priceImpactPct = params.inputSol / (params.quoteReserveSol + params.inputSol);
  const tokensNet = tokensGross * (1 - slippageBps / 10000);
  const effectivePriceSol = params.inputSol / tokensGross;

  return {
    tokensGross,
    tokensNet,
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
  readonly slippageBps?: number | undefined;
}

/**
 * Calculates deterministic constant-product (x * y = k) sell quote (Token -> SOL).
 */
export function calculateAmmSellQuote(params: AmmSellQuoteParams): {
  readonly solGross: number;
  readonly solNet: number;
  readonly priceImpactPct: number;
  readonly effectivePriceSol: number;
} {
  validateMintDecimals(params.tokenDecimals);
  const rFee = params.dexFeeRate ?? DEFAULT_RAYDIUM_AMM_FEE_RATE;
  const slippageBps = params.slippageBps ?? 25;

  if (params.inputTokens <= 0 || params.quoteReserveSol <= 0 || params.baseReserveTokens <= 0) {
    throw new Error("[QuoteExecutionEngine] Reserves and input tokens must be strictly positive.");
  }

  const effectiveInputTokens = params.inputTokens * (1 - rFee);
  const solGross =
    params.quoteReserveSol *
    (effectiveInputTokens / (params.baseReserveTokens + effectiveInputTokens));

  const priceImpactPct = params.inputTokens / (params.baseReserveTokens + params.inputTokens);
  const solNet = solGross * (1 - slippageBps / 10000);
  const effectivePriceSol = solGross / params.inputTokens;

  return {
    solGross,
    solNet,
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
  readonly slippageBps?: number | undefined;
  readonly simulatedRoutePlan?: readonly RoutePlanStep[] | undefined;
}

/**
 * Creates a fully populated ExecutableQuoteRecord backed by verified AMM reserve math.
 */
export function createDeterministicAmmQuote(
  params: CreateDeterministicAmmQuoteParams,
): ExecutableQuoteRecord {
  const quoteId = `quote-${crypto.randomUUID()}`;
  const latency = params.quoteLatencyMs ?? 25; // 25ms simulated response latency
  const quoteReceivedMs = params.quoteInitiatedMs + latency;
  const validUntilMs = quoteReceivedMs + (params.ttlMs ?? DEFAULT_QUOTE_TTL_MS);
  const decimals = validateMintDecimals(params.tokenDecimals);
  const slippageBps = params.slippageBps ?? 25;

  const defaultRoutePlan: readonly RoutePlanStep[] = params.simulatedRoutePlan ?? [
    {
      ammKey: params.poolId,
      label: "Raydium V4",
      inputMint: params.side === "BUY" ? WSOL_MINT : params.mintAddress,
      outputMint: params.side === "BUY" ? params.mintAddress : WSOL_MINT,
      feePct: params.dexFeeRate ?? DEFAULT_RAYDIUM_AMM_FEE_RATE,
    },
  ];

  const routeVerification = verifyRoutePlanPool(defaultRoutePlan, params.poolId);

  if (params.side === "BUY") {
    const buyResult = calculateAmmBuyQuote({
      inputSol: params.tradeSizeSolOrTokens,
      baseReserveTokens: params.baseReserveTokens,
      quoteReserveSol: params.quoteReserveSol,
      tokenDecimals: decimals,
      dexFeeRate: params.dexFeeRate,
      slippageBps,
    });

    const inAmountRaw = Math.round(params.tradeSizeSolOrTokens * LAMPORTS_PER_SOL).toString();
    const outAmountRaw = Math.round(buyResult.tokensGross * 10 ** decimals).toString();
    const minimumOutAmountRaw = Math.round(buyResult.tokensNet * 10 ** decimals).toString();

    return {
      quoteId,
      sessionId: params.sessionId,
      generationId: params.generationId,
      decisionEventId: params.decisionEventId,
      mintAddress: params.mintAddress,
      poolId: params.poolId,
      side: "BUY",
      inputMint: WSOL_MINT,
      outputMint: params.mintAddress,
      inAmountRaw,
      inAmountUi: params.tradeSizeSolOrTokens,
      outAmountRaw,
      outAmountUi: buyResult.tokensGross,
      minimumOutAmountRaw,
      priceImpactPct: buyResult.priceImpactPct,
      slippageBps,
      feeLamports: Math.round(
        params.tradeSizeSolOrTokens *
          LAMPORTS_PER_SOL *
          (params.dexFeeRate ?? DEFAULT_RAYDIUM_AMM_FEE_RATE),
      ),
      providerIdentity: "raydium_amm",
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
      dexFeeRate: params.dexFeeRate,
      slippageBps,
    });

    const inAmountRaw = Math.round(params.tradeSizeSolOrTokens * 10 ** decimals).toString();
    const outAmountRaw = Math.round(sellResult.solGross * LAMPORTS_PER_SOL).toString();
    const minimumOutAmountRaw = Math.round(sellResult.solNet * LAMPORTS_PER_SOL).toString();

    return {
      quoteId,
      sessionId: params.sessionId,
      generationId: params.generationId,
      decisionEventId: params.decisionEventId,
      mintAddress: params.mintAddress,
      poolId: params.poolId,
      side: "SELL",
      inputMint: params.mintAddress,
      outputMint: WSOL_MINT,
      inAmountRaw,
      inAmountUi: params.tradeSizeSolOrTokens,
      outAmountRaw,
      outAmountUi: sellResult.solGross,
      minimumOutAmountRaw,
      priceImpactPct: sellResult.priceImpactPct,
      slippageBps,
      feeLamports: Math.round(
        sellResult.solGross *
          LAMPORTS_PER_SOL *
          (params.dexFeeRate ?? DEFAULT_RAYDIUM_AMM_FEE_RATE),
      ),
      providerIdentity: "raydium_amm",
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
  readonly sellabilityStatus?: SellabilityStatus | undefined;
}

/**
 * Simulates fill execution based on an executable quote record.
 * Strictly verifies zero lookahead, expiration, and cross-pool divergence.
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

  // 3. Execution Latency & Expiration
  const executionDelayMs = options.executionDelayMs ?? 150; // 150ms simulated fill latency
  const fillTimestampMs = quote.quoteReceivedMs + executionDelayMs;
  if (!validateQuoteExpiration(quote, fillTimestampMs)) {
    throw new Error(
      `[QuoteExecutionEngine] [QUOTE_EXPIRED] Quote expired at ${quote.validUntilMs}, fill attempted at ${fillTimestampMs}.`,
    );
  }

  const fillSlot = quote.contextSlot + Math.max(1, Math.floor(executionDelayMs / 400));
  const fillId = `fill-${crypto.randomUUID()}`;
  const status: SellabilityStatus = options.sellabilityStatus ?? "FULLY_SELLABLE";

  if (quote.side === "BUY") {
    const attemptedSizeSol = quote.inAmountUi;
    const feeBreakdown = calculateEntryFees({
      sizeLamports: Number(quote.inAmountRaw),
      dexFeeRate: quote.feeLamports / Number(quote.inAmountRaw),
      isNewAta: options.isNewAta,
      computeUnits: options.computeUnits,
      microLamportsPerCu: options.priorityFeeMicroLamports,
    });

    const filledTokens = quote.outAmountUi;
    const effectivePriceSol = attemptedSizeSol / filledTokens;

    return {
      fillId,
      quoteId: quote.quoteId,
      decisionEventId: quote.decisionEventId,
      mintAddress: quote.mintAddress,
      poolId: quote.poolId,
      side: "BUY",
      attemptedSizeSol,
      filledSizeSol: attemptedSizeSol,
      filledTokens,
      effectivePriceSol,
      priceImpactBps: Math.round(quote.priceImpactPct * 10000),
      realizedSlippageBps: quote.slippageBps,
      networkFeeLamports: feeBreakdown.baseFeeLamports,
      priorityFeeLamports: feeBreakdown.priorityFeeLamports,
      sellabilityStatus: "FULLY_SELLABLE",
      fillTimestampMs,
      fillSlot,
      executionDelayMs,
    };
  } else {
    // SELL
    const attemptedTokens = quote.inAmountUi;
    const grossProceedsSol = quote.outAmountUi;

    const feeBreakdown = calculateExitFees({
      grossSolProceedsLamports: Number(quote.outAmountRaw),
      dexFeeRate: quote.feeLamports / Number(quote.outAmountRaw),
      closeAta: options.closeAta,
      computeUnits: options.computeUnits,
      microLamportsPerCu: options.priorityFeeMicroLamports,
    });

    // If sellability is catastrophic (no route, drained, honeypot), net proceeds drop to 0
    const isCatastrophic =
      status === "UNSELLABLE_NO_ROUTE" ||
      status === "UNSELLABLE_TRANSFER_RESTRICTION" ||
      status === "UNSELLABLE_LIQUIDITY_DRAINED" ||
      status === "UNSELLABLE_EXCESSIVE_IMPACT";

    const actualGrossSol = isCatastrophic ? 0 : grossProceedsSol;
    const netProceedsSol = isCatastrophic
      ? 0
      : Math.max(0, grossProceedsSol - feeBreakdown.totalFeeSol);
    const effectivePriceSol = attemptedTokens > 0 ? actualGrossSol / attemptedTokens : 0;

    return {
      fillId,
      quoteId: quote.quoteId,
      decisionEventId: quote.decisionEventId,
      mintAddress: quote.mintAddress,
      poolId: quote.poolId,
      side: "SELL",
      attemptedSizeSol: grossProceedsSol,
      filledSizeSol: netProceedsSol,
      filledTokens: attemptedTokens,
      effectivePriceSol,
      grossProceedsSol: actualGrossSol,
      netProceedsSol,
      priceImpactBps: Math.round(quote.priceImpactPct * 10000),
      realizedSlippageBps: quote.slippageBps,
      networkFeeLamports: feeBreakdown.baseFeeLamports,
      priorityFeeLamports: feeBreakdown.priorityFeeLamports,
      sellabilityStatus: status,
      fillTimestampMs,
      fillSlot,
      executionDelayMs,
    };
  }
}
