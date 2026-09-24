import type { Repositories } from "../db/repositories/RepositoryFactory.js";
import type { PaperExecutionCandidate } from "./PaperExecutionCandidateSelector.js";
import type { PaperExchangeRuntimeConfig } from "./PaperExchangeConfig.js";
import { identifyPaperBuy } from "./PaperOperationIdentity.js";
import type { PaperOperationResult } from "./PaperOperationResult.js";
import { buildPaperQuote, buildFillInput } from "./PaperFillFactory.js";
import { buildBuyOrderInput } from "./PaperOrderFactory.js";
import { buildOpenPositionInput } from "./PaperPositionFactory.js";

export interface PaperBuyOutcome {
  readonly result: PaperOperationResult;
  readonly replayed: boolean;
}

/** Explicit candidate API also supports replay when discovery no longer selects a BOUGHT radar. */
export function executePaperBuy(input: {
  readonly repositories: Repositories;
  readonly candidate: PaperExecutionCandidate;
  readonly config: PaperExchangeRuntimeConfig;
  readonly clock: () => number;
  readonly explicitIntentId?: string;
}): PaperBuyOutcome {
  const { repositories, candidate, config, clock } = input;
  if (config.dryRun) throw new Error("PAPER_OPERATION_INVALID_INTENT");
  const identity = identifyPaperBuy(candidate, config, input.explicitIntentId);
  const existing = repositories.accounting.run((r) => {
    r.operations.register(identity, clock());
    return r.operations.readTerminal(identity);
  });
  if (existing) return { result: existing, replayed: true };
  // Pure quote preparation deliberately retains the established BUY radar pricing policy.
  const quote = buildPaperQuote({ candidate, config });
  if (!quote) throw new Error("PAPER_OPERATION_RETRYABLE_EVIDENCE:MISSING_PRICE_SOL");
  if (!Number.isSafeInteger(quote.totalCostLamports))
    throw new Error("PAPER_OPERATION_INVALID_INTENT");
  return repositories.accounting.run((r) => {
    const terminal = r.operations.readTerminal(identity);
    if (terminal) return { result: terminal, replayed: true };
    const session = r.sessions.getSessionById(identity.sessionId);
    const radar = r.tokenRadar.getRadarEntryById(candidate.tokenRadar.id);
    const decision = r.strategyDecisions.getStrategyDecisionById(identity.sourceId);
    if (
      !session ||
      !radar ||
      !decision ||
      radar.sessionId !== identity.sessionId ||
      radar.mintAddress !== identity.mint ||
      decision.sessionId !== identity.sessionId ||
      decision.mintAddress !== identity.mint
    )
      throw new Error("PAPER_OPERATION_CORRUPT_OPERATION");
    const reject = (code: string): PaperBuyOutcome => {
      const order = r.orders.createOrder({
        ...buildBuyOrderInput({ candidate, config, reason: code }),
        operationId: identity.id,
        status: "REJECTED",
      });
      return {
        replayed: false,
        result: r.operations.finish(
          identity,
          {
            version: 1,
            operationId: identity.id,
            side: "BUY",
            state: "REJECTED",
            code,
            orderId: order.id,
            cashDeltaLamports: 0,
            realizedPnlDeltaLamports: 0,
            feesLamports: 0,
            slippageLamports: 0,
            grossProceedsLamports: 0,
          },
          clock(),
        ),
      };
    };
    if (
      session.mode !== "PAPER" ||
      session.status !== "RUNNING" ||
      session.terminationReason !== "NOT_TERMINATED"
    )
      return reject("INVALID_SESSION");
    if (radar.status !== "APPROVED" || decision.decision !== "BUY")
      return reject("INVALID_LIFECYCLE");
    const currentRisk = r.riskAssessments.getLatestRiskAssessment(
      identity.sessionId,
      identity.mint,
    );
    if (
      JSON.stringify(radar) !== JSON.stringify(candidate.tokenRadar) ||
      JSON.stringify(decision) !== JSON.stringify(candidate.strategyDecision) ||
      JSON.stringify(currentRisk) !== JSON.stringify(candidate.latestRiskAssessment)
    )
      throw new Error("PAPER_OPERATION_STALE_EVIDENCE");
    if (r.positions.getBlockingPositionByMint(identity.sessionId, identity.mint))
      return reject("OPEN_POSITION_EXISTS");
    if (session.currentCashLamports < quote.totalCostLamports) return reject("INSUFFICIENT_CASH");
    const order = r.orders.createOrder({
      ...buildBuyOrderInput({ candidate, config, reason: "PAPER_BUY" }),
      operationId: identity.id,
    });
    r.orders.linkOrderToQuote(order.id, {
      quoteSource: quote.quoteSource,
      rawOrder: {
        phase: "PHASE_7_PAPER_EXCHANGE",
        kind: "SIMULATED_BUY_QUOTE",
        tokenRadarId: radar.id,
        strategyDecisionId: decision.id,
        quote,
      },
    });
    const quoted = r.orders.transitionOrder(order, "QUOTED");
    const fill = r.fills.createFill({
      ...buildFillInput({
        orderId: order.id,
        sessionId: identity.sessionId,
        filledAtMs: clock(),
        quote,
      }),
      operationId: identity.id,
    });
    const position = r.positions.openPosition(
      buildOpenPositionInput({ candidate, quote, openedAtMs: fill.filledAtMs }),
    );
    r.sessions.applyAccountingDelta(session, -quote.totalCostLamports, 0);
    r.orders.transitionOrder(quoted, "FILLED");
    r.tokenRadar.updateRadarStatus(
      radar.id,
      "BOUGHT",
      radar.notes?.includes("Paper BUY filled.")
        ? radar.notes
        : [radar.notes, "Paper BUY filled."].filter(Boolean).join("\n"),
    );
    return {
      replayed: false,
      result: r.operations.finish(
        identity,
        {
          version: 1,
          operationId: identity.id,
          side: "BUY",
          state: "COMMITTED",
          code: "PAPER_BUY",
          orderId: order.id,
          fillId: fill.id,
          positionId: position.id,
          cashDeltaLamports: -quote.totalCostLamports,
          realizedPnlDeltaLamports: 0,
          feesLamports: quote.estimatedBaseFeeLamports + quote.estimatedPriorityFeeLamports,
          slippageLamports: quote.estimatedSlippageLamports,
          grossProceedsLamports: 0,
        },
        clock(),
      ),
    };
  });
}
