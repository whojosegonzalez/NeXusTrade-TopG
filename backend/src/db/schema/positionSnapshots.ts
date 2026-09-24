import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { positions } from "./positions.js";
import { sessions } from "./sessions.js";

export const positionSnapshots = sqliteTable(
  "position_snapshots",
  {
    id: text("id").primaryKey(),
    positionId: text("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    timestampMs: integer("timestamp_ms").notNull(),
    markPriceSol: text("mark_price_sol"),
    sellQuoteLamports: integer("sell_quote_lamports"),
    unrealizedPnlLamports: integer("unrealized_pnl_lamports"),
    unrealizedPnlBps: integer("unrealized_pnl_bps"),
    liquidityUsd: text("liquidity_usd"),
    rawQuoteJson: text("raw_quote_json"),
  },
  (table) => [
    index("idx_position_snapshots_position_id").on(table.positionId),
    index("idx_position_snapshots_session_id").on(table.sessionId),
    index("idx_position_snapshots_timestamp_ms").on(table.timestampMs),
  ],
);

export type PositionSnapshotRecord = typeof positionSnapshots.$inferSelect;
export type NewPositionSnapshotRecord = typeof positionSnapshots.$inferInsert;
