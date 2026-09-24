import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { domainCheck, safeIntegerCheck } from "./integrity.js";

import { tokenRadarStatusValues } from "./enums.js";
import { sessions } from "./sessions.js";

export const tokenRadar = sqliteTable(
  "token_radar",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    mintAddress: text("mint_address").notNull(),
    symbol: text("symbol"),
    name: text("name"),
    pairAddress: text("pair_address"),
    source: text("source").notNull(),
    firstSeenAtMs: integer("first_seen_at_ms").notNull(),
    discoveredAtMs: integer("discovered_at_ms").notNull(),
    priceUsd: text("price_usd"),
    priceSol: text("price_sol"),
    liquidityUsd: text("liquidity_usd"),
    volume5mUsd: text("volume_5m_usd"),
    volume1hUsd: text("volume_1h_usd"),
    ageSeconds: integer("age_seconds"),
    status: text("status", { enum: tokenRadarStatusValues }).notNull().default("DISCOVERED"),
    notes: text("notes"),
    rawDataJson: text("raw_data_json"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("h2_radar_owner").on(table.id, table.sessionId),
    uniqueIndex("h2_radar_null_pair")
      .on(table.sessionId, table.mintAddress, table.source)
      .where(sql`${table.pairAddress} IS NULL`),
    domainCheck("h2_radar_status", table.status, tokenRadarStatusValues),
    check(
      "h2_radar_pair",
      sql`${table.pairAddress} IS NULL OR length(trim(${table.pairAddress})) > 0`,
    ),
    ...[
      table.firstSeenAtMs,
      table.discoveredAtMs,
      table.createdAtMs,
      table.updatedAtMs,
      table.ageSeconds,
    ].map((column) => safeIntegerCheck(`h2_radar_${column.name}`, column)),
    check("h2_radar_time_order", sql`${table.updatedAtMs} >= ${table.createdAtMs}`),
    index("idx_token_radar_session_id").on(table.sessionId),
    index("idx_token_radar_mint_address").on(table.mintAddress),
    index("idx_token_radar_status").on(table.status),
    index("idx_token_radar_first_seen_at_ms").on(table.firstSeenAtMs),
    uniqueIndex("uq_token_radar_session_mint_source_pair").on(
      table.sessionId,
      table.mintAddress,
      table.source,
      table.pairAddress,
    ),
  ],
);

export type TokenRadarRecord = typeof tokenRadar.$inferSelect;
export type NewTokenRadarRecord = typeof tokenRadar.$inferInsert;
