import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { sessions } from "./sessions.js";

export const equitySnapshots = sqliteTable(
  "equity_snapshots",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    timestampMs: integer("timestamp_ms").notNull(),
    cashLamports: integer("cash_lamports").notNull(),
    openPositionValueLamports: integer("open_position_value_lamports").notNull(),
    totalEquityLamports: integer("total_equity_lamports").notNull(),
    realizedPnlLamports: integer("realized_pnl_lamports").notNull(),
    unrealizedPnlLamports: integer("unrealized_pnl_lamports").notNull(),
    drawdownLamports: integer("drawdown_lamports"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    index("idx_equity_snapshots_session_id").on(table.sessionId),
    index("idx_equity_snapshots_timestamp_ms").on(table.timestampMs),
  ],
);

export type EquitySnapshotRecord = typeof equitySnapshots.$inferSelect;
export type NewEquitySnapshotRecord = typeof equitySnapshots.$inferInsert;
