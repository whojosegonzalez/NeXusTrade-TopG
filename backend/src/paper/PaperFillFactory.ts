import type { CreateFillInput } from "../db/repositories/FillRepository.js";
import { stringifyJson } from "../db/utils/json.js";
import type { PaperExecutionCandidate } from "./PaperExecutionCandidateSelector.js";
import type { PaperExchangeRuntimeConfig } from "./PaperExchangeConfig.js";
import {
  calculateSlippageLamports,
  calculateTokensFilled,
  formatLamportsAsSol,
  isPositiveDecimal,
} from "./PaperMath.js";

export interface PaperQuoteContext {
  readonly quoteSource: string;
  readonly priceSol: string;
  readonly priceUsd: string | null;
  readonly requestedSolLamports: number;
  readonly requestedSol: string;
  readonly tokensFilled: string;
  readonly estimatedBaseFeeLamports: number;
  readonly estimatedPriorityFeeLamports: number;
  readonly estimatedSlippageLamports: number;
  readonly priceImpactBps: number;
  readonly totalCostLamports: number;
}

export function buildPaperQuote(input: {
  readonly candidate: PaperExecutionCandidate;
  readonly config: PaperExchangeRuntimeConfig;
}): PaperQuoteContext | undefined {
  const priceSol = input.candidate.tokenRadar.priceSol;

  if (!isPositiveDecimal(priceSol)) {
    return undefined;
  }

  const tokensFilled = calculateTokensFilled(input.config.buySolLamports, priceSol);

  if (!tokensFilled) {
    return undefined;
  }

  const estimatedSlippageLamports = calculateSlippageLamports(
    input.config.buySolLamports,
    input.config.slippageBps,
  );
  const totalCostLamports =
    input.config.buySolLamports +
    input.config.baseFeeLamports +
    input.config.priorityFeeLamports +
    estimatedSlippageLamports;

  return {
    quoteSource: input.config.quoteSource,
    priceSol,
    priceUsd: input.candidate.tokenRadar.priceUsd,
    requestedSolLamports: input.config.buySolLamports,
    requestedSol: formatLamportsAsSol(input.config.buySolLamports),
    tokensFilled,
    estimatedBaseFeeLamports: input.config.baseFeeLamports,
    estimatedPriorityFeeLamports: input.config.priorityFeeLamports,
    estimatedSlippageLamports,
    priceImpactBps: extractPriceImpactBps(input.candidate),
    totalCostLamports,
  };
}

export function buildFillInput(input: {
  readonly orderId: string;
  readonly sessionId: string;
  readonly filledAtMs: number;
  readonly quote: PaperQuoteContext;
}): CreateFillInput {
  return {
    orderId: input.orderId,
    sessionId: input.sessionId,
    filledAtMs: input.filledAtMs,
    fillPriceSol: input.quote.priceSol,
    ...(input.quote.priceUsd !== null ? { fillPriceUsd: input.quote.priceUsd } : {}),
    tokensFilled: input.quote.tokensFilled,
    solSpentLamports: input.quote.requestedSolLamports,
    estimatedBaseFeeLamports: input.quote.estimatedBaseFeeLamports,
    estimatedPriorityFeeLamports: input.quote.estimatedPriorityFeeLamports,
    estimatedSlippageLamports: input.quote.estimatedSlippageLamports,
    priceImpactBps: input.quote.priceImpactBps,
    quoteSource: input.quote.quoteSource,
    rawQuoteJson: stringifyJson({
      phase: "PHASE_7_PAPER_EXCHANGE",
      kind: "SIMULATED_BUY_FILL",
      quote: input.quote,
    }),
  };
}

function extractPriceImpactBps(candidate: PaperExecutionCandidate): number {
  const rawProviderDataJson = candidate.latestRiskAssessment?.rawProviderDataJson;

  if (!rawProviderDataJson) {
    return 0;
  }

  try {
    const parsed = JSON.parse(rawProviderDataJson) as unknown;
    const impacts = [
      readNumberAtPath(parsed, ["scoring", "facts", "maxPriceImpactPct"]),
      readNumberAtPath(parsed, ["scoring", "facts", "buyPriceImpactPct"]),
      readNumberAtPath(parsed, ["scoring", "facts", "sellPriceImpactPct"]),
      readNumberAtPath(parsed, ["evidence", "buyQuote", "estimatedPriceImpactPct"]),
      readNumberAtPath(parsed, ["evidence", "sellQuote", "estimatedPriceImpactPct"]),
    ].filter((value): value is number => value !== undefined);

    if (impacts.length === 0) {
      return 0;
    }

    return Math.max(0, Math.round(Math.max(...impacts) * 100));
  } catch {
    return 0;
  }
}

function readNumberAtPath(value: unknown, path: readonly string[]): number | undefined {
  let current = value;

  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
