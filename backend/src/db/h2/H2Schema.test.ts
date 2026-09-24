import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseContext } from "../connection.js";
import { migrationContract } from "../MigrationContract.js";
import { getMigrationsFolder, runMigrations, assertMigrationsApplied } from "../migrations.js";
import { H2MigrationPreflightError } from "../H2MigrationPreflight.js";
import { paperOperations } from "../schema/paperOperations.js";
import { identifyPaperBuy } from "../../paper/PaperOperationIdentity.js";
import { defaultPaperExchangeConfig } from "../../paper/PaperExchangeConfig.js";
import { h2Fixture } from "./H2Fixtures.js";

let fixture: ReturnType<typeof h2Fixture> | undefined;
let legacy: DatabaseContext | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  fixture?.cleanup();
  fixture = undefined;
  legacy?.close();
  legacy = undefined;
});
function operation() {
  fixture = h2Fixture();
  const identity = identifyPaperBuy(
    { tokenRadar: fixture.radar, strategyDecision: fixture.decision },
    defaultPaperExchangeConfig(),
  );
  fixture.context.db
    .insert(paperOperations)
    .values({
      id: identity.id,
      version: 1,
      sessionId: identity.sessionId,
      side: "BUY",
      sourceId: identity.sourceId,
      mintAddress: identity.mint,
      strategyDecisionId: fixture.decision.id,
      radarId: fixture.radar.id,
      intentDigest: identity.intentDigest,
      intentJson: identity.intentJson,
      createdAtMs: 1000,
      updatedAtMs: 1000,
    })
    .run();
  return { fixture, identity };
}
function prior() {
  legacy = openDatabase(":memory:", "PAPER");
  legacy.sqlite.exec(
    "CREATE TABLE __drizzle_migrations(id SERIAL PRIMARY KEY,hash text NOT NULL,created_at numeric)",
  );
  for (const entry of migrationContract.slice(0, 2)) {
    legacy.sqlite.exec(readFileSync(path.join(getMigrationsFolder(), entry.file), "utf8"));
    legacy.sqlite
      .prepare("INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)")
      .run(entry.sha256, entry.when);
  }
  legacy.sqlite.exec(`
    INSERT INTO sessions(id,mode,status,started_at_ms,starting_balance_lamports,current_cash_lamports,config_snapshot_json,created_at_ms,updated_at_ms) VALUES('old','PAPER','RUNNING',1000,1000,1000,'{}',1000,1000);
    INSERT INTO token_radar(id,session_id,mint_address,source,first_seen_at_ms,discovered_at_ms,created_at_ms,updated_at_ms) VALUES('radar','old','mint','FAKE',1000,1000,1000,1000);
    INSERT INTO strategy_decisions(id,session_id,mint_address,decided_at_ms,decision,strategy_name,reason,created_at_ms) VALUES('decision','old','mint',1000,'BUY','fake','fixture',1000);
    INSERT INTO orders(id,session_id,mode,side,mint_address,status,created_at_ms,updated_at_ms,strategy_decision_id) VALUES('order','old','PAPER','BUY','mint','FILLED',1000,1000,'decision');
    INSERT INTO fills(id,order_id,session_id,filled_at_ms,sol_spent_lamports,created_at_ms) VALUES('fill','order','old',1000,10,1000);
    INSERT INTO positions(id,session_id,mint_address,status,opened_at_ms,closed_at_ms,tokens_held,cost_basis_lamports,realized_pnl_lamports,created_at_ms,updated_at_ms) VALUES('position','old','mint','CLOSED',1000,2000,'0',10,-1,1000,2000);
  `);
  return legacy;
}
const tables = [
  "sessions",
  "token_radar",
  "strategy_decisions",
  "orders",
  "fills",
  "positions",
  "__drizzle_migrations",
];
function snapshot(context: DatabaseContext) {
  return tables.map((table) => [
    table,
    context.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]);
}

