import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sessions } from "./sessions.js";
import { strategyDecisions } from "./strategyDecisions.js";
import { positions } from "./positions.js";
import { tokenRadar } from "./tokenRadar.js";
import { orders } from "./orders.js";
import { fills } from "./fills.js";
import { domainCheck, safeIntegerCheck } from "./integrity.js";
import type { SQLiteTableExtraConfigValue } from "drizzle-orm/sqlite-core";

export const paperOperations = sqliteTable(
  "paper_operations",
  {
    id: text("id").primaryKey(),
    version: integer("version").notNull(),
    mode: text("mode", { enum: ["PAPER"] })
      .notNull()
      .default("PAPER"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    side: text("side", { enum: ["BUY", "SELL"] }).notNull(),
    sourceId: text("source_id").notNull(),
    mintAddress: text("mint_address").notNull(),
    strategyDecisionId: text("strategy_decision_id"),
    inputPositionId: text("input_position_id"),
    radarId: text("radar_id"),
    intentDigest: text("intent_digest").notNull(),
    intentJson: text("intent_json").notNull(),
    state: text("state", { enum: ["PENDING", "COMMITTED", "REJECTED"] })
      .notNull()
      .default("PENDING"),
    orderId: text("order_id"),
    fillId: text("fill_id"),
    resultPositionId: text("result_position_id"),
    resultJson: text("result_json"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table): SQLiteTableExtraConfigValue[] => [
    check("h2_operations_mode", sql`${table.mode} = 'PAPER'`),
    foreignKey({
      name: "h2_operations_session_mode",
      columns: [table.sessionId, table.mode],
      foreignColumns: [sessions.id, sessions.mode],
    }),
    uniqueIndex("h2_operations_owner").on(table.id, table.sessionId),
    uniqueIndex("h2_operations_order").on(table.orderId),
    uniqueIndex("h2_operations_fill").on(table.fillId),
    foreignKey({
      name: "h2_operations_decision_owner",
      columns: [table.strategyDecisionId, table.sessionId],
      foreignColumns: [strategyDecisions.id, strategyDecisions.sessionId],
    }),
    foreignKey({
      name: "h2_operations_input_position_owner",
      columns: [table.inputPositionId, table.sessionId],
      foreignColumns: [positions.id, positions.sessionId],
    }),
    foreignKey({
      name: "h2_operations_radar_owner",
      columns: [table.radarId, table.sessionId],
      foreignColumns: [tokenRadar.id, tokenRadar.sessionId],
    }),
    foreignKey({
      name: "h2_operations_order_owner",
      columns: [table.orderId, table.sessionId],
      foreignColumns: [orders.id, orders.sessionId],
    }),
    foreignKey({
      name: "h2_operations_fill_owner",
      columns: [table.fillId, table.sessionId],
      foreignColumns: [fills.id, fills.sessionId],
    }),
    foreignKey({
      name: "h2_operations_result_position_owner",
      columns: [table.resultPositionId, table.sessionId],
      foreignColumns: [positions.id, positions.sessionId],
    }),
    domainCheck("h2_operations_side", table.side, ["BUY", "SELL"]),
    domainCheck("h2_operations_state", table.state, ["PENDING", "COMMITTED", "REJECTED"]),
    check("h2_operations_version", sql`${table.version} = 1`),
    check(
      "h2_operations_digest",
      sql`length(${table.intentDigest}) = 64 AND ${table.intentDigest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "h2_operations_intent_json",
      sql`json_valid(${table.intentJson}) AND json_type(${table.intentJson}) = 'object'`,
    ),
    check(
      "h2_operations_source",
      sql`(${table.side} = 'BUY' AND ${table.strategyDecisionId} IS NOT NULL AND ${table.sourceId} = ${table.strategyDecisionId} AND ${table.radarId} IS NOT NULL AND ${table.inputPositionId} IS NULL) OR (${table.side} = 'SELL' AND ${table.inputPositionId} IS NOT NULL AND ${table.sourceId} = ${table.inputPositionId} AND ${table.strategyDecisionId} IS NULL)`,
    ),
    check(
      "h2_operations_result",
      sql`(${table.state} = 'PENDING' AND ${table.orderId} IS NULL AND ${table.fillId} IS NULL AND ${table.resultPositionId} IS NULL AND ${table.resultJson} IS NULL) OR (${table.state} = 'REJECTED' AND ${table.orderId} IS NOT NULL AND ${table.fillId} IS NULL AND ${table.resultPositionId} IS NULL AND ${table.resultJson} IS NOT NULL AND json_valid(${table.resultJson}) AND json_type(${table.resultJson}) = 'object') OR (${table.state} = 'COMMITTED' AND ${table.orderId} IS NOT NULL AND ${table.fillId} IS NOT NULL AND ${table.resultPositionId} IS NOT NULL AND ${table.resultJson} IS NOT NULL AND json_valid(${table.resultJson}) AND json_type(${table.resultJson}) = 'object')`,
    ),
    safeIntegerCheck("h2_operations_created_at_ms", table.createdAtMs),
    safeIntegerCheck("h2_operations_updated_at_ms", table.updatedAtMs),
    check("h2_operations_time_order", sql`${table.updatedAtMs} >= ${table.createdAtMs}`),
  ],
);
export type PaperOperationRecord = typeof paperOperations.$inferSelect;
export type NewPaperOperationRecord = typeof paperOperations.$inferInsert;
