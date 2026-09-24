import type { OpenPositionInput } from "../db/repositories/PositionRepository.js";
import type { PaperExecutionCandidate } from "./PaperExecutionCandidateSelector.js";
import type { PaperQuoteContext } from "./PaperFillFactory.js";

export function buildOpenPositionInput(input: {
  readonly candidate: PaperExecutionCandidate;
  readonly quote: PaperQuoteContext;
  readonly openedAtMs: number;
}): OpenPositionInput {
  return {
    sessionId: input.candidate.tokenRadar.sessionId,
    mintAddress: input.candidate.tokenRadar.mintAddress,
    status: "OPEN",
    openedAtMs: input.openedAtMs,
    avgEntryPriceSol: input.quote.priceSol,
    tokensHeld: input.quote.tokensFilled,
    costBasisLamports: input.quote.requestedSolLamports + input.quote.estimatedSlippageLamports,
    feesPaidLamports:
      input.quote.estimatedBaseFeeLamports + input.quote.estimatedPriorityFeeLamports,
  };
}
