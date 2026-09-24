import { afterEach, describe, expect, it } from "vitest";
import { h2Fixture } from "./H2Fixtures.js";
import { identifyPaperBuy } from "../../paper/PaperOperationIdentity.js";
import { defaultPaperExchangeConfig } from "../../paper/PaperExchangeConfig.js";
import { openDatabase, type DatabaseContext } from "../connection.js";
import { createRepositories } from "../repositories/RepositoryFactory.js";

let fixture: ReturnType<typeof h2Fixture> | undefined;
let second: DatabaseContext | undefined;
afterEach(() => {
  second?.close();
  second = undefined;
  fixture?.cleanup();
  fixture = undefined;
});
function setup() {
  fixture = h2Fixture();
  const candidate = { tokenRadar: fixture.radar, strategyDecision: fixture.decision };
  const config = defaultPaperExchangeConfig();
  const identity = identifyPaperBuy(candidate, config);
  const registered = fixture.repositories.accounting.run((r) =>
    r.operations.register(identity, 1000),
  );
  return { ...fixture, candidate, config, identity, registered };
}
describe("H2 durable operation registration", () => {
  it("replays registration across independent connections without economic writes", () => {
    const f = setup();
    second = openDatabase(f.context.path, "PAPER");
    const r = createRepositories(second.db);
    expect(r.accounting.run((tx) => tx.operations.register(f.identity, 2000))).toEqual(
      f.registered,
    );
    expect(r.operations.readTerminal(f.identity)).toBeUndefined();
    expect(r.sessions.getSessionById(f.session.id)).toEqual(f.session);
    expect(r.orders.listOrders(f.session.id)).toHaveLength(0);
    expect(r.operations.listOperations(f.session.id)).toHaveLength(1);
  });
  it("rejects changed economics for an existing key and permits explicit distinct intent", () => {
    const f = setup();
    const changed = identifyPaperBuy(f.candidate, {
      ...f.config,
      baseFeeLamports: f.config.baseFeeLamports + 1,
    });
    expect(() =>
      f.repositories.accounting.run((r) => r.operations.register(changed, 2000)),
    ).toThrow("IDENTITY_CONFLICT");
    const next = identifyPaperBuy(f.candidate, f.config, "approved-distinct-intent");
    f.repositories.accounting.run((r) => r.operations.register(next, 2000));
    expect(f.repositories.operations.listOperations(f.session.id)).toHaveLength(2);
  });
  it("persists rejection and returns the same terminal result after reopening", () => {
    const f = setup();
    const result = f.repositories.accounting.run((r) => {
      const order = r.orders.createOrder({
        sessionId: f.session.id,
        mode: "PAPER",
        side: "BUY",
        mintAddress: f.radar.mintAddress,
        operationId: f.identity.id,
        strategyDecisionId: f.decision.id,
        status: "REJECTED",
      });
      return r.operations.finish(
        f.identity,
        {
          version: 1,
          operationId: f.identity.id,
          side: "BUY",
          state: "REJECTED",
          code: "INSUFFICIENT_CASH",
          orderId: order.id,
          cashDeltaLamports: 0,
          realizedPnlDeltaLamports: 0,
          feesLamports: 0,
          slippageLamports: 0,
          grossProceedsLamports: 0,
        },
        2000,
      );
    });
    second = openDatabase(f.context.path, "PAPER");
    const r = createRepositories(second.db);
    expect(r.operations.readTerminal(f.identity)).toEqual(result);
    expect(() => r.accounting.run((tx) => tx.operations.finish(f.identity, result, 3000))).toThrow(
      "INVALID_STATE",
    );
    second.sqlite.prepare("UPDATE orders SET status='FAILED' WHERE id=?").run(result.orderId);
    expect(() => r.operations.readTerminal(f.identity)).toThrow("CORRUPT_OPERATION");
  });
  it("rejects invalid owned result references and rolls back partial writes", () => {
    const f = setup();
    expect(() =>
      f.repositories.accounting.run((r) => {
        const order = r.orders.createOrder({
          sessionId: f.session.id,
          mode: "PAPER",
          side: "BUY",
          mintAddress: f.radar.mintAddress,
          status: "REJECTED",
        });
        r.operations.finish(
          f.identity,
          {
            version: 1,
            operationId: f.identity.id,
            side: "BUY",
            state: "REJECTED",
            code: "INSUFFICIENT_CASH",
            orderId: order.id,
            cashDeltaLamports: 0,
            realizedPnlDeltaLamports: 0,
            feesLamports: 0,
            slippageLamports: 0,
            grossProceedsLamports: 0,
          },
          2000,
        );
      }),
    ).toThrow("CORRUPT_OPERATION");
    expect(f.repositories.orders.listOrders(f.session.id)).toHaveLength(0);
    expect(f.repositories.operations.getOperation(f.identity.id)?.state).toBe("PENDING");
  });
  it("returns bounded contention without changing the configured timeout or state", () => {
    const f = setup();
    second = openDatabase(f.context.path, "PAPER");
    // Only this synthetic contender gets a zero wait; production connection configuration is unchanged.
    second.sqlite.pragma("busy_timeout=0");
    const r = createRepositories(second.db);
    f.context.sqlite.exec("BEGIN IMMEDIATE");
    try {
      expect(() => r.accounting.run((tx) => tx.operations.register(f.identity, 2000))).toThrow(
        "RETRYABLE_CONTENTION",
      );
      expect(second.sqlite.pragma("busy_timeout", { simple: true })).toBe(0);
      expect(f.context.sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      f.context.sqlite.exec("ROLLBACK");
    }
    expect(r.accounting.run((tx) => tx.operations.register(f.identity, 2000))).toEqual(
      f.registered,
    );
  });
});
