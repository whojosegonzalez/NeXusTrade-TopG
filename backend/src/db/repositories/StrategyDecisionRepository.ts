import { and, desc, eq, type SQL } from "drizzle-orm";

import type { AppDatabase } from "../connection.js";
import {
  strategyDecisions,
  type NewStrategyDecisionRecord,
  type StrategyDecision,
  type StrategyDecisionRecord,
} from "../schema/index.js";
import { createId } from "../utils/ids.js";
import { nowMs } from "../utils/timestamps.js";
import { limitOrDefault, requireRecord } from "./helpers.js";

export type CreateStrategyDecisionInput = Omit<NewStrategyDecisionRecord, "id" | "createdAtMs"> &
  Partial<Pick<NewStrategyDecisionRecord, "id" | "createdAtMs">>;

export interface StrategyDecisionListFilter {
  readonly decision?: StrategyDecision;
  readonly mintAddress?: string;
  readonly limit?: number;
}

export class StrategyDecisionRepository {
  constructor(private readonly db: AppDatabase) {}

  createStrategyDecision(input: CreateStrategyDecisionInput): StrategyDecisionRecord {
    const record = {
      ...input,
      id: input.id ?? createId("decision"),
      createdAtMs: input.createdAtMs ?? nowMs(),
    } satisfies NewStrategyDecisionRecord;

    return requireRecord(
      this.db.insert(strategyDecisions).values(record).returning().get(),
      "Failed to create strategy decision.",
    );
  }

  getStrategyDecisionById(id: string): StrategyDecisionRecord | undefined {
    return this.db.select().from(strategyDecisions).where(eq(strategyDecisions.id, id)).get();
  }

  listStrategyDecisions(
    sessionId: string,
    filter: StrategyDecisionListFilter = {},
  ): StrategyDecisionRecord[] {
    const conditions: SQL[] = [eq(strategyDecisions.sessionId, sessionId)];

    if (filter.decision) {
      conditions.push(eq(strategyDecisions.decision, filter.decision));
    }

    if (filter.mintAddress) {
      conditions.push(eq(strategyDecisions.mintAddress, filter.mintAddress));
    }

    return this.db
      .select()
      .from(strategyDecisions)
      .where(and(...conditions))
      .orderBy(desc(strategyDecisions.decidedAtMs))
      .limit(limitOrDefault(filter.limit))
      .all();
  }

  listDecisionsForMint(sessionId: string, mintAddress: string): StrategyDecisionRecord[] {
    return this.listStrategyDecisions(sessionId, { mintAddress });
  }
}
