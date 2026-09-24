import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { domainCheck, safeIntegerCheck } from "./integrity.js";

import { executionModeValues, sessionStatusValues, terminationReasonValues } from "./enums.js";

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    mode: text("mode", { enum: executionModeValues }).notNull(),
    status: text("status", { enum: sessionStatusValues }).notNull().default("CREATED"),
    startedAtMs: integer("started_at_ms").notNull(),
    endedAtMs: integer("ended_at_ms"),
    startingBalanceLamports: integer("starting_balance_lamports").notNull(),
    currentCashLamports: integer("current_cash_lamports").notNull(),
    targetProfitLamports: integer("target_profit_lamports"),
    targetProfitBps: integer("target_profit_bps"),
    maxDrawdownLamports: integer("max_drawdown_lamports"),
    realizedPnlLamports: integer("realized_pnl_lamports").notNull().default(0),
    unrealizedPnlLamports: integer("unrealized_pnl_lamports").notNull().default(0),
    terminationReason: text("termination_reason", { enum: terminationReasonValues })
      .notNull()
      .default("NOT_TERMINATED"),
    configSnapshotJson: text("config_snapshot_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("h2_sessions_owner_mode").on(table.id, table.mode),
    domainCheck("h2_sessions_mode", table.mode, executionModeValues),
    domainCheck("h2_sessions_status", table.status, sessionStatusValues),
    domainCheck("h2_sessions_termination", table.terminationReason, terminationReasonValues),
    ...[
      table.startedAtMs,
      table.endedAtMs,
      table.createdAtMs,
      table.updatedAtMs,
      table.startingBalanceLamports,
      table.currentCashLamports,
      table.targetProfitLamports,
      table.targetProfitBps,
      table.maxDrawdownLamports,
    ].map((column) => safeIntegerCheck(`h2_sessions_${column.name}`, column)),
    ...[table.realizedPnlLamports, table.unrealizedPnlLamports].map((column) =>
      safeIntegerCheck(`h2_sessions_${column.name}`, column, true),
    ),
    check(
      "h2_sessions_time_order",
      sql`${table.updatedAtMs} >= ${table.createdAtMs} AND (${table.endedAtMs} IS NULL OR ${table.endedAtMs} >= ${table.startedAtMs})`,
    ),
    index("idx_sessions_mode").on(table.mode),
    index("idx_sessions_status").on(table.status),
    index("idx_sessions_started_at_ms").on(table.startedAtMs),
  ],
);

export type SessionRecord = typeof sessions.$inferSelect;
export type NewSessionRecord = typeof sessions.$inferInsert;
