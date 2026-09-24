import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { domainCheck, safeIntegerCheck } from "./integrity.js";
import { paperOperations } from "./paperOperations.js";
import type { SQLiteTableExtraConfigValue } from "drizzle-orm/sqlite-core";

import { executionModeValues, orderSideValues, orderStatusValues } from "./enums.js";
import { sessions } from "./sessions.js";
import { strategyDecisions } from "./strategyDecisions.js";

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    mode: text("mode", { enum: executionModeValues }).notNull(),
    side: text("side", { enum: orderSideValues }).notNull(),
    mintAddress: text("mint_address").notNull(),
    status: text("status", { enum: orderStatusValues }).notNull().default("CREATED"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    requestedSolLamports: integer("requested_sol_lamports"),
    requestedTokenAmount: text("requested_token_amount"),
    quoteSource: text("quote_source"),
    quoteId: text("quote_id"),
    strategyDecisionId: text("strategy_decision_id").references(() => strategyDecisions.id, {
      onDelete: "set null",
    }),
    reason: text("reason"),
    rawOrderJson: text("raw_order_json"),
    operationId: text("operation_id").references((): AnySQLiteColumn => paperOperations.id),
  },
  (table): SQLiteTableExtraConfigValue[] => [
    foreignKey({
      name: "h2_orders_session_mode",
      columns: [table.sessionId, table.mode],
      foreignColumns: [sessions.id, sessions.mode],
    }),
    uniqueIndex("h2_orders_owner").on(table.id, table.sessionId),
    uniqueIndex("h2_orders_operation").on(table.operationId),
    foreignKey({
      name: "h2_orders_decision_owner",
      columns: [table.strategyDecisionId, table.sessionId],
      foreignColumns: [strategyDecisions.id, strategyDecisions.sessionId],
    }),
    foreignKey({
      name: "h2_orders_operation_owner",
      columns: [table.operationId, table.sessionId],
      foreignColumns: [paperOperations.id, paperOperations.sessionId],
    }),
    domainCheck("h2_orders_mode", table.mode, executionModeValues),
    domainCheck("h2_orders_side", table.side, orderSideValues),
    domainCheck("h2_orders_status", table.status, orderStatusValues),
    ...[table.createdAtMs, table.updatedAtMs, table.requestedSolLamports].map((column) =>
      safeIntegerCheck(`h2_orders_${column.name}`, column),
    ),
    check("h2_orders_time_order", sql`${table.updatedAtMs} >= ${table.createdAtMs}`),
    check("h2_orders_operation_mode", sql`${table.operationId} IS NULL OR ${table.mode} = 'PAPER'`),
    index("idx_orders_session_id").on(table.sessionId),
    index("idx_orders_mint_address").on(table.mintAddress),
    index("idx_orders_status").on(table.status),
    index("idx_orders_side").on(table.side),
    index("idx_orders_created_at_ms").on(table.createdAtMs),
  ],
);

export type OrderRecord = typeof orders.$inferSelect;
export type NewOrderRecord = typeof orders.$inferInsert;
