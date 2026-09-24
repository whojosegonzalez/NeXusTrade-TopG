import { desc, eq } from "drizzle-orm";

import type { AppDatabase } from "../connection.js";
import { fills, type FillRecord, type NewFillRecord } from "../schema/index.js";
import { createId } from "../utils/ids.js";
import { nowMs } from "../utils/timestamps.js";
import { requireRecord } from "./helpers.js";

export type CreateFillInput = Omit<NewFillRecord, "id" | "createdAtMs"> &
  Partial<Pick<NewFillRecord, "id" | "createdAtMs">>;

export class FillRepository {
  constructor(private readonly db: AppDatabase) {}

  createFill(input: CreateFillInput): FillRecord {
    const record = {
      ...input,
      id: input.id ?? createId("fill"),
      createdAtMs: input.createdAtMs ?? nowMs(),
    } satisfies NewFillRecord;

    return requireRecord(
      this.db.insert(fills).values(record).returning().get(),
      "Failed to create fill.",
    );
  }

  getFillById(id: string): FillRecord | undefined {
    return this.db.select().from(fills).where(eq(fills.id, id)).get();
  }

  listFillsForOrder(orderId: string): FillRecord[] {
    return this.db
      .select()
      .from(fills)
      .where(eq(fills.orderId, orderId))
      .orderBy(desc(fills.filledAtMs))
      .all();
  }

  listFillsForSession(sessionId: string): FillRecord[] {
    return this.db
      .select()
      .from(fills)
      .where(eq(fills.sessionId, sessionId))
      .orderBy(desc(fills.filledAtMs))
      .all();
  }
}