describe("H2 schema constraints", () => {
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity])(
    "rejects invalid cash %s through SQLite",
    (value) => {
      fixture = h2Fixture();
      expect(() =>
        fixture!.context.sqlite.prepare("UPDATE sessions SET current_cash_lamports=?").run(value),
      ).toThrow();
    },
  );
  it.each([
    ["sessions", "mode", "UNKNOWN"],
    ["sessions", "status", "UNKNOWN"],
    ["sessions", "termination_reason", "UNKNOWN"],
    ["token_radar", "status", "UNKNOWN"],
    ["strategy_decisions", "decision", "UNKNOWN"],
    ["sessions", "started_at_ms", -1],
    ["sessions", "updated_at_ms", 0],
    ["token_radar", "pair_address", " "],
  ])("rejects invalid %s.%s", (table, column, value) => {
    fixture = h2Fixture();
    expect(() =>
      fixture!.context.sqlite.prepare(`UPDATE ${table} SET ${column}=?`).run(value),
    ).toThrow();
  });
  it("allows signed losses and multiple closed histories but blocks OPEN/CLOSING duplicates", () => {
    fixture = h2Fixture();
    fixture.context.sqlite.exec(
      "UPDATE sessions SET realized_pnl_lamports=-500,unrealized_pnl_lamports=-200",
    );
    const input = {
      sessionId: fixture.session.id,
      mintAddress: fixture.radar.mintAddress,
      openedAtMs: 1000,
      tokensHeld: "1",
    };
    fixture.repositories.positions.openPosition({
      ...input,
      status: "CLOSED",
      closedAtMs: 2000,
      realizedPnlLamports: -1,
    });
    fixture.repositories.positions.openPosition({ ...input, status: "CLOSED", closedAtMs: 2000 });
    fixture.repositories.positions.openPosition({ ...input, status: "OPEN" });
    expect(() =>
      fixture!.repositories.positions.openPosition({ ...input, status: "CLOSING" }),
    ).toThrow();
    expect(fixture.repositories.positions.listClosedPositions(fixture.session.id)).toHaveLength(2);
  });
  it("keeps distinct radar pairs and sources while rejecting duplicate null identity", () => {
    fixture = h2Fixture();
    fixture.repositories.tokenRadar.createRadarEntry({
      ...fixture.radarInput,
      pairAddress: "pair1",
    });
    fixture.repositories.tokenRadar.createRadarEntry({
      ...fixture.radarInput,
      pairAddress: "pair2",
    });
    fixture.repositories.tokenRadar.createRadarEntry({ ...fixture.radarInput, source: "OTHER" });
    expect(() =>
      fixture!.repositories.tokenRadar.createRadarEntry({
        ...fixture!.radarInput,
        pairAddress: null,
      }),
    ).toThrow();
  });
  it("enforces order/fill session ownership and one order/fill per new operation", () => {
    const { fixture: f, identity } = operation();
    const orderInput = {
      sessionId: f.session.id,
      mode: "PAPER" as const,
      side: "BUY" as const,
      mintAddress: f.radar.mintAddress,
      operationId: identity.id,
    };
    const order = f.repositories.orders.createOrder(orderInput);
    expect(() => f.repositories.orders.createOrder(orderInput)).toThrow();
    f.repositories.sessions.createSession({
      id: "other",
      mode: "PAPER",
      startedAtMs: 1000,
      startingBalanceLamports: 1,
      currentCashLamports: 1,
      configSnapshotJson: "{}",
    });
    expect(() =>
      f.repositories.fills.createFill({ orderId: order.id, sessionId: "other", filledAtMs: 1000 }),
    ).toThrow();
    const fillInput = {
      orderId: order.id,
      sessionId: f.session.id,
      filledAtMs: 1000,
      operationId: identity.id,
    };
    f.repositories.fills.createFill(fillInput);
    expect(() => f.repositories.fills.createFill(fillInput)).toThrow();
    expect(() => f.context.sqlite.exec("UPDATE orders SET mode='LIVE'")).toThrow();
    expect(() => f.context.sqlite.exec("UPDATE orders SET side='UNKNOWN'")).toThrow();
    expect(() =>
      f.context.sqlite.exec("UPDATE fills SET estimated_base_fee_lamports=-1"),
    ).toThrow();
  });
  it("keeps durable intent immutable and requires complete terminal evidence", () => {
    const { fixture: f, identity } = operation();
    expect(() => f.context.sqlite.exec("UPDATE paper_operations SET intent_json='{}'")).toThrow(
      "IMMUTABLE",
    );
    expect(() => f.context.sqlite.exec("DELETE FROM paper_operations")).toThrow("IMMUTABLE");
    expect(() => f.context.sqlite.exec("UPDATE paper_operations SET state='COMMITTED'")).toThrow();
    const order = f.repositories.orders.createOrder({
      sessionId: f.session.id,
      mode: "PAPER",
      side: "BUY",
      mintAddress: f.radar.mintAddress,
      operationId: identity.id,
      status: "REJECTED",
    });
    f.context.sqlite
      .prepare(
        "UPDATE paper_operations SET state='REJECTED',order_id=?,result_json='{}' WHERE id=?",
      )
      .run(order.id, identity.id);
    expect(() => f.context.sqlite.exec("UPDATE paper_operations SET updated_at_ms=2000")).toThrow(
      "IMMUTABLE",
    );
  });
});

