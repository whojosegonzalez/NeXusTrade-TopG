import { and, desc, eq, inArray } from "drizzle-orm";

import type { AppDatabase } from "../connection.js";
import { positions, type NewPositionRecord, type PositionRecord } from "../schema/index.js";
import { createId } from "../utils/ids.js";
import { nowMs } from "../utils/timestamps.js";
import { requireRecord } from "./helpers.js";

export type OpenPositionInput = Omit<NewPositionRecord, "id" | "createdAtMs" | "updatedAtMs"> &
  Partial<Pick<NewPositionRecord, "id" | "createdAtMs" | "updatedAtMs">>;

export interface PositionFillUpdateInput {
  readonly tokensHeld: string;
  readonly costBasisLamports: number;
  readonly feesPaidLamports: number;
  readonly avgEntryPriceSol?: string;
}

export interface ClosePositionInput {
  readonly closedAtMs?: number;
  readonly avgExitPriceSol?: string;
  readonly tokensHeld?: string;
  readonly proceedsLamports: number;
  readonly realizedPnlLamports: number;
  readonly realizedPnlBps?: number;
  readonly feesPaidLamports?: number;
}

export class PositionRepository {
  constructor(private readonly db: AppDatabase) {}

  getBlockingPositionByMint(sessionId: string, mintAddress: string): PositionRecord | undefined {
    return this.db
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.sessionId, sessionId),
          eq(positions.mintAddress, mintAddress),
          inArray(positions.status, ["OPEN", "CLOSING", "ERROR"]),
        ),
      )
      .get();
  }

  closePositionConditionally(expected: PositionRecord, input: ClosePositionInput): PositionRecord {
    return requireRecord(
      this.db
        .update(positions)
        .set({
          ...input,
          status: "CLOSED",
          closedAtMs: input.closedAtMs ?? nowMs(),
          updatedAtMs: nowMs(),
        })
        .where(
          and(
            eq(positions.id, expected.id),
            eq(positions.sessionId, expected.sessionId),
            eq(positions.status, "OPEN"),
            eq(positions.tokensHeld, expected.tokensHeld),
            eq(positions.costBasisLamports, expected.costBasisLamports),
            eq(positions.feesPaidLamports, expected.feesPaidLamports),
          ),
        )
        .returning()
        .get(),
      "ACCOUNTING_STALE_POSITION",
    );
  }

  openPosition(input: OpenPositionInput): PositionRecord {
    const timestamp = nowMs();
    const record = {
      ...input,
      id: input.id ?? createId("pos"),
      createdAtMs: input.createdAtMs ?? timestamp,
      updatedAtMs: input.updatedAtMs ?? timestamp,
    } satisfies NewPositionRecord;

    return requireRecord(
      this.db.insert(positions).values(record).returning().get(),
      "Failed to open position.",
    );
  }

  getPositionById(id: string): PositionRecord | undefined {
    return this.db.select().from(positions).where(eq(positions.id, id)).get();
  }

  getOpenPositionByMint(sessionId: string, mintAddress: string): PositionRecord | undefined {
    return this.db
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.sessionId, sessionId),
          eq(positions.mintAddress, mintAddress),
          eq(positions.status, "OPEN"),
        ),
      )
      .get();
  }

  listOpenPositions(sessionId: string): PositionRecord[] {
    return this.db
      .select()
      .from(positions)
      .where(and(eq(positions.sessionId, sessionId), eq(positions.status, "OPEN")))
      .orderBy(desc(positions.openedAtMs))
      .all();
  }

  listClosedPositions(sessionId: string): PositionRecord[] {
    return this.db
      .select()
      .from(positions)
      .where(and(eq(positions.sessionId, sessionId), eq(positions.status, "CLOSED")))
      .orderBy(desc(positions.closedAtMs))
      .all();
  }

  updatePositionAfterFill(id: string, input: PositionFillUpdateInput): PositionRecord {
    return requireRecord(
      this.db
        .update(positions)
        .set({
          avgEntryPriceSol: input.avgEntryPriceSol,
          tokensHeld: input.tokensHeld,
          costBasisLamports: input.costBasisLamports,
          feesPaidLamports: input.feesPaidLamports,
          updatedAtMs: nowMs(),
        })
        .where(eq(positions.id, id))
        .returning()
        .get(),
      `Position not found: ${id}`,
    );
  }

  closePosition(id: string, input: ClosePositionInput): PositionRecord {
    return requireRecord(
      this.db
        .update(positions)
        .set({
          status: "CLOSED",
          closedAtMs: input.closedAtMs ?? nowMs(),
          avgExitPriceSol: input.avgExitPriceSol,
          tokensHeld: input.tokensHeld,
          proceedsLamports: input.proceedsLamports,
          realizedPnlLamports: input.realizedPnlLamports,
          realizedPnlBps: input.realizedPnlBps,
          feesPaidLamports: input.feesPaidLamports,
          updatedAtMs: nowMs(),
        })
        .where(eq(positions.id, id))
        .returning()
        .get(),
      `Position not found: ${id}`,
    );
  }
}
