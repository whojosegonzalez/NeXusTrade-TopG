import { and, desc, eq, type SQL } from "drizzle-orm";

import type { AppDatabase } from "../connection.js";
import {
  riskAssessments,
  type NewRiskAssessmentRecord,
  type RiskAssessmentRecord,
  type RiskResult,
} from "../schema/index.js";
import { createId } from "../utils/ids.js";
import { nowMs } from "../utils/timestamps.js";
import { limitOrDefault, requireRecord } from "./helpers.js";

export type CreateRiskAssessmentInput = Omit<NewRiskAssessmentRecord, "id" | "createdAtMs"> &
  Partial<Pick<NewRiskAssessmentRecord, "id" | "createdAtMs">>;

export interface RiskAssessmentListFilter {
  readonly result?: RiskResult;
  readonly mintAddress?: string;
  readonly limit?: number;
}

export class RiskAssessmentRepository {
  constructor(private readonly db: AppDatabase) {}

  createRiskAssessment(input: CreateRiskAssessmentInput): RiskAssessmentRecord {
    const record = {
      ...input,
      id: input.id ?? createId("risk"),
      createdAtMs: input.createdAtMs ?? nowMs(),
    } satisfies NewRiskAssessmentRecord;

    return requireRecord(
      this.db.insert(riskAssessments).values(record).returning().get(),
      "Failed to create risk assessment.",
    );
  }

  getRiskAssessmentById(id: string): RiskAssessmentRecord | undefined {
    return this.db.select().from(riskAssessments).where(eq(riskAssessments.id, id)).get();
  }

  getLatestRiskAssessment(
    sessionId: string,
    mintAddress: string,
  ): RiskAssessmentRecord | undefined {
    return this.db
      .select()
      .from(riskAssessments)
      .where(
        and(eq(riskAssessments.sessionId, sessionId), eq(riskAssessments.mintAddress, mintAddress)),
      )
      .orderBy(desc(riskAssessments.checkedAtMs))
      .limit(1)
      .get();
  }

  listRiskAssessments(
    sessionId: string,
    filter: RiskAssessmentListFilter = {},
  ): RiskAssessmentRecord[] {
    const conditions: SQL[] = [eq(riskAssessments.sessionId, sessionId)];

    if (filter.result) {
      conditions.push(eq(riskAssessments.result, filter.result));
    }

    if (filter.mintAddress) {
      conditions.push(eq(riskAssessments.mintAddress, filter.mintAddress));
    }

    return this.db
      .select()
      .from(riskAssessments)
      .where(and(...conditions))
      .orderBy(desc(riskAssessments.checkedAtMs))
      .limit(limitOrDefault(filter.limit))
      .all();
  }
}
