import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { riskResultValues } from "./enums.js";
import { sessions } from "./sessions.js";
import { tokenRadar } from "./tokenRadar.js";

export const riskAssessments = sqliteTable(
  "risk_assessments",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    tokenRadarId: text("token_radar_id").references(() => tokenRadar.id, { onDelete: "set null" }),
    mintAddress: text("mint_address").notNull(),
    checkedAtMs: integer("checked_at_ms").notNull(),
    score: integer("score"),
    result: text("result", { enum: riskResultValues }).notNull().default("UNKNOWN"),
    passed: integer("passed", { mode: "boolean" }).notNull().default(false),
    mintAuthorityDisabled: integer("mint_authority_disabled", { mode: "boolean" }),
    freezeAuthorityDisabled: integer("freeze_authority_disabled", { mode: "boolean" }),
    tokenProgram: text("token_program"),
    topHoldersPercent: text("top_holders_percent"),
    liquidityUsd: text("liquidity_usd"),
    riskFlagsJson: text("risk_flags_json").notNull(),
    rawProviderDataJson: text("raw_provider_data_json"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    index("idx_risk_assessments_session_id").on(table.sessionId),
    index("idx_risk_assessments_mint_address").on(table.mintAddress),
    index("idx_risk_assessments_result").on(table.result),
    index("idx_risk_assessments_checked_at_ms").on(table.checkedAtMs),
  ],
);

export type RiskAssessmentRecord = typeof riskAssessments.$inferSelect;
export type NewRiskAssessmentRecord = typeof riskAssessments.$inferInsert;
