import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";

import type { AppDatabase } from "../connection.js";
import {
  providerHealth,
  type NewProviderHealthRecord,
  type ProviderHealthRecord,
  type ProviderStatus,
} from "../schema/index.js";
import { createId } from "../utils/ids.js";
import { nowMs } from "../utils/timestamps.js";
import { limitOrDefault, requireRecord, type TimeRangeFilter } from "./helpers.js";

export type CreateProviderHealthInput = Omit<NewProviderHealthRecord, "id" | "timestampMs"> &
  Partial<Pick<NewProviderHealthRecord, "id" | "timestampMs">>;

export interface ProviderHealthFilter extends TimeRangeFilter {
  readonly provider?: string;
  readonly status?: ProviderStatus;
  readonly sessionId?: string;
}

export class ProviderHealthRepository {
  constructor(private readonly db: AppDatabase) {}

  createProviderHealth(input: CreateProviderHealthInput): ProviderHealthRecord {
    const record = {
      ...input,
      id: input.id ?? createId("provider"),
      timestampMs: input.timestampMs ?? nowMs(),
    } satisfies NewProviderHealthRecord;

    return requireRecord(
      this.db.insert(providerHealth).values(record).returning().get(),
      "Failed to create provider health record.",
    );
  }

  listProviderHealth(filter: ProviderHealthFilter = {}): ProviderHealthRecord[] {
    const conditions: SQL[] = [];

    if (filter.provider) {
      conditions.push(eq(providerHealth.provider, filter.provider));
    }

    if (filter.status) {
      conditions.push(eq(providerHealth.status, filter.status));
    }

    if (filter.sessionId) {
      conditions.push(eq(providerHealth.sessionId, filter.sessionId));
    }

    if (filter.fromMs !== undefined) {
      conditions.push(gte(providerHealth.timestampMs, filter.fromMs));
    }

    if (filter.toMs !== undefined) {
      conditions.push(lte(providerHealth.timestampMs, filter.toMs));
    }

    return this.db
      .select()
      .from(providerHealth)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(providerHealth.timestampMs))
      .limit(limitOrDefault(filter.limit))
      .all();
  }

  getLatestProviderStatus(provider: string): ProviderHealthRecord | undefined {
    return this.db
      .select()
      .from(providerHealth)
      .where(eq(providerHealth.provider, provider))
      .orderBy(desc(providerHealth.timestampMs))
      .limit(1)
      .get();
  }

  listProviderErrors(provider: string, range: TimeRangeFilter = {}): ProviderHealthRecord[] {
    return this.listProviderHealth({
      ...range,
      provider,
      status: "ERROR",
    });
  }
}
