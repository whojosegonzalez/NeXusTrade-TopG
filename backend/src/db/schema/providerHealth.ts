import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { providerStatusValues } from "./enums.js";
import { sessions } from "./sessions.js";

export const providerHealth = sqliteTable(
  "provider_health",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    timestampMs: integer("timestamp_ms").notNull(),
    status: text("status", { enum: providerStatusValues }).notNull(),
    latencyMs: integer("latency_ms"),
    rateLimited: integer("rate_limited", { mode: "boolean" }).notNull().default(false),
    errorMessage: text("error_message"),
    creditsUsed: integer("credits_used"),
    contextJson: text("context_json"),
  },
  (table) => [
    index("idx_provider_health_session_id").on(table.sessionId),
    index("idx_provider_health_provider").on(table.provider),
    index("idx_provider_health_status").on(table.status),
    index("idx_provider_health_timestamp_ms").on(table.timestampMs),
  ],
);

export type ProviderHealthRecord = typeof providerHealth.$inferSelect;
export type NewProviderHealthRecord = typeof providerHealth.$inferInsert;
