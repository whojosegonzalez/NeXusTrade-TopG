import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { domainCheck, safeIntegerCheck } from "./integrity.js";

import { positionStatusValues } from "./enums.js";
import { sessions } from "./sessions.js";

export const positions = sqliteTable(
  "positions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    mintAddress: text("mint_address").notNull(),
    status: text("status", { enum: positionStatusValues }).notNull().default("OPEN"),
    openedAtMs: integer("opened_at_ms").notNull(),
    closedAtMs: integer("closed_at_ms"),
    avgEntryPriceSol: text("avg_entry_price_sol"),
    avgExitPriceSol: text("avg_exit_price_sol"),
    tokensHeld: text("tokens_held").notNull(),
    costBasisLamports: integer("cost_basis_lamports").notNull().default(0),
    proceedsLamports: integer("proceeds_lamports").notNull().default(0),
    realizedPnlLamports: integer("realized_pnl_lamports").notNull().default(0),
    realizedPnlBps: integer("realized_pnl_bps"),
    feesPaidLamports: integer("fees_paid_lamports").notNull().default(0),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("h2_positions_owner").on(table.id, table.sessionId),
    uniqueIndex("h2_positions_active_mint")
      .on(table.sessionId, table.mintAddress)
      .where(sql`${table.status} IN ('OPEN', 'CLOSING')`),
    domainCheck("h2_positions_status", table.status, positionStatusValues),
    ...[
      table.openedAtMs,
      table.closedAtMs,
      table.createdAtMs,
      table.updatedAtMs,
      table.costBasisLamports,
      table.proceedsLamports,
      table.feesPaidLamports,
    ].map((column) => safeIntegerCheck(`h2_positions_${column.name}`, column)),
    ...[table.realizedPnlLamports, table.realizedPnlBps].map((column) =>
      safeIntegerCheck(`h2_positions_${column.name}`, column, true),
    ),
    check(
      "h2_positions_time_order",
      sql`${table.updatedAtMs} >= ${table.createdAtMs} AND (${table.closedAtMs} IS NULL OR ${table.closedAtMs} >= ${table.openedAtMs})`,
    ),
    index("idx_positions_session_id").on(table.sessionId),
    index("idx_positions_mint_address").on(table.mintAddress),
    index("idx_positions_status").on(table.status),
    index("idx_positions_opened_at_ms").on(table.openedAtMs),
  ],
);

export type PositionRecord = typeof positions.$inferSelect;
export type NewPositionRecord = typeof positions.$inferInsert;
