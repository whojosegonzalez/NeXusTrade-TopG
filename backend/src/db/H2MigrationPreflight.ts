import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { SqliteDatabase } from "./connection.js";
import {
  sessions,
  orders,
  fills,
  positions,
  tokenRadar,
  strategyDecisions,
} from "./schema/index.js";

export interface H2PreflightFinding {
  readonly table: string;
  readonly id: string;
  readonly code: string;
}
export class H2MigrationPreflightError extends Error {
  constructor(readonly findings: readonly H2PreflightFinding[]) {
    super("DATABASE_H2_PREFLIGHT_FAILED");
  }
}
/** Validate prior rows without modifying them; bounded findings do not authorize data repair. */
export function preflightH2Migration(sqlite: SqliteDatabase): void {
  const findings: H2PreflightFinding[] = [];
  const dialect = new SQLiteSyncDialect();
  const ids = z.array(z.object({ id: z.string() }));
  const collect = (table: string, code: string, query: string) => {
    if (findings.length >= 100) return;
    for (const row of ids.parse(sqlite.prepare(`${query} LIMIT ${100 - findings.length}`).all()))
      findings.push({ table, id: row.id.slice(0, 256), code });
  };
  for (const table of [sessions, orders, fills, positions, tokenRadar, strategyDecisions]) {
    const config = getTableConfig(table);
    for (const constraint of config.checks) {
      // Prior orders have no operation_id; their new nullable link is explicitly initialized to NULL.
      if (constraint.name === "h2_orders_operation_mode") continue;
      const expression = dialect.sqlToQuery(constraint.value).sql;
      collect(
        config.name,
        constraint.name,
        `SELECT id FROM "${config.name}" WHERE (${expression}) IS FALSE ORDER BY id`,
      );
    }
  }
  collect(
    "positions",
    "DUPLICATE_ACTIVE_EXPOSURE",
    `SELECT id FROM positions WHERE status IN ('OPEN','CLOSING') AND (session_id,mint_address) IN (SELECT session_id,mint_address FROM positions WHERE status IN ('OPEN','CLOSING') GROUP BY session_id,mint_address HAVING count(*)>1) ORDER BY id`,
  );
  collect(
    "token_radar",
    "DUPLICATE_NULL_PAIR",
    `SELECT id FROM token_radar WHERE pair_address IS NULL AND (session_id,mint_address,source) IN (SELECT session_id,mint_address,source FROM token_radar WHERE pair_address IS NULL GROUP BY session_id,mint_address,source HAVING count(*)>1) ORDER BY id`,
  );
  collect(
    "orders",
    "SESSION_MODE_MISMATCH",
    `SELECT o.id FROM orders o LEFT JOIN sessions s ON s.id=o.session_id WHERE s.id IS NULL OR s.mode!=o.mode ORDER BY o.id`,
  );
  collect(
    "orders",
    "DECISION_OWNER_MISMATCH",
    `SELECT o.id FROM orders o LEFT JOIN strategy_decisions d ON d.id=o.strategy_decision_id WHERE o.strategy_decision_id IS NOT NULL AND (d.id IS NULL OR d.session_id!=o.session_id) ORDER BY o.id`,
  );
  collect(
    "fills",
    "ORDER_OWNER_MISMATCH",
    `SELECT f.id FROM fills f LEFT JOIN orders o ON o.id=f.order_id WHERE o.id IS NULL OR o.session_id!=f.session_id ORDER BY f.id`,
  );
  const fk = sqlite.pragma("foreign_key_check");
  if (!Array.isArray(fk)) throw new Error("DATABASE_H2_PREFLIGHT_INVALID_RESULT");
  if (fk.length && findings.length < 100)
    findings.push({ table: "schema", id: "foreign-key-check", code: "BROKEN_FOREIGN_KEY" });
  if (findings.length) throw new H2MigrationPreflightError(findings);
}
