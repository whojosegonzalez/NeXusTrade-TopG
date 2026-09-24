import { afterEach, describe, expect, it, vi } from "vitest";
import { h2Fixture } from "./H2Fixtures.js";
import { executePaperBuy } from "../../paper/PaperBuyAccounting.js";
import { defaultPaperExchangeConfig } from "../../paper/PaperExchangeConfig.js";
import { PaperRunner } from "../../paper/PaperRunner.js";
import { FillRepository } from "../repositories/FillRepository.js";
import { PositionRepository } from "../repositories/PositionRepository.js";
import { SessionRepository } from "../repositories/SessionRepository.js";
import { TokenRadarRepository } from "../repositories/TokenRadarRepository.js";
import { PaperOperationRepository } from "../repositories/PaperOperationRepository.js";
import { OrderRepository } from "../repositories/OrderRepository.js";
import { PaperExecutionService } from "../../paper/PaperExecutionService.js";
import { PaperExecutionCandidateSelector } from "../../paper/PaperExecutionCandidateSelector.js";

let fixture: ReturnType<typeof h2Fixture> | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  fixture?.cleanup();
  fixture = undefined;
});
function setup() {
  fixture = h2Fixture();
  const input = {
    repositories: fixture.repositories,
    candidate: { tokenRadar: fixture.radar, strategyDecision: fixture.decision },
    config: { ...defaultPaperExchangeConfig(), sessionId: fixture.session.id },
    clock: () => Date.now(),
  };
  return { ...fixture, input };
}
describe("H2 BUY atomic application path", () => {
  it("revalidates the BUY gate and durably replays its business rejection", () => {
    const f = setup();
    f.repositories.sessions.markTerminationReason(f.session.id, "TARGET_REACHED");
    const first = executePaperBuy(f.input);
    expect(first.result).toMatchObject({ state: "REJECTED", code: "INVALID_SESSION" });
    expect(executePaperBuy(f.input)).toEqual({ result: first.result, replayed: true });
    expect(f.repositories.orders.listOrders(f.session.id)).toHaveLength(1);
    expect(f.repositories.fills.listFillsForSession(f.session.id)).toHaveLength(0);
  });
  it("preserves rollback when failure diagnostics also fail", async () => {
    const f = setup();
    vi.spyOn(SessionRepository.prototype, "applyAccountingDelta").mockImplementation(() => {
      throw new Error("cash unavailable");
    });
    vi.spyOn(f.repositories.systemLogs, "createLog").mockImplementation(() => {
      throw new Error("log unavailable");
    });
    expect(await new PaperRunner(f.input).runOnce()).toMatchObject({
      failedCount: 1,
      executedCount: 0,
      diagnosticFailureCount: 3,
    });
    expect(f.repositories.orders.listOrders(f.session.id)).toHaveLength(0);
    expect(f.repositories.sessions.getSessionById(f.session.id)).toEqual(f.session);
  });
  it("reports replay separately and allows a genuinely new eligible decision", async () => {
    const f = setup();
    const first = executePaperBuy(f.input);
    const selector = new PaperExecutionCandidateSelector(f.repositories);
    vi.spyOn(selector, "selectCandidates").mockReturnValue({
      session: f.session,
      candidates: [f.input.candidate],
      missingRiskAssessmentCount: 1,
    });
    const replay = await new PaperExecutionService({ ...f.input, selector }).execute();
    expect(replay).toMatchObject({
      replayedCount: 1,
      executedCount: 0,
      orderCreatedCount: 0,
      cashUpdatedCount: 0,
    });
    f.repositories.positions.closePosition(first.result.positionId!, {
      tokensHeld: "0",
      proceedsLamports: 10_000_000,
      realizedPnlLamports: -105_000,
    });
    const radar = f.repositories.tokenRadar.updateRadarStatus(f.radar.id, "APPROVED");
    const decision = f.repositories.strategyDecisions.createStrategyDecision({
      ...f.decision,
      id: "genuinely-new-decision",
    });
    const next = executePaperBuy({
      ...f.input,
      candidate: { tokenRadar: radar, strategyDecision: decision },
    });
    expect(next.result.operationId).not.toBe(first.result.operationId);
    expect(next.result.state).toBe("COMMITTED");
    expect(f.repositories.positions.listOpenPositions(f.session.id)).toHaveLength(1);
    expect(f.repositories.positions.listClosedPositions(f.session.id)).toHaveLength(1);
  });
  it.each(["link", "order", "fill", "position", "cash", "radar", "terminal", "after-terminal"])(
    "rolls back every trade write after a %s failure",
    (stage) => {
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
        vi.spyOn(PositionRepository.prototype, "openPosition").mockImplementation(fail);
      if (stage === "cash")
        vi.spyOn(SessionRepository.prototype, "applyAccountingDelta").mockImplementation(fail);
      if (stage === "radar")
        vi.spyOn(TokenRadarRepository.prototype, "updateRadarStatus").mockImplementation(fail);
      if (stage === "terminal")
        vi.spyOn(PaperOperationRepository.prototype, "finish").mockImplementation(fail);
      expect(() => executePaperBuy(f.input)).toThrow("injected");
      expect(f.repositories.orders.listOrders(f.session.id)).toHaveLength(0);
      expect(f.repositories.fills.listFillsForSession(f.session.id)).toHaveLength(0);
      expect(f.repositories.positions.listOpenPositions(f.session.id)).toHaveLength(0);
      expect(f.repositories.sessions.getSessionById(f.session.id)).toEqual(f.session);
      expect(f.repositories.tokenRadar.getRadarEntryById(f.radar.id)).toEqual(f.radar);
      expect(f.repositories.operations.listOperations(f.session.id)[0]?.state).toBe("PENDING");
      vi.restoreAllMocks();
      expect(executePaperBuy(f.input).result.state).toBe("COMMITTED");
    },
  );
  it("replays a committed candidate with no new accounting effects", () => {
    const f = setup();
    const first = executePaperBuy(f.input);
    const replay = executePaperBuy(f.input);
    expect(replay).toEqual({ result: first.result, replayed: true });
    expect(f.repositories.orders.listOrders(f.session.id)).toHaveLength(1);
    expect(f.repositories.fills.listFillsForSession(f.session.id)).toHaveLength(1);
    expect(f.repositories.sessions.getSessionById(f.session.id)?.currentCashLamports).toBe(
      f.session.currentCashLamports + first.result.cashDeltaLamports,
    );
  });
  it("rejects a stale quote snapshot and permits retry with current evidence", () => {
    const f = setup();
    const changed = f.repositories.tokenRadar.upsertRadarEntry({
      ...f.radarInput,
      discoveredAtMs: 2000,
      priceSol: "0.002",
    });
    expect(() => executePaperBuy(f.input)).toThrow("STALE_EVIDENCE");
    expect(f.repositories.orders.listOrders(f.session.id)).toHaveLength(0);
    expect(
      executePaperBuy({ ...f.input, candidate: { ...f.input.candidate, tokenRadar: changed } })
        .result.state,
    ).toBe("COMMITTED");
  });
  it("uses current cash and preserves unrelated P/L and governance fields", () => {
    const f = setup();
    f.repositories.sessions.updateSessionPnl(f.session.id, {
      currentCashLamports: 200_000_000,
      realizedPnlLamports: -75,
      unrealizedPnlLamports: 55,
    });
    const first = executePaperBuy(f.input);
    expect(f.repositories.sessions.getSessionById(f.session.id)).toMatchObject({
      currentCashLamports: 200_000_000 + first.result.cashDeltaLamports,
      realizedPnlLamports: -75,
      unrealizedPnlLamports: 55,
    });
  });
  it("preserves a committed result when every diagnostic write fails", async () => {
    const f = setup();
    vi.spyOn(f.repositories.systemLogs, "createLog").mockImplementation(() => {
      throw new Error("log unavailable");
    });
    const result = await new PaperRunner(f.input).runOnce();
    expect(result).toMatchObject({ executedCount: 1, failedCount: 0, diagnosticFailureCount: 3 });
    expect(f.repositories.orders.listOrders(f.session.id)[0]?.status).toBe("FILLED");
    expect(f.repositories.tokenRadar.getRadarEntryById(f.radar.id)?.status).toBe("BOUGHT");
  });
  it("dry-run writes no durable operation or accounting state", async () => {
    const f = setup();
    await new PaperRunner({ ...f.input, config: { ...f.input.config, dryRun: true } }).runOnce();
    expect(f.repositories.operations.listOperations(f.session.id)).toHaveLength(0);
    expect(f.repositories.orders.listOrders(f.session.id)).toHaveLength(0);
    expect(f.repositories.sessions.getSessionById(f.session.id)).toEqual(f.session);
    expect(f.repositories.tokenRadar.getRadarEntryById(f.radar.id)).toEqual(f.radar);
  });
});
