import { and, asc, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";

import type { AppDatabase } from "../connection.js";
import {
  watchlistReturnObservations,
  type NewWatchlistReturnObservationRecord,
  type WatchlistReturnObservationRecord,
  type WatchlistReturnStatus,
} from "../schema/index.js";
import { createId } from "../utils/ids.js";
import { nowMs } from "../utils/timestamps.js";
import { limitOrDefault, requireRecord } from "./helpers.js";

export type CreateWatchlistReturnObservationInput = Omit<
  NewWatchlistReturnObservationRecord,
  "id" | "createdAtMs" | "updatedAtMs"
> &
  Partial<Pick<NewWatchlistReturnObservationRecord, "id" | "createdAtMs" | "updatedAtMs">>;

export interface WatchlistReturnObservationListFilter {
  readonly sessionId?: string;
  readonly status?: WatchlistReturnStatus;
  readonly statuses?: readonly WatchlistReturnStatus[];
  readonly mintAddress?: string;
  readonly strategyDecisionId?: string;
  readonly strategyDecisionIds?: readonly string[];
  readonly horizonMinutes?: number;
  readonly dueFromMs?: number;
  readonly dueToMs?: number;
  readonly observedFromMs?: number;
  readonly observedToMs?: number;
  readonly limit?: number;
}

export interface ObserveWatchlistReturnInput {
  readonly observedAtMs: number;
  readonly observedPriceSol?: string | undefined;
  readonly observedPriceUsd?: string | undefined;
  readonly observedLiquidityUsd?: string | undefined;
  readonly observedVolume5mUsd?: string | undefined;
  readonly observedVolume1hUsd?: string | undefined;
  readonly observedSource?: string | undefined;
  readonly returnPctSol?: string | undefined;
  readonly returnPctUsd?: string | undefined;
  readonly rawDataJson?: string | undefined;
}

export interface FailWatchlistReturnInput {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly rawDataJson?: string | undefined;
}

export class WatchlistReturnObservationRepository {
  constructor(private readonly db: AppDatabase) {}

  createObservation(
    input: CreateWatchlistReturnObservationInput,
  ): WatchlistReturnObservationRecord {
    const timestamp = nowMs();
    const record = {
      ...input,
      id: input.id ?? createId("return"),
      createdAtMs: input.createdAtMs ?? timestamp,
      updatedAtMs: input.updatedAtMs ?? timestamp,
    } satisfies NewWatchlistReturnObservationRecord;

    return requireRecord(
      this.db.insert(watchlistReturnObservations).values(record).returning().get(),
      "Failed to create watchlist return observation.",
    );
  }

  upsertObservation(
    input: CreateWatchlistReturnObservationInput,
  ): WatchlistReturnObservationRecord {
    const existing = this.getObservationByDecisionHorizon(
      input.strategyDecisionId,
      input.horizonMinutes,
    );

    if (existing) {
      return existing;
    }

    return this.createObservation(input);
  }

  getObservationById(id: string): WatchlistReturnObservationRecord | undefined {
    return this.db
      .select()
      .from(watchlistReturnObservations)
      .where(eq(watchlistReturnObservations.id, id))
      .get();
  }

  getObservationByDecisionHorizon(
    strategyDecisionId: string,
    horizonMinutes: number,
  ): WatchlistReturnObservationRecord | undefined {
    return this.db
      .select()
      .from(watchlistReturnObservations)
      .where(
        and(
          eq(watchlistReturnObservations.strategyDecisionId, strategyDecisionId),
          eq(watchlistReturnObservations.horizonMinutes, horizonMinutes),
        ),
      )
      .get();
  }

  listObservations(
    sessionId: string,
    filter: WatchlistReturnObservationListFilter = {},
  ): WatchlistReturnObservationRecord[] {
    const conditions = this.buildConditions(filter, [
      eq(watchlistReturnObservations.sessionId, sessionId),
    ]);

    return this.db
      .select()
      .from(watchlistReturnObservations)
      .where(and(...conditions))
      .orderBy(desc(watchlistReturnObservations.dueAtMs))
      .limit(limitOrDefault(filter.limit))
      .all();
  }

  listDueObservations(
    now: number,
    filter: WatchlistReturnObservationListFilter = {},
  ): WatchlistReturnObservationRecord[] {
    const conditions = this.buildConditions(filter, [
      eq(watchlistReturnObservations.status, "PENDING"),
      lte(watchlistReturnObservations.dueAtMs, now),
    ]);

    return this.db
      .select()
      .from(watchlistReturnObservations)
      .where(and(...conditions))
      .orderBy(asc(watchlistReturnObservations.dueAtMs))
      .limit(limitOrDefault(filter.limit))
      .all();
  }

  markObserved(id: string, input: ObserveWatchlistReturnInput): WatchlistReturnObservationRecord {
    return requireRecord(
      this.db
        .update(watchlistReturnObservations)
        .set({
          status: "OBSERVED",
          observedAtMs: input.observedAtMs,
          observedPriceSol: input.observedPriceSol,
          observedPriceUsd: input.observedPriceUsd,
          observedLiquidityUsd: input.observedLiquidityUsd,
          observedVolume5mUsd: input.observedVolume5mUsd,
          observedVolume1hUsd: input.observedVolume1hUsd,
          observedSource: input.observedSource,
          returnPctSol: input.returnPctSol,
          returnPctUsd: input.returnPctUsd,
          errorCode: null,
          errorMessage: null,
          rawDataJson: input.rawDataJson,
          updatedAtMs: nowMs(),
        })
        .where(eq(watchlistReturnObservations.id, id))
        .returning()
        .get(),
      `Watchlist return observation not found: ${id}`,
    );
  }

  markFailed(id: string, input: FailWatchlistReturnInput): WatchlistReturnObservationRecord {
    return this.markTerminal(id, "FAILED", input);
  }

  markMissed(id: string, input: FailWatchlistReturnInput): WatchlistReturnObservationRecord {
    return this.markTerminal(id, "MISSED", input);
  }

  private markTerminal(
    id: string,
    status: Extract<WatchlistReturnStatus, "FAILED" | "MISSED">,
    input: FailWatchlistReturnInput,
  ): WatchlistReturnObservationRecord {
    return requireRecord(
      this.db
        .update(watchlistReturnObservations)
        .set({
          status,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          rawDataJson: input.rawDataJson,
          updatedAtMs: nowMs(),
        })
        .where(eq(watchlistReturnObservations.id, id))
        .returning()
        .get(),
      `Watchlist return observation not found: ${id}`,
    );
  }

  private buildConditions(
    filter: WatchlistReturnObservationListFilter,
    initialConditions: SQL[],
  ): SQL[] {
    const conditions = [...initialConditions];

    if (filter.status) {
      conditions.push(eq(watchlistReturnObservations.status, filter.status));
    }

    if (filter.sessionId) {
      conditions.push(eq(watchlistReturnObservations.sessionId, filter.sessionId));
    }

    if (filter.statuses && filter.statuses.length > 0) {
      conditions.push(inArray(watchlistReturnObservations.status, [...filter.statuses]));
    }

    if (filter.mintAddress) {
      conditions.push(eq(watchlistReturnObservations.mintAddress, filter.mintAddress));
    }

    if (filter.strategyDecisionId) {
      conditions.push(
        eq(watchlistReturnObservations.strategyDecisionId, filter.strategyDecisionId),
      );
    }

    if (filter.strategyDecisionIds && filter.strategyDecisionIds.length > 0) {
      conditions.push(
        inArray(watchlistReturnObservations.strategyDecisionId, [...filter.strategyDecisionIds]),
      );
    }

    if (filter.horizonMinutes !== undefined) {
      conditions.push(eq(watchlistReturnObservations.horizonMinutes, filter.horizonMinutes));
    }

    if (filter.dueFromMs !== undefined) {
      conditions.push(gte(watchlistReturnObservations.dueAtMs, filter.dueFromMs));
    }

    if (filter.dueToMs !== undefined) {
      conditions.push(lte(watchlistReturnObservations.dueAtMs, filter.dueToMs));
    }

    if (filter.observedFromMs !== undefined) {
      conditions.push(gte(watchlistReturnObservations.observedAtMs, filter.observedFromMs));
    }

    if (filter.observedToMs !== undefined) {
      conditions.push(lte(watchlistReturnObservations.observedAtMs, filter.observedToMs));
    }

    return conditions;
  }
}
