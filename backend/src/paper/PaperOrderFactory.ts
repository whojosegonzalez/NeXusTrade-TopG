import type { CreateOrderInput } from "../db/repositories/OrderRepository.js";
import { stringifyJson } from "../db/utils/json.js";
import type { PaperExecutionCandidate } from "./PaperExecutionCandidateSelector.js";
import type { PaperExchangeRuntimeConfig } from "./PaperExchangeConfig.js";
import { formatLamportsAsSol } from "./PaperMath.js";

export interface PaperOrderContext {
  readonly phase: "PHASE_7_PAPER_EXCHANGE";
  readonly kind: "BUY_ORDER";
  readonly dryRun: boolean;
  readonly requestedSolLamports: number;
  readonly requestedSol: string;
  readonly reason: string;
  readonly tokenRadarId: string;
  readonly strategyDecisionId: string;
}

export function buildBuyOrderInput(input: {
  readonly candidate: PaperExecutionCandidate;
  readonly config: PaperExchangeRuntimeConfig;
  readonly reason: string;
}): CreateOrderInput {
  const context = buildOrderContext(input);

  return {
    sessionId: input.candidate.tokenRadar.sessionId,
    mode: "PAPER",
    side: "BUY",
    mintAddress: input.candidate.tokenRadar.mintAddress,
    status: "CREATED",
    requestedSolLamports: input.config.buySolLamports,
    strategyDecisionId: input.candidate.strategyDecision.id,
    reason: input.reason,
    rawOrderJson: stringifyJson(context),
  };
}

export function buildOrderContext(input: {
  readonly candidate: PaperExecutionCandidate;
  readonly config: PaperExchangeRuntimeConfig;
  readonly reason: string;
}): PaperOrderContext {
  return {
    phase: "PHASE_7_PAPER_EXCHANGE",
    kind: "BUY_ORDER",
    dryRun: input.config.dryRun,
    requestedSolLamports: input.config.buySolLamports,
    requestedSol: formatLamportsAsSol(input.config.buySolLamports),
    reason: input.reason,
    tokenRadarId: input.candidate.tokenRadar.id,
    strategyDecisionId: input.candidate.strategyDecision.id,
  };
}
