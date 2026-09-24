import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { strategyDecisionValues, watchlistReturnStatusValues } from "./enums.js";
import { sessions } from "./sessions.js";
import { strategyDecisions } from "./strategyDecisions.js";
import { tokenRadar } from "./tokenRadar.js";

export const watchlistReturnObservations = sqliteTable(
  "watchlist_return_observations",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    strategyDecisionId: text("strategy_decision_id")
      .notNull()
      .references(() => strategyDecisions.id, { onDelete: "cascade" }),
    tokenRadarId: text("token_radar_id").references(() => tokenRadar.id, {
      onDelete: "set null",
    }),
    mintAddress: text("mint_address").notNull(),
    pairAddress: text("pair_address"),
    symbol: text("symbol"),
    decision: text("decision", { enum: strategyDecisionValues }).notNull(),
    strategyName: text("strategy_name").notNull(),
    strategyScore: integer("strategy_score"),
    horizonMinutes: integer("horizon_minutes").notNull(),
    baselineObservedAtMs: integer("baseline_observed_at_ms").notNull(),
    baselinePriceSol: text("baseline_price_sol"),
    baselinePriceUsd: text("baseline_price_usd"),
    baselineLiquidityUsd: text("baseline_liquidity_usd"),
    baselineVolume5mUsd: text("baseline_volume_5m_usd"),
    baselineVolume1hUsd: text("baseline_volume_1h_usd"),
    baselineSource: text("baseline_source").notNull(),
    dueAtMs: integer("due_at_ms").notNull(),
    observedAtMs: integer("observed_at_ms"),
    observedPriceSol: text("observed_price_sol"),
    observedPriceUsd: text("observed_price_usd"),
    observedLiquidityUsd: text("observed_liquidity_usd"),
    observedVolume5mUsd: text("observed_volume_5m_usd"),
    observedVolume1hUsd: text("observed_volume_1h_usd"),
    observedSource: text("observed_source"),
    returnPctSol: text("return_pct_sol"),
    returnPctUsd: text("return_pct_usd"),
    status: text("status", { enum: watchlistReturnStatusValues }).notNull().default("PENDING"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    rawDataJson: text("raw_data_json"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    index("idx_watchlist_returns_session_id").on(table.sessionId),
    index("idx_watchlist_returns_mint_address").on(table.mintAddress),
    index("idx_watchlist_returns_strategy_decision_id").on(table.strategyDecisionId),
    index("idx_watchlist_returns_status").on(table.status),
    index("idx_watchlist_returns_due_at_ms").on(table.dueAtMs),
    index("idx_watchlist_returns_horizon_minutes").on(table.horizonMinutes),
    uniqueIndex("uq_watchlist_returns_decision_horizon").on(
      table.strategyDecisionId,
      table.horizonMinutes,
    ),
  ],
);

export type WatchlistReturnObservationRecord = typeof watchlistReturnObservations.$inferSelect;
export type NewWatchlistReturnObservationRecord = typeof watchlistReturnObservations.$inferInsert;
