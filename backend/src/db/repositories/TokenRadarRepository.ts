import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";

import type { AppDatabase } from "../connection.js";
import {
  tokenRadar,
  type NewTokenRadarRecord,
  type TokenRadarRecord,
  type TokenRadarStatus,
} from "../schema/index.js";
import { createId } from "../utils/ids.js";
import { nowMs } from "../utils/timestamps.js";
import { limitOrDefault, requireRecord } from "./helpers.js";

export type CreateRadarEntryInput = Omit<
  NewTokenRadarRecord,
  "id" | "createdAtMs" | "updatedAtMs"
> &
  Partial<Pick<NewTokenRadarRecord, "id" | "createdAtMs" | "updatedAtMs">>;

export interface RadarEntryListFilter {
  readonly status?: TokenRadarStatus;
  readonly statuses?: readonly TokenRadarStatus[];
  readonly mintAddress?: string;
  readonly discoveredFromMs?: number;
  readonly discoveredToMs?: number;
  readonly limit?: number;
}

export class TokenRadarRepository {
  constructor(private readonly db: AppDatabase) {}

  createRadarEntry(input: CreateRadarEntryInput): TokenRadarRecord {
    const timestamp = nowMs();
    const record = {
      ...input,
      id: input.id ?? createId("radar"),
      createdAtMs: input.createdAtMs ?? timestamp,
      updatedAtMs: input.updatedAtMs ?? timestamp,
    } satisfies NewTokenRadarRecord;

    return requireRecord(
      this.db.insert(tokenRadar).values(record).returning().get(),
      "Failed to create token radar entry.",
    );
  }

  upsertRadarEntry(input: CreateRadarEntryInput): TokenRadarRecord {
    const pairAddress = input.pairAddress ?? null;
    if (pairAddress !== null && pairAddress.trim() === "") throw new Error("RADAR_INVALID_PAIR");
    const timestamp = nowMs();
    const newer = sql`${input.discoveredAtMs} > ${tokenRadar.discoveredAtMs}`;
    const merge = <K extends keyof NewTokenRadarRecord>(key: K) =>
      input[key] === undefined
        ? undefined
        : sql`CASE WHEN ${newer} THEN ${input[key]} ELSE ${tokenRadar[key]} END`;
    return requireRecord(
      this.db
        .insert(tokenRadar)
        .values({
          ...input,
          pairAddress,
          id: input.id ?? createId("radar"),
          createdAtMs: input.createdAtMs ?? timestamp,
          updatedAtMs: input.updatedAtMs ?? timestamp,
        })
        .onConflictDoUpdate({
          target:
            pairAddress === null
              ? [tokenRadar.sessionId, tokenRadar.mintAddress, tokenRadar.source]
              : [
                  tokenRadar.sessionId,
                  tokenRadar.mintAddress,
                  tokenRadar.source,
                  tokenRadar.pairAddress,
                ],
          ...(pairAddress === null ? { targetWhere: sql`${tokenRadar.pairAddress} IS NULL` } : {}),
          set: {
            firstSeenAtMs: sql`min(${tokenRadar.firstSeenAtMs}, ${input.firstSeenAtMs})`,
            discoveredAtMs: merge("discoveredAtMs"),
            symbol: merge("symbol"),
            name: merge("name"),
            priceUsd: merge("priceUsd"),
            priceSol: merge("priceSol"),
            liquidityUsd: merge("liquidityUsd"),
            volume5mUsd: merge("volume5mUsd"),
            volume1hUsd: merge("volume1hUsd"),
            ageSeconds: merge("ageSeconds"),
            notes: merge("notes"),
            rawDataJson: merge("rawDataJson"),
            status:
              input.status === undefined
                ? undefined
                : sql`CASE WHEN ${tokenRadar.status} IN ('BOUGHT', 'WATCHING', 'ERROR') THEN ${tokenRadar.status} WHEN ${newer} THEN ${input.status} ELSE ${tokenRadar.status} END`,
            updatedAtMs: sql`CASE WHEN ${newer} OR ${input.firstSeenAtMs} < ${tokenRadar.firstSeenAtMs} THEN max(${tokenRadar.updatedAtMs}, ${timestamp}) ELSE ${tokenRadar.updatedAtMs} END`,
          },
        })
        .returning()
        .get(),
      "RADAR_UPSERT_FAILED",
    );
  }

  getRadarEntryById(id: string): TokenRadarRecord | undefined {
    return this.db.select().from(tokenRadar).where(eq(tokenRadar.id, id)).get();
  }

  findRadarEntryByMint(sessionId: string, mintAddress: string): TokenRadarRecord | undefined {
    return this.db
      .select()
      .from(tokenRadar)
      .where(and(eq(tokenRadar.sessionId, sessionId), eq(tokenRadar.mintAddress, mintAddress)))
      .orderBy(desc(tokenRadar.firstSeenAtMs))
      .limit(1)
      .get();
  }

  listRadarEntries(sessionId: string, filter: RadarEntryListFilter = {}): TokenRadarRecord[] {
    const conditions: SQL[] = [eq(tokenRadar.sessionId, sessionId)];

    if (filter.status) {
      conditions.push(eq(tokenRadar.status, filter.status));
    }

    if (filter.statuses && filter.statuses.length > 0) {
      conditions.push(inArray(tokenRadar.status, [...filter.statuses]));
    }

    if (filter.mintAddress) {
      conditions.push(eq(tokenRadar.mintAddress, filter.mintAddress));
    }

    if (filter.discoveredFromMs !== undefined) {
      conditions.push(gte(tokenRadar.discoveredAtMs, filter.discoveredFromMs));
    }

    if (filter.discoveredToMs !== undefined) {
      conditions.push(lte(tokenRadar.discoveredAtMs, filter.discoveredToMs));
    }

    return this.db
      .select()
      .from(tokenRadar)
      .where(and(...conditions))
      .orderBy(desc(tokenRadar.firstSeenAtMs))
      .limit(limitOrDefault(filter.limit))
      .all();
  }

  updateRadarStatus(id: string, status: TokenRadarStatus, notes?: string): TokenRadarRecord {
    return requireRecord(
      this.db
        .update(tokenRadar)
        .set({
          status,
          notes,
          updatedAtMs: nowMs(),
        })
        .where(eq(tokenRadar.id, id))
        .returning()
        .get(),
      `Radar entry not found: ${id}`,
    );
  }
}
