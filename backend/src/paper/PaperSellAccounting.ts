import type { Repositories } from "../db/repositories/RepositoryFactory.js";
import type { PaperSellCandidate } from "./PaperSellCandidateSelector.js";
import type { PaperSellRuntimeConfig } from "./PaperSellConfig.js";
import { identifyPaperSell } from "./PaperOperationIdentity.js";
import type { PaperOperationResult } from "./PaperOperationResult.js";
import type { PaperSellQuoteService } from "./PaperSellQuoteService.js";
import { PaperSellValidationService } from "./PaperSellValidationService.js";
import { PaperSellAccountingService } from "./PaperSellAccountingService.js";
import { buildSellOrderInput, buildSellQuoteOrderContext } from "./PaperSellOrderFactory.js";
import { buildSellFillInput } from "./PaperSellFillFactory.js";

export async function executePaperSell(input: {
  readonly repositories: Repositories;
  readonly candidate: PaperSellCandidate;
  readonly config: PaperSellRuntimeConfig;
  readonly quoteService: Pick<PaperSellQuoteService, "resolveQuote">;
  readonly clock: () => number;
  readonly explicitIntentId?: string;
}): Promise<{
  readonly result: PaperOperationResult;
  readonly replayed: boolean;
  readonly radarUpdated: boolean;
}> {
  const { repositories, clock } = input;
  const candidate = structuredClone(input.candidate);
  const config = structuredClone(input.config);
  if (config.dryRun) throw new Error("PAPER_OPERATION_INVALID_INTENT");
  const identity = identifyPaperSell(candidate, config, input.explicitIntentId);
  const existing = repositories.accounting.run((r) => {
    r.operations.register(identity, clock());
    return r.operations.readTerminal(identity);
  });
  if (existing) return { result: existing, replayed: true, radarUpdated: false };
  const validation = new PaperSellValidationService();
  const initialRejection =
    validation.validateSession(candidate.session) ??
    validation.validatePosition(candidate.position);
  // No quote/enrichment work runs under the SQLite writer lock.
  const resolution = initialRejection
    ? undefined
    : await input.quoteService.resolveQuote(candidate, config, clock());
  if (resolution && !resolution.ok)
    throw new Error(`PAPER_OPERATION_RETRYABLE_EVIDENCE:${resolution.rejection.code}`);
  const quote = resolution?.ok ? structuredClone(resolution.quote) : undefined;
  return repositories.accounting.run((r) => {
    const terminal = r.operations.readTerminal(identity);
    if (terminal) return { result: terminal, replayed: true, radarUpdated: false };
    const session = r.sessions.getSessionById(identity.sessionId);
    const position = r.positions.getPositionById(identity.sourceId);
    const radar = candidate.tokenRadar
      ? r.tokenRadar.getRadarEntryById(candidate.tokenRadar.id)
      : undefined;
    if (
      !session ||
      !position ||
      position.sessionId !== identity.sessionId ||
      position.mintAddress !== identity.mint ||
      (candidate.tokenRadar &&
        (!radar || radar.sessionId !== identity.sessionId || radar.mintAddress !== identity.mint))
    )
      throw new Error("PAPER_OPERATION_CORRUPT_OPERATION");
    const reject = (code: string) => {
      const order = r.orders.createOrder({
        ...buildSellOrderInput({ candidate, config, reason: code }),
        operationId: identity.id,
        status: "REJECTED",
      });
      return {
        replayed: false,
        radarUpdated: false,
        result: r.operations.finish(
          identity,
          {
            version: 1,
            operationId: identity.id,
            side: "SELL",
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
    const rejection = validation.validateSession(session) ?? validation.validatePosition(position);
    if (rejection) return reject(rejection.code);
    if (config.trigger.type === "MINT" && config.trigger.mintAddress !== identity.mint)
      return reject("MISSING_EXPLICIT_TRIGGER");
    if (
      config.exitContext &&
      (config.trigger.type !== "SELL_ALL" ||
        session.terminationReason !== config.exitContext.trigger)
    )
      return reject("INVALID_SESSION");
    if (
      session.terminationReason !== candidate.session.terminationReason ||
      position.tokensHeld !== candidate.position.tokensHeld ||
      position.costBasisLamports !== candidate.position.costBasisLamports ||
      position.feesPaidLamports !== candidate.position.feesPaidLamports
    )
      throw new Error("PAPER_OPERATION_STALE_EVIDENCE");
    if (!quote) throw new Error("PAPER_OPERATION_RETRYABLE_EVIDENCE");
    if (quote.tokensSold !== position.tokensHeld) throw new Error("PAPER_OPERATION_STALE_EVIDENCE");
    const timestamp = clock();
    if (quote.priceSource === "CACHED_RADAR_PRICE") {
      if (
        !config.allowCachedRadarPrice ||
        !radar ||
        radar.priceSol !== candidate.tokenRadar?.priceSol ||
        radar.updatedAtMs !== candidate.tokenRadar.updatedAtMs ||
        timestamp < radar.updatedAtMs ||
        timestamp - radar.updatedAtMs > config.maxCachedPriceAgeMs
      )
        throw new Error("PAPER_OPERATION_STALE_EVIDENCE");
    }
    const accounting = new PaperSellAccountingService().calculate({ position, quote, config });
    if (!accounting) return reject("INSUFFICIENT_LIQUIDITY");
    const order = r.orders.createOrder({
      ...buildSellOrderInput({ candidate, config, reason: "PAPER_SELL" }),
      operationId: identity.id,
    });
    r.orders.linkOrderToQuote(order.id, {
      quoteSource: quote.quoteSource,
      rawOrder: buildSellQuoteOrderContext({
        candidate,
        config,
        quote,
        accounting,
        status: "QUOTED",
      }),
    });
    const quoted = r.orders.transitionOrder(order, "QUOTED");
    const fill = r.fills.createFill({
      ...buildSellFillInput({
        orderId: order.id,
        candidate,
        quote,
        accounting,
        config,
        filledAtMs: timestamp,
      }),
      operationId: identity.id,
    });
    r.positions.closePositionConditionally(position, {
      closedAtMs: timestamp,
      avgExitPriceSol: quote.priceSol,
      tokensHeld: "0",
      proceedsLamports: accounting.netSellProceedsLamports,
      realizedPnlLamports: accounting.realizedPnlLamports,
      ...(accounting.realizedPnlBps === undefined
        ? {}
        : { realizedPnlBps: accounting.realizedPnlBps }),
      feesPaidLamports: accounting.totalFeesPaidLamports,
    });
    r.sessions.applyAccountingDelta(
      session,
      accounting.netSellProceedsLamports,
      accounting.realizedPnlLamports,
    );
    r.orders.transitionOrder(quoted, "FILLED");
    const radarUpdated = radar?.status === "BOUGHT";
    if (radar && radarUpdated)
      r.tokenRadar.updateRadarStatus(
        radar.id,
        "WATCHING",
        [radar.notes, `Paper SELL closed realizedPnlLamports=${accounting.realizedPnlLamports}`]
          .filter(Boolean)
          .join("\n"),
      );
    return {
      replayed: false,
      radarUpdated,
      result: r.operations.finish(
        identity,
        {
          version: 1,
          operationId: identity.id,
          side: "SELL",
          state: "COMMITTED",
          code: "PAPER_SELL",
          orderId: order.id,
          fillId: fill.id,
          positionId: position.id,
          cashDeltaLamports: accounting.netSellProceedsLamports,
          realizedPnlDeltaLamports: accounting.realizedPnlLamports,
          feesLamports: accounting.sellFeesLamports,
          slippageLamports: accounting.sellSlippageLamports,
          grossProceedsLamports: accounting.grossProceedsLamports,
          priceSource: quote.priceSource,
        },
        clock(),
      ),
    };
  });
}
