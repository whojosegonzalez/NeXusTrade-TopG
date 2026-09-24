import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";

import type { AppDatabase } from "../connection.js";
import {
  equitySnapshots,
  positionSnapshots,
  type EquitySnapshotRecord,
  type NewEquitySnapshotRecord,
  type NewPositionSnapshotRecord,
  type PositionSnapshotRecord,
} from "../schema/index.js";
import { createId } from "../utils/ids.js";
import { nowMs } from "../utils/timestamps.js";
import { limitOrDefault, requireRecord, type TimeRangeFilter } from "./helpers.js";

export type CreatePositionSnapshotInput = Omit<NewPositionSnapshotRecord, "id"> &
  Partial<Pick<NewPositionSnapshotRecord, "id">>;

export type CreateEquitySnapshotInput = Omit<NewEquitySnapshotRecord, "id" | "createdAtMs"> &
  Partial<Pick<NewEquitySnapshotRecord, "id" | "createdAtMs">>;

export class SnapshotRepository {
  constructor(private readonly db: AppDatabase) {}

  createPositionSnapshot(input: CreatePositionSnapshotInput): PositionSnapshotRecord {
    const record = {
      ...input,
      id: input.id ?? createId("position_snapshot"),
    } satisfies NewPositionSnapshotRecord;

    return requireRecord(
      this.db.insert(positionSnapshots).values(record).returning().get(),
      "Failed to create position snapshot.",
    );
  }

  listPositionSnapshots(positionId: string, range: TimeRangeFilter = {}): PositionSnapshotRecord[] {
    const conditions: SQL[] = [eq(positionSnapshots.positionId, positionId)];

    if (range.fromMs !== undefined) {
      conditions.push(gte(positionSnapshots.timestampMs, range.fromMs));
    }

    if (range.toMs !== undefined) {
      conditions.push(lte(positionSnapshots.timestampMs, range.toMs));
    }

    return this.db
      .select()
      .from(positionSnapshots)
      .where(and(...conditions))
      .orderBy(desc(positionSnapshots.timestampMs))
      .limit(limitOrDefault(range.limit))
      .all();
  }

  createEquitySnapshot(input: CreateEquitySnapshotInput): EquitySnapshotRecord {
    const record = {
      ...input,
      id: input.id ?? createId("equity_snapshot"),
      createdAtMs: input.createdAtMs ?? nowMs(),
    } satisfies NewEquitySnapshotRecord;

    return requireRecord(
      this.db.insert(equitySnapshots).values(record).returning().get(),
      "Failed to create equity snapshot.",
    );
  }

  listEquitySnapshots(sessionId: string, range: TimeRangeFilter = {}): EquitySnapshotRecord[] {
    const conditions: SQL[] = [eq(equitySnapshots.sessionId, sessionId)];

    if (range.fromMs !== undefined) {
      conditions.push(gte(equitySnapshots.timestampMs, range.fromMs));
    }

    if (range.toMs !== undefined) {
      conditions.push(lte(equitySnapshots.timestampMs, range.toMs));
    }

    return this.db
      .select()
      .from(equitySnapshots)
      .where(and(...conditions))
      .orderBy(desc(equitySnapshots.timestampMs))
      .limit(limitOrDefault(range.limit))
      .all();
  }

  getLatestEquitySnapshot(sessionId: string): EquitySnapshotRecord | undefined {
    return this.db
      .select()
      .from(equitySnapshots)
      .where(eq(equitySnapshots.sessionId, sessionId))
      .orderBy(desc(equitySnapshots.timestampMs))
      .limit(1)
      .get();
  }

  getPeakEquitySnapshot(sessionId: string): EquitySnapshotRecord | undefined {
    return this.db
      .select()
      .from(equitySnapshots)
      .where(eq(equitySnapshots.sessionId, sessionId))
      .orderBy(desc(equitySnapshots.totalEquityLamports))
      .limit(1)
      .get();
  }
}
