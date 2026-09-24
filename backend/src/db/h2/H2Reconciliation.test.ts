import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "../schema/index.js";
import type { AppDatabase } from "../connection.js";
import { h2Fixture } from "./H2Fixtures.js";
import { executePaperBuy } from "../../paper/PaperBuyAccounting.js";
import { executePaperSell } from "../../paper/PaperSellAccounting.js";
import { defaultPaperExchangeConfig } from "../../paper/PaperExchangeConfig.js";
import { defaultPaperSellConfig } from "../../paper/PaperSellConfig.js";
import {
  reconcilePaperSession,
  type PaperReconciliationSnapshot,
} from "../../paper/PaperReconciliation.js";

let fixture: ReturnType<typeof h2Fixture> | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});
function snapshot(db: AppDatabase): PaperReconciliationSnapshot {
  return db.transaction((tx) => ({
    session: tx.select().from(schema.sessions).get(),
    orders: tx.select().from(schema.orders).all(),
    fills: tx.select().from(schema.fills).all(),
    positions: tx.select().from(schema.positions).all(),
    operations: tx.select().from(schema.paperOperations).all(),
    decisions: tx.select().from(schema.strategyDecisions).all(),
    radar: tx.select().from(schema.tokenRadar).all(),
  }));
}
function report(data: PaperReconciliationSnapshot) {
  return reconcilePaperSession("h2-session", { readSnapshot: () => data });
}
function setup() {
  fixture = h2Fixture();
  const f = fixture;
  executePaperBuy({
    repositories: f.repositories,
    candidate: { tokenRadar: f.radar, strategyDecision: f.decision },
    config: defaultPaperExchangeConfig(),
    clock: () => Date.now(),
  });
  return f;
}
describe("H2 read-only reconciliation", () => {
  it("does not prove a cash discrepancy by replacing missing amounts with zero", () => {
    const f = setup();
    const original = snapshot(f.context.db);
    const legacy = {
      ...original,
      operations: [],
      orders: original.orders.map((order) => ({ ...order, operationId: null })),
      fills: original.fills.map((fill) => ({ ...fill, operationId: null, solSpentLamports: null })),
    };
    const result = report(legacy);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.invariants.find((row) => row.check === "CASH")?.status).toBe("INCOMPLETE");
    expect(result.findings.some((row) => row.code === "CASH_EQUATION_MISMATCH")).toBe(false);
  });
  it("passes a complete open BUY and full-close SELL history", async () => {
    const f = setup();
    expect(report(snapshot(f.context.db)).status).toBe("PASS");
    const position = f.repositories.positions.listOpenPositions(f.session.id)[0]!;
    await executePaperSell({
      repositories: f.repositories,
      candidate: {
        session: f.repositories.sessions.getSessionById(f.session.id)!,
        position,
        tokenRadar: f.repositories.tokenRadar.getRadarEntryById(f.radar.id)!,
      },
      config: defaultPaperSellConfig({ type: "SELL_ALL" }),
      clock: () => Date.now(),
      quoteService: {
        resolveQuote: async () => ({
          ok: true,
          quote: {
            priceSource: "QUOTE",
            quoteSource: "SYNTHETIC",
            priceSol: "0.002",
            tokensSold: position.tokensHeld,
            grossProceedsLamports: 20_000_000,
            fallbackUsed: false,
            warnings: [],
          },
        }),
      },
    });
    expect(report(snapshot(f.context.db))).toMatchObject({ status: "PASS", findings: [] });
  });
  it("runs on a genuinely read-only handle and leaves every fixture record unchanged", () => {
    const f = setup();
    const before = snapshot(f.context.db);
    const readonly = new Database(f.context.path, { readonly: true, fileMustExist: true });
    try {
      expect(() => readonly.prepare("UPDATE sessions SET current_cash_lamports=0").run()).toThrow();
      const db = drizzle(readonly, { schema });
      const result = reconcilePaperSession(f.session.id, { readSnapshot: () => snapshot(db) });
      expect(result.status).toBe("PASS");
    } finally {
      readonly.close();
    }
    expect(snapshot(f.context.db)).toEqual(before);
  });
  it.each(["cash", "orphan", "duplicate", "owner", "terminal", "fees"])(
    "reports a %s contradiction",
    (kind) => {
      const f = setup();
      const original = snapshot(f.context.db);
      let changed = original;
      if (kind === "cash")
        changed = { ...original, session: { ...original.session!, currentCashLamports: 1 } };
      if (kind === "orphan")
        changed = {
          ...original,
          fills: original.fills.map((fill) => ({ ...fill, orderId: "missing" })),
        };
      if (kind === "duplicate")
        changed = { ...original, fills: [...original.fills, ...original.fills] };
      if (kind === "owner")
        changed = {
          ...original,
          fills: original.fills.map((fill) => ({ ...fill, sessionId: "foreign" })),
        };
      if (kind === "terminal")
        changed = {
          ...original,
          operations: original.operations.map((op) => ({ ...op, resultJson: null })),
        };
      if (kind === "fees")
        changed = {
          ...original,
          positions: original.positions.map((position) => ({
            ...position,
            feesPaidLamports: 5001,
          })),
        };
      expect(report(changed).status).toBe("DISCREPANCY");
    },
  );
  it("keeps seeded positions incomplete despite a matching cash equation", () => {
    fixture = h2Fixture();
    fixture.repositories.positions.openPosition({
      sessionId: fixture.session.id,
      mintAddress: fixture.radar.mintAddress,
      tokensHeld: "1",
      openedAtMs: 1000,
      costBasisLamports: 10,
    });
    const result = report(snapshot(fixture.context.db));
    expect(result.status).toBe("INCOMPLETE");
    expect(result.findings.some((row) => row.code === "MISSING_LINKED_OPENING_FILL")).toBe(true);
    expect(result.invariants.find((row) => row.check === "CASH")?.status).toBe("PASS");
  });
  it("does not invent legacy or partial-fill ownership and gives discrepancies precedence", () => {
    const f = setup();
    const original = snapshot(f.context.db);
    const legacy = {
      ...original,
      operations: [],
      orders: original.orders.map((order) => ({ ...order, operationId: null })),
      fills: original.fills.map((fill) => ({ ...fill, operationId: null })),
    };
    expect(report(legacy).status).toBe("INCOMPLETE");
    expect(
      report({ ...legacy, session: { ...legacy.session!, currentCashLamports: 1 } }).status,
    ).toBe("DISCREPANCY");
    expect(
      report({
        ...original,
        positions: original.positions.map((position) => ({ ...position, tokensHeld: "9" })),
      }).status,
    ).toBe("INCOMPLETE");
  });
  it("bounds findings without hiding discrepancy precedence", () => {
    const f = setup();
    const original = snapshot(f.context.db);
    const result = report({
      ...original,
      fills: Array.from({ length: 150 }, (_, i) => ({
        ...original.fills[0]!,
        id: `orphan-${i}`,
        orderId: "absent",
      })),
    });
    expect(result.status).toBe("DISCREPANCY");
    expect(result.findings).toHaveLength(100);
    expect(result.omittedFindingCount).toBeGreaterThan(0);
  });
});