describe("H2 historical migration preservation and preflight", () => {
  it("restores populated legacy tables and journal after a mid-rebuild interruption", () => {
    const db = prior();
    const before = snapshot(db);
    const execute = db.sqlite.exec.bind(db.sqlite);
    vi.spyOn(db.sqlite, "exec").mockImplementation((source) => {
      const marker = "DROP TABLE `orders`;";
      const offset = source.indexOf(marker);
      if (offset >= 0) {
        execute(source.slice(0, offset + marker.length));
        throw new Error("injected H2 rebuild interruption");
      }
      return execute(source);
    });
    expect(() => runMigrations(db)).toThrow("injected H2 rebuild interruption");
    expect(snapshot(db)).toEqual(before);
    expect(
      db.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE '__new_%' OR name='paper_operations'",
        )
        .all(),
    ).toEqual([]);
    expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });
  it("preserves every legacy column and initializes new operation links to NULL", () => {
    const db = prior();
    const before = snapshot(db).slice(0, -1);
    const columns = new Map(
      tables
        .slice(0, -1)
        .map((table) => [
          table,
          Object.keys(db.sqlite.prepare(`SELECT * FROM ${table} LIMIT 1`).get() as object),
        ]),
    );
    runMigrations(db);
    for (const [table, rows] of before)
      expect(
        db.sqlite
          .prepare(
            `SELECT ${columns
              .get(String(table))!
              .map((column) => `"${column}"`)
              .join(",")} FROM ${table} ORDER BY rowid`,
          )
          .all(),
      ).toEqual(rows);
    expect(db.sqlite.prepare("SELECT operation_id FROM orders").get()).toEqual({
      operation_id: null,
    });
    expect(db.sqlite.prepare("SELECT operation_id FROM fills").get()).toEqual({
      operation_id: null,
    });
    expect(() => assertMigrationsApplied(db)).not.toThrow();
    expect(db.sqlite.pragma("foreign_key_check")).toEqual([]);
  });
  it.each([
    "negative-cash",
    "invalid-status",
    "invalid-time",
    "duplicate-null-radar",
    "duplicate-exposure",
    "cross-owner",
  ])("reports %s before migration and preserves original rows/journal", (failure) => {
    const db = prior();
    if (failure === "negative-cash") db.sqlite.exec("UPDATE sessions SET current_cash_lamports=-1");
    if (failure === "invalid-status") db.sqlite.exec("UPDATE sessions SET status='UNKNOWN'");
    if (failure === "invalid-time") db.sqlite.exec("UPDATE positions SET closed_at_ms=0");
    if (failure === "duplicate-null-radar")
      db.sqlite.exec(
        "INSERT INTO token_radar SELECT 'duplicate',session_id,mint_address,symbol,name,pair_address,source,first_seen_at_ms,discovered_at_ms,price_usd,price_sol,liquidity_usd,volume_5m_usd,volume_1h_usd,age_seconds,status,notes,raw_data_json,created_at_ms,updated_at_ms FROM token_radar",
      );
    if (failure === "duplicate-exposure")
      db.sqlite.exec(
        "UPDATE positions SET status='OPEN'; INSERT INTO positions SELECT 'duplicate',session_id,mint_address,status,opened_at_ms,closed_at_ms,avg_entry_price_sol,avg_exit_price_sol,tokens_held,cost_basis_lamports,proceeds_lamports,realized_pnl_lamports,realized_pnl_bps,fees_paid_lamports,created_at_ms,updated_at_ms FROM positions",
      );
    if (failure === "cross-owner")
      db.sqlite.exec(
        "INSERT INTO sessions SELECT 'other',mode,status,started_at_ms,ended_at_ms,starting_balance_lamports,current_cash_lamports,target_profit_lamports,target_profit_bps,max_drawdown_lamports,realized_pnl_lamports,unrealized_pnl_lamports,termination_reason,config_snapshot_json,created_at_ms,updated_at_ms FROM sessions; UPDATE fills SET session_id='other'",
      );
    const before = snapshot(db);
    expect(() => runMigrations(db)).toThrow(H2MigrationPreflightError);
    expect(snapshot(db)).toEqual(before);
    expect(
      db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='paper_operations'").get(),
    ).toBeUndefined();
    expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});
