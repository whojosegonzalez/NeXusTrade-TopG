import type { CreateOrderInput } from "../db/repositories/OrderRepository.js";
import { stringifyJson } from "../db/utils/json.js";
import type { PaperSellCandidate } from "./PaperSellCandidateSelector.js";
import type { PaperSellRuntimeConfig } from "./PaperSellConfig.js";
import type { PaperSellAccountingResult } from "./PaperSellAccountingService.js";
import type { PaperSellQuoteContext } from "./PaperSellQuoteService.js";
import type { PaperSellValidationRejection } from "./PaperSellValidationService.js";

export function buildSellOrderInput(input: {
  readonly candidate: PaperSellCandidate;
  readonly config: PaperSellRuntimeConfig;
  readonly reason: string;
  readonly rejection?: PaperSellValidationRejection;
}): CreateOrderInput {
  return {
    sessionId: input.candidate.session.id,
    mode: "PAPER",
    side: "SELL",
    mintAddress: input.candidate.position.mintAddress,
    status: "CREATED",
    requestedTokenAmount: input.candidate.position.tokensHeld,
    reason: input.reason,
    rawOrderJson: stringifyJson(buildSellOrderContext(input)),
  };
}

export function buildSellOrderContext(input: {
  readonly candidate: PaperSellCandidate;
  readonly config: PaperSellRuntimeConfig;
  readonly reason: string;
  readonly rejection?: PaperSellValidationRejection;
}): unknown {
  return {
    phase: "PHASE_7_5_PAPER_SELL",
    kind: "SELL_ORDER",
    ...(input.config.exitContext ? { exitContext: input.config.exitContext } : {}),
    dryRun: input.config.dryRun,
    reason: input.reason,
    triggerType: input.config.trigger.type,
    positionId: input.candidate.position.id,
    selectionContext: {
      sessionId: input.candidate.session.id,
      mintAddress: input.candidate.position.mintAddress,
      limit: input.config.limit,
    },
    positionContext: compactPosition(input.candidate),
    priceSourcePolicy: {
      quoteSource: input.config.quoteSource,
      allowCachedRadarPrice: input.config.allowCachedRadarPrice,
      maxCachedPriceAgeMs: input.config.maxCachedPriceAgeMs,
    },
    ...(input.rejection
      ? {
          rejectionCode: input.rejection.code,
          rejectionMessage: input.rejection.message,
          rejectionContext: input.rejection.context,
        }
      : {}),
  };
}

export function buildSellQuoteOrderContext(input: {
  readonly candidate: PaperSellCandidate;
  readonly config: PaperSellRuntimeConfig;
  readonly quote: PaperSellQuoteContext;
  readonly accounting?: PaperSellAccountingResult;
  readonly status: "QUOTED" | "FILLED";
  readonly fillId?: string;
}): unknown {
  return {
    phase: "PHASE_7_5_PAPER_SELL",
    kind: "SELL_QUOTE",
    ...(input.config.exitContext ? { exitContext: input.config.exitContext } : {}),
    status: input.status,
    positionId: input.candidate.position.id,
    tokenRadarId: input.candidate.tokenRadar?.id,
    quote: input.quote,
    accounting: input.accounting,
    ...(input.fillId ? { fillId: input.fillId } : {}),
  };
}

function compactPosition(candidate: PaperSellCandidate): unknown {
  return {
    id: candidate.position.id,
    sessionId: candidate.position.sessionId,
    mintAddress: candidate.position.mintAddress,
    status: candidate.position.status,
    tokensHeld: candidate.position.tokensHeld,
    costBasisLamports: candidate.position.costBasisLamports,
    feesPaidLamports: candidate.position.feesPaidLamports,
    avgEntryPriceSol: candidate.position.avgEntryPriceSol,
  };
}
