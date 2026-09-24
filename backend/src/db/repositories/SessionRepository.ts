import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import type { AppDatabase } from "../connection.js";
import {
  sessions,
  type NewSessionRecord,
  type SessionRecord,
  type SessionStatus,
  type TerminationReason,
} from "../schema/index.js";
import { stringifyJson } from "../utils/json.js";
import { createId } from "../utils/ids.js";
import { nowMs } from "../utils/timestamps.js";
import { limitOrDefault, requireRecord } from "./helpers.js";

export type CreateSessionInput = Omit<NewSessionRecord, "id" | "createdAtMs" | "updatedAtMs"> &
  Partial<Pick<NewSessionRecord, "id" | "createdAtMs" | "updatedAtMs">>;

export interface SessionListFilter {
  readonly status?: SessionStatus;
  readonly mode?: SessionRecord["mode"];
  readonly limit?: number;
}

export interface SessionPnlInput {
  readonly currentCashLamports?: number;
  readonly realizedPnlLamports?: number;
  readonly unrealizedPnlLamports?: number;
}

export interface SessionGovernanceInput {
  readonly unrealizedPnlLamports?: number;
  readonly terminationReason?: TerminationReason;
}

export class SessionRepository {
  constructor(private readonly db: AppDatabase) {}

  applyAccountingDelta(
    expected: SessionRecord,
    cashDelta: number,
    pnlDelta: number,
  ): SessionRecord {
    const values = [
      expected.currentCashLamports,
      expected.realizedPnlLamports,
      cashDelta,
      pnlDelta,
    ];
    if (!values.every(Number.isSafeInteger)) throw new Error("ACCOUNTING_INVALID_AMOUNT");
    const cash = BigInt(expected.currentCashLamports) + BigInt(cashDelta);
    const pnl = BigInt(expected.realizedPnlLamports) + BigInt(pnlDelta);
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (cash < 0n || cash > max || pnl < -max || pnl > max)
      throw new Error("ACCOUNTING_INVALID_AMOUNT");
    return requireRecord(
      this.db
        .update(sessions)
        .set({
          currentCashLamports: sql`${sessions.currentCashLamports} + ${cashDelta}`,
          realizedPnlLamports: sql`${sessions.realizedPnlLamports} + ${pnlDelta}`,
          updatedAtMs: sql`max(${sessions.updatedAtMs}, ${nowMs()})`,
        })
        .where(
          and(
            eq(sessions.id, expected.id),
            eq(sessions.mode, "PAPER"),
            eq(sessions.status, "RUNNING"),
            eq(sessions.terminationReason, expected.terminationReason),
            eq(sessions.currentCashLamports, expected.currentCashLamports),
            eq(sessions.realizedPnlLamports, expected.realizedPnlLamports),
          ),
        )
        .returning()
        .get(),
      "ACCOUNTING_STALE_SESSION",
    );
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const timestamp = nowMs();
    const record = {
      ...input,
      id: input.id ?? createId("session"),
      createdAtMs: input.createdAtMs ?? timestamp,
      updatedAtMs: input.updatedAtMs ?? timestamp,
      configSnapshotJson: input.configSnapshotJson ?? stringifyJson({}),
    } satisfies NewSessionRecord;

    return requireRecord(
      this.db.insert(sessions).values(record).returning().get(),
      "Failed to create session.",
    );
  }

  getSessionById(id: string): SessionRecord | undefined {
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get();
  }

  listSessions(filter: SessionListFilter = {}): SessionRecord[] {
    const conditions: SQL[] = [];

    if (filter.status) {
      conditions.push(eq(sessions.status, filter.status));
    }

    if (filter.mode) {
      conditions.push(eq(sessions.mode, filter.mode));
    }

    return this.db
      .select()
      .from(sessions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(sessions.startedAtMs))
      .limit(limitOrDefault(filter.limit))
      .all();
  }

  markSessionRunning(id: string): SessionRecord {
    return this.updateStatus(id, "RUNNING");
  }

  updateSessionGovernance(id: string, input: SessionGovernanceInput): SessionRecord {
    return requireRecord(
      this.db
        .update(sessions)
        .set({
          ...input,
          updatedAtMs: nowMs(),
        })
        .where(eq(sessions.id, id))
        .returning()
        .get(),
      `Session not found: ${id}`,
    );
  }

  markTerminationReason(id: string, terminationReason: TerminationReason): SessionRecord {
    return this.updateSessionGovernance(id, { terminationReason });
  }

  updateSessionPnl(id: string, input: SessionPnlInput): SessionRecord {
    return requireRecord(
      this.db
        .update(sessions)
        .set({
          ...input,
          updatedAtMs: nowMs(),
        })
        .where(eq(sessions.id, id))
        .returning()
        .get(),
      `Session not found: ${id}`,
    );
  }

  completeSession(id: string, terminationReason: TerminationReason): SessionRecord {
    return requireRecord(
      this.db
        .update(sessions)
        .set({
          status: "COMPLETED",
          terminationReason,
          endedAtMs: nowMs(),
          updatedAtMs: nowMs(),
        })
        .where(eq(sessions.id, id))
        .returning()
        .get(),
      `Session not found: ${id}`,
    );
  }

  failSession(id: string, errorContext: unknown): SessionRecord {
    return requireRecord(
      this.db
        .update(sessions)
        .set({
          status: "FAILED",
          terminationReason: "ENGINE_ERROR",
          endedAtMs: nowMs(),
          updatedAtMs: nowMs(),
          configSnapshotJson: stringifyJson(errorContext),
        })
        .where(eq(sessions.id, id))
        .returning()
        .get(),
      `Session not found: ${id}`,
    );
  }

  getActivePaperSessions(): SessionRecord[] {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.mode, "PAPER"), eq(sessions.status, "RUNNING")))
      .orderBy(desc(sessions.startedAtMs))
      .all();
  }

  getLatestRunningPaperSession(): SessionRecord | undefined {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.mode, "PAPER"), eq(sessions.status, "RUNNING")))
      .orderBy(desc(sessions.startedAtMs))
      .limit(1)
      .get();
  }

  getCompletedSessions(): SessionRecord[] {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.status, "COMPLETED"))
      .orderBy(desc(sessions.endedAtMs))
      .all();
  }

  private updateStatus(id: string, status: SessionStatus): SessionRecord {
    return requireRecord(
      this.db
        .update(sessions)
        .set({
          status,
          updatedAtMs: nowMs(),
        })
        .where(eq(sessions.id, id))
        .returning()
        .get(),
      `Session not found: ${id}`,
    );
  }
}
