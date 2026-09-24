import { afterEach, describe, expect, it, vi } from "vitest";
import { h2Fixture } from "./H2Fixtures.js";
import { executePaperBuy } from "../../paper/PaperBuyAccounting.js";
import { executePaperSell } from "../../paper/PaperSellAccounting.js";
import { defaultPaperExchangeConfig } from "../../paper/PaperExchangeConfig.js";
import { defaultPaperSellConfig } from "../../paper/PaperSellConfig.js";
import { FillRepository } from "../repositories/FillRepository.js";
import { PositionRepository } from "../repositories/PositionRepository.js";
import { SessionRepository } from "../repositories/SessionRepository.js";
import { TokenRadarRepository } from "../repositories/TokenRadarRepository.js";
import { PaperOperationRepository } from "../repositories/PaperOperationRepository.js";
import { OrderRepository } from "../repositories/OrderRepository.js";
import type { PaperSellQuoteResolution } from "../../paper/PaperSellQuoteService.js";
import { openDatabase, type DatabaseContext } from "../connection.js";
import { createRepositories } from "../repositories/RepositoryFactory.js";
import { PaperSellExecutionService } from "../../paper/PaperSellExecutionService.js";
import { PaperSellCandidateSelector } from "../../paper/PaperSellCandidateSelector.js";
import { PaperSellQuoteService } from "../../paper/PaperSellQuoteService.js";

