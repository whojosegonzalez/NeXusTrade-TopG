import {
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { safeIntegerCheck } from "./integrity.js";
import { paperOperations } from "./paperOperations.js";
import type { SQLiteTableExtraConfigValue } from "drizzle-orm/sqlite-core";

import { orders } from "./orders.js";
import { sessions } from "./sessions.js";

export const fills = sqliteTable(
  "fills",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references((): AnySQLiteColumn => orders.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    filledAtMs: integer("filled_at_ms").notNull(),
    fillPriceSol: text("fill_price_sol"),
    fillPriceUsd: text("fill_price_usd"),
    tokensFilled: text("tokens_filled"),
    solSpentLamports: integer("sol_spent_lamports"),
    solReceivedLamports: integer("sol_received_lamports"),
    estimatedBaseFeeLamports: integer("estimated_base_fee_lamports").notNull().default(0),
    estimatedPriorityFeeLamports: integer("estimated_priority_fee_lamports").notNull().default(0),
    estimatedSlippageLamports: integer("estimated_slippage_lamports").notNull().default(0),
    priceImpactBps: integer("price_impact_bps"),
    quoteSource: text("quote_source"),
    rawQuoteJson: text("raw_quote_json"),
    createdAtMs: integer("created_at_ms").notNull(),
    operationId: text("operation_id").references((): AnySQLiteColumn => paperOperations.id),
  },
  (table): SQLiteTableExtraConfigValue[] => [
    uniqueIndex("h2_fills_owner").on(table.id, table.sessionId),
    uniqueIndex("h2_fills_operation").on(table.operationId),
    foreignKey({
      name: "h2_fills_order_owner",
      columns: [table.orderId, table.sessionId],
      foreignColumns: [orders.id, orders.sessionId],
    }),
    foreignKey({
      name: "h2_fills_operation_owner",
      columns: [table.operationId, table.sessionId],
      foreignColumns: [paperOperations.id, paperOperations.sessionId],
    }),
    ...[
      table.filledAtMs,
      table.createdAtMs,
      table.solSpentLamports,
      table.solReceivedLamports,
      table.estimatedBaseFeeLamports,
      table.estimatedPriorityFeeLamports,
      table.estimatedSlippageLamports,
    ].map((column) => safeIntegerCheck(`h2_fills_${column.name}`, column)),
    safeIntegerCheck("h2_fills_price_impact_bps", table.priceImpactBps, true),
    index("idx_fills_order_id").on(table.orderId),
    index("idx_fills_session_id").on(table.sessionId),
    index("idx_fills_filled_at_ms").on(table.filledAtMs),
  ],
);

export type FillRecord = typeof fills.$inferSelect;
export type NewFillRecord = typeof fills.$inferInsert;
