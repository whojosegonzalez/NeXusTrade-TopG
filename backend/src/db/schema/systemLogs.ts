import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { systemLogLevelValues, systemLogScopeValues } from "./enums.js";
import { sessions } from "./sessions.js";

export const systemLogs = sqliteTable(
  "system_logs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    timestampMs: integer("timestamp_ms").notNull(),
    level: text("level", { enum: systemLogLevelValues }).notNull(),
    scope: text("scope", { enum: systemLogScopeValues }).notNull(),
    message: text("message").notNull(),
    contextJson: text("context_json"),
  },
  (table) => [
    index("idx_system_logs_session_id").on(table.sessionId),
    index("idx_system_logs_timestamp_ms").on(table.timestampMs),
    index("idx_system_logs_level").on(table.level),
    index("idx_system_logs_scope").on(table.scope),
  ],
);

export type SystemLogRecord = typeof systemLogs.$inferSelect;
export type NewSystemLogRecord = typeof systemLogs.$inferInsert;