let fixture: ReturnType<typeof h2Fixture> | undefined;
let second: DatabaseContext | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  second?.close();
  second = undefined;
  fixture?.cleanup();
  fixture = undefined;
});
function setup() {
  fixture = h2Fixture();
  executePaperBuy({
    repositories: fixture.repositories,
    candidate: { tokenRadar: fixture.radar, strategyDecision: fixture.decision },
    config: defaultPaperExchangeConfig(),
    clock: () => Date.now(),
  });
  const position = fixture.repositories.positions.listOpenPositions(fixture.session.id)[0]!;
  const session = fixture.repositories.sessions.getSessionById(fixture.session.id)!;
  const radar = fixture.repositories.tokenRadar.getRadarEntryById(fixture.radar.id)!;
  const quote = {
    priceSource: "QUOTE" as const,
    quoteSource: "SYNTHETIC",
    priceSol: "0.002",
    tokensSold: position.tokensHeld,
    grossProceedsLamports: 20_000_000,
    fallbackUsed: false,
    warnings: [],
  };
  const resolveQuote = vi.fn(async (): Promise<PaperSellQuoteResolution> => ({ ok: true, quote }));
  const input = {
    repositories: fixture.repositories,
    candidate: { session, position, tokenRadar: radar },
    config: defaultPaperSellConfig({ type: "SELL_ALL" }),
    quoteService: { resolveQuote },
    clock: () => Date.now(),
  };
  return { ...fixture, position, session, radar, quote, resolveQuote, input };
}
describe("H2 full-close SELL atomic application path", () => {
  it("does not close a position that changed lifecycle while awaiting its quote", async () => {
    const f = setup();
    f.resolveQuote.mockImplementationOnce(async () => {
      f.repositories.positions.closePositionConditionally(f.position, {
        tokensHeld: "0",
        proceedsLamports: 1,
        realizedPnlLamports: -10_104_999,
      });
      return { ok: true, quote: f.quote };
    });
    const result = await executePaperSell(f.input);
    expect(result.result).toMatchObject({ state: "REJECTED", code: "POSITION_ALREADY_CLOSED" });
    expect(f.repositories.fills.listFillsForSession(f.session.id)).toHaveLength(1);
    expect(f.repositories.sessions.getSessionById(f.session.id)).toEqual(f.session);
  });
  it("separates logging failures and replay from newly committed SELL effects", async () => {
    const f = setup();
    const selector = new PaperSellCandidateSelector(f.repositories);
    vi.spyOn(selector, "selectCandidates").mockReturnValue({
      session: f.session,
      candidates: [f.input.candidate],
      triggerType: "SELL_ALL",
    });
    const quoteService = new PaperSellQuoteService({
      enrichToken: async () => {
        throw new Error("unexpected provider access");
      },
    });
    const quote = vi.spyOn(quoteService, "resolveQuote").mockImplementation(f.resolveQuote);
    vi.spyOn(f.repositories.systemLogs, "createLog").mockImplementation(() => {
      throw new Error("diagnostic failure");
    });
    const service = new PaperSellExecutionService({ ...f.input, selector, quoteService });
    expect(await service.execute()).toMatchObject({
      closedCount: 1,
      failedCount: 0,
      diagnosticFailureCount: 3,
      replayedCount: 0,
    });
    expect(await service.execute()).toMatchObject({
      closedCount: 0,
      failedCount: 0,
      diagnosticFailureCount: 3,
      replayedCount: 1,
      totalNetProceedsLamports: 0,
      totalRealizedPnlLamports: 0,
    });
    expect(quote).toHaveBeenCalledTimes(1);
    expect(
      f.repositories.orders.listOrders(f.session.id).every((order) => order.status === "FILLED"),
    ).toBe(true);
  });
  it.each(["link", "order", "fill", "position", "cash", "radar", "terminal", "after-terminal"])(
    "rolls back all SELL effects on %s failure",
    async (stage) => {
      const f = setup();
      const fail = () => {
        throw new Error("injected");
      };
      if (stage === "link")
        vi.spyOn(OrderRepository.prototype, "linkOrderToQuote").mockImplementation(fail);
      if (stage === "after-terminal") {
        const original = PaperOperationRepository.prototype.finish;
        vi.spyOn(PaperOperationRepository.prototype, "finish").mockImplementation(function (
          this: PaperOperationRepository,
          ...args
        ) {
          original.apply(this, args);
          throw new Error("injected");
        });
      }
      if (stage === "order")
        vi.spyOn(OrderRepository.prototype, "transitionOrder").mockImplementation(fail);
      if (stage === "fill")
        vi.spyOn(FillRepository.prototype, "createFill").mockImplementation(fail);
      if (stage === "position")
        vi.spyOn(PositionRepository.prototype, "closePositionConditionally").mockImplementation(
          fail,
        );
      if (stage === "cash")
        vi.spyOn(SessionRepository.prototype, "applyAccountingDelta").mockImplementation(fail);
      if (stage === "radar")
        vi.spyOn(TokenRadarRepository.prototype, "updateRadarStatus").mockImplementation(fail);
      if (stage === "terminal")
        vi.spyOn(PaperOperationRepository.prototype, "finish").mockImplementation(fail);
      await expect(executePaperSell(f.input)).rejects.toThrow("injected");
      expect(f.repositories.orders.listOrders(f.session.id)).toHaveLength(1);
      expect(f.repositories.fills.listFillsForSession(f.session.id)).toHaveLength(1);
      expect(f.repositories.positions.getPositionById(f.position.id)).toEqual(f.position);
      expect(f.repositories.sessions.getSessionById(f.session.id)).toEqual(f.session);
      expect(f.repositories.tokenRadar.getRadarEntryById(f.radar.id)).toEqual(f.radar);
      expect(
        f.repositories.operations.listOperations(f.session.id).find((row) => row.side === "SELL")
          ?.state,
      ).toBe("PENDING");
      vi.restoreAllMocks();
      expect((await executePaperSell(f.input)).result.state).toBe("COMMITTED");
    },
  );
  it("replays after reopening without calling the quote service again", async () => {
    const f = setup();
    const first = await executePaperSell(f.input);
    second = openDatabase(f.context.path, "PAPER");
    const replay = await executePaperSell({
      ...f.input,
      repositories: createRepositories(second.db),
    });
    expect(replay).toEqual({ result: first.result, replayed: true, radarUpdated: false });
    expect(f.resolveQuote).toHaveBeenCalledTimes(1);
    expect(f.repositories.orders.listOrders(f.session.id)).toHaveLength(2);
    expect(f.repositories.sessions.getSessionById(f.session.id)?.currentCashLamports).toBe(
      f.session.currentCashLamports + 19_795_000,
    );
  });
  it("preserves another connection's valid cash/P&L change while awaiting a quote", async () => {
    const f = setup();
    second = openDatabase(f.context.path, "PAPER");
    const r = createRepositories(second.db);
    f.resolveQuote.mockImplementationOnce(async () => {
      r.accounting.run((tx) => tx.sessions.applyAccountingDelta(f.session, -100, 25));
      r.sessions.updateSessionGovernance(f.session.id, { unrealizedPnlLamports: 75 });
      return { ok: true, quote: f.quote };
    });
    const result = await executePaperSell(f.input);
    expect(f.repositories.sessions.getSessionById(f.session.id)).toMatchObject({
      currentCashLamports: f.session.currentCashLamports - 100 + result.result.cashDeltaLamports,
      realizedPnlLamports: 25 + result.result.realizedPnlDeltaLamports,
      unrealizedPnlLamports: 75,
    });
  });
  it.each(["quantity", "basis", "fees", "gate"])(
    "refuses changed %s evidence after quote work",
    async (field) => {
      const f = setup();
      f.resolveQuote.mockImplementationOnce(async () => {
        if (field === "gate")
          f.repositories.sessions.markTerminationReason(f.session.id, "TARGET_REACHED");
        else
          f.repositories.positions.updatePositionAfterFill(f.position.id, {
            tokensHeld: field === "quantity" ? "9" : f.position.tokensHeld,
            costBasisLamports: f.position.costBasisLamports + (field === "basis" ? 1 : 0),
            feesPaidLamports: f.position.feesPaidLamports + (field === "fees" ? 1 : 0),
          });
        return { ok: true, quote: f.quote };
      });
      await expect(executePaperSell(f.input)).rejects.toThrow("STALE_EVIDENCE");
      expect(f.repositories.orders.listOrders(f.session.id)).toHaveLength(1);
      expect(f.repositories.positions.getPositionById(f.position.id)?.status).toBe("OPEN");
    },
  );
  it("leaves unavailable quotes PENDING and retries the same operation", async () => {
    const f = setup();
    f.resolveQuote.mockResolvedValueOnce({
      ok: false,
      rejection: { code: "QUOTE_UNAVAILABLE", message: "synthetic" },
    });
    await expect(executePaperSell(f.input)).rejects.toThrow("RETRYABLE_EVIDENCE");
    expect((await executePaperSell(f.input)).result.state).toBe("COMMITTED");
    expect(f.repositories.operations.listOperations(f.session.id)).toHaveLength(2);
  });
  it("rechecks cached price age at commit", async () => {
    const f = setup();
    let now = f.radar.updatedAtMs;
    f.resolveQuote.mockImplementationOnce(async () => {
      now += 60_001;
      return {
        ok: true,
        quote: {
          ...f.quote,
          priceSource: "CACHED_RADAR_PRICE",
          priceSol: f.radar.priceSol!,
          fallbackUsed: true,
        },
      };
    });
    await expect(
      executePaperSell({
        ...f.input,
        config: { ...f.input.config, allowCachedRadarPrice: true },
        clock: () => now,
      }),
    ).rejects.toThrow("STALE_EVIDENCE");
    expect(f.repositories.positions.getPositionById(f.position.id)?.status).toBe("OPEN");
  });
  it("retains a negative realized P/L without subtracting SELL costs twice", async () => {
    const f = setup();
    f.resolveQuote.mockResolvedValueOnce({
      ok: true,
      quote: { ...f.quote, grossProceedsLamports: 5_000_000, priceSol: "0.0005" },
    });
    const result = await executePaperSell(f.input);
    expect(result.result).toMatchObject({
      cashDeltaLamports: 4_945_000,
      realizedPnlDeltaLamports: -5_160_000,
    });
  });
});
