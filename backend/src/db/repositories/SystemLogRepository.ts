import { and, desc, eq, gte, lte, lt, type SQL } from "drizzle-orm";

import type { AppDatabase } from "../connection.js";
import {
  systemLogs,
  type NewSystemLogRecord,
  type SystemLogLevel,
  type SystemLogRecord,
  type SystemLogScope,
} from "../schema/index.js";
import { createId } from "../utils/ids.js";
import { nowMs } from "../utils/timestamps.js";
import { limitOrDefault, requireRecord, type TimeRangeFilter } from "./helpers.js";

export type CreateSystemLogInput = Omit<NewSystemLogRecord, "id" | "timestampMs"> &
  Partial<Pick<NewSystemLogRecord, "id" | "timestampMs">>;

export interface SystemLogFilter extends TimeRangeFilter {
  readonly sessionId?: string;
  readonly level?: SystemLogLevel;
  readonly scope?: SystemLogScope;
}

export class SystemLogRepository {
  constructor(private readonly db: AppDatabase) {}

  createLog(input: CreateSystemLogInput): SystemLogRecord {
    const record = {
      ...input,
      id: input.id ?? createId("log"),
      timestampMs: input.timestampMs ?? nowMs(),
    } satisfies NewSystemLogRecord;

    return requireRecord(
      this.db.insert(systemLogs).values(record).returning().get(),
      "Failed to create system log.",
    );
  }

  listLogs(filter: SystemLogFilter = {}): SystemLogRecord[] {
    const conditions: SQL[] = [];

    if (filter.sessionId) {
      conditions.push(eq(systemLogs.sessionId, filter.sessionId));
    }

    if (filter.level) {
      conditions.push(eq(systemLogs.level, filter.level));
    }

    if (filter.scope) {
      conditions.push(eq(systemLogs.scope, filter.scope));
    }

    if (filter.fromMs !== undefined) {
      conditions.push(gte(systemLogs.timestampMs, filter.fromMs));
    }

    if (filter.toMs !== undefined) {
      conditions.push(lte(systemLogs.timestampMs, filter.toMs));
    }

    return this.db
      .select()
      .from(systemLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(systemLogs.timestampMs))
      .limit(limitOrDefault(filter.limit))
      .all();
  }

  listRecentLogs(limit = 100): SystemLogRecord[] {
    return this.listLogs({ limit });
  }

  listSessionLogs(sessionId: string, limit = 100): SystemLogRecord[] {
    return this.listLogs({ sessionId, limit });
  }

  deleteOldLogs(olderThanMs: number): number {
    return this.db.delete(systemLogs).where(lt(systemLogs.timestampMs, olderThanMs)).run().changes;
  }
}
