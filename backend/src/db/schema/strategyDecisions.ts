import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { domainCheck, safeIntegerCheck } from "./integrity.js";

import { strategyDecisionValues } from "./enums.js";
import { sessions } from "./sessions.js";

export const strategyDecisions = sqliteTable(
  "strategy_decisions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    mintAddress: text("mint_address").notNull(),
    decidedAtMs: integer("decided_at_ms").notNull(),
    decision: text("decision", { enum: strategyDecisionValues }).notNull(),
    strategyName: text("strategy_name").notNull(),
    score: integer("score"),
    reason: text("reason").notNull(),
    inputSnapshotJson: text("input_snapshot_json"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("h2_decisions_owner").on(table.id, table.sessionId),
    domainCheck("h2_decisions_decision", table.decision, strategyDecisionValues),
    safeIntegerCheck("h2_decisions_created_at_ms", table.createdAtMs),
    safeIntegerCheck("h2_decisions_decided_at_ms", table.decidedAtMs),
    index("idx_strategy_decisions_session_id").on(table.sessionId),
    index("idx_strategy_decisions_mint_address").on(table.mintAddress),
    index("idx_strategy_decisions_decision").on(table.decision),
    index("idx_strategy_decisions_decided_at_ms").on(table.decidedAtMs),
  ],
);

export type StrategyDecisionRecord = typeof strategyDecisions.$inferSelect;
export type NewStrategyDecisionRecord = typeof strategyDecisions.$inferInsert;
