import type { CreateFillInput } from "../db/repositories/FillRepository.js";
import { stringifyJson } from "../db/utils/json.js";
import type { PaperSellCandidate } from "./PaperSellCandidateSelector.js";
import type { PaperSellRuntimeConfig } from "./PaperSellConfig.js";
import type { PaperSellAccountingResult } from "./PaperSellAccountingService.js";
import type { PaperSellQuoteContext } from "./PaperSellQuoteService.js";

export function buildSellFillInput(input: {
  readonly orderId: string;
  readonly candidate: PaperSellCandidate;
  readonly quote: PaperSellQuoteContext;
  readonly accounting: PaperSellAccountingResult;
  readonly config: PaperSellRuntimeConfig;
  readonly filledAtMs: number;
}): CreateFillInput {
  return {
    orderId: input.orderId,
    sessionId: input.candidate.session.id,
    filledAtMs: input.filledAtMs,
    fillPriceSol: input.quote.priceSol,
    ...(input.quote.priceUsd ? { fillPriceUsd: input.quote.priceUsd } : {}),
    tokensFilled: input.candidate.position.tokensHeld,
    solReceivedLamports: input.accounting.netSellProceedsLamports,
    estimatedBaseFeeLamports: input.config.baseFeeLamports,
    estimatedPriorityFeeLamports: input.config.priorityFeeLamports,
    estimatedSlippageLamports: input.accounting.sellSlippageLamports,
    ...(input.quote.priceImpactBps !== undefined
      ? { priceImpactBps: input.quote.priceImpactBps }
      : {}),
    quoteSource: input.quote.quoteSource,
    rawQuoteJson: stringifyJson({
      phase: "PHASE_7_5_PAPER_SELL",
      kind: "SIMULATED_SELL_FILL",
      ...(input.config.exitContext ? { exitContext: input.config.exitContext } : {}),
      side: "SELL",
      positionId: input.candidate.position.id,
      mintAddress: input.candidate.position.mintAddress,
      quote: input.quote,
      accounting: input.accounting,
      filledAtMs: input.filledAtMs,
    }),
  };
}
