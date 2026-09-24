import { and, desc, eq, type SQL } from "drizzle-orm";

import type { AppDatabase } from "../connection.js";
import {
  orders,
  type NewOrderRecord,
  type OrderRecord,
  type OrderStatus,
} from "../schema/index.js";
import { stringifyJson } from "../utils/json.js";
import { createId } from "../utils/ids.js";
import { nowMs } from "../utils/timestamps.js";
import { limitOrDefault, requireRecord } from "./helpers.js";

export type CreateOrderInput = Omit<NewOrderRecord, "id" | "createdAtMs" | "updatedAtMs"> &
  Partial<Pick<NewOrderRecord, "id" | "createdAtMs" | "updatedAtMs">>;

export interface OrderListFilter {
  readonly mintAddress?: string;
  readonly status?: OrderStatus;
  readonly limit?: number;
}

export interface QuoteLinkInput {
  readonly quoteSource: string;
  readonly quoteId?: string;
  readonly rawOrder?: unknown;
}

export class OrderRepository {
  constructor(private readonly db: AppDatabase) {}

  transitionOrder(expected: OrderRecord, status: OrderStatus): OrderRecord {
    return requireRecord(
      this.db
        .update(orders)
        .set({ status, updatedAtMs: nowMs() })
        .where(
          and(
            eq(orders.id, expected.id),
            eq(orders.sessionId, expected.sessionId),
            eq(orders.status, expected.status),
          ),
        )
        .returning()
        .get(),
      "ACCOUNTING_STALE_ORDER",
    );
  }

  createOrder(input: CreateOrderInput): OrderRecord {
    const timestamp = nowMs();
    const record = {
      ...input,
      id: input.id ?? createId("order"),
      createdAtMs: input.createdAtMs ?? timestamp,
      updatedAtMs: input.updatedAtMs ?? timestamp,
    } satisfies NewOrderRecord;

    return requireRecord(
      this.db.insert(orders).values(record).returning().get(),
      "Failed to create order.",
    );
  }

  getOrderById(id: string): OrderRecord | undefined {
    return this.db.select().from(orders).where(eq(orders.id, id)).get();
  }

  listOrders(sessionId: string, filter: OrderListFilter = {}): OrderRecord[] {
    const conditions: SQL[] = [eq(orders.sessionId, sessionId)];

    if (filter.mintAddress) {
      conditions.push(eq(orders.mintAddress, filter.mintAddress));
    }

    if (filter.status) {
      conditions.push(eq(orders.status, filter.status));
    }

    return this.db
      .select()
      .from(orders)
      .where(and(...conditions))
      .orderBy(desc(orders.createdAtMs))
      .limit(limitOrDefault(filter.limit))
      .all();
  }

  updateOrderStatus(id: string, status: OrderStatus, context?: unknown): OrderRecord {
    const rawOrderJson = context === undefined ? undefined : stringifyJson(context);

    return requireRecord(
      this.db
        .update(orders)
        .set({
          status,
          rawOrderJson,
          updatedAtMs: nowMs(),
        })
        .where(eq(orders.id, id))
        .returning()
        .get(),
      `Order not found: ${id}`,
    );
  }

  linkOrderToQuote(id: string, input: QuoteLinkInput): OrderRecord {
    return requireRecord(
      this.db
        .update(orders)
        .set({
          quoteSource: input.quoteSource,
          quoteId: input.quoteId,
          rawOrderJson: input.rawOrder === undefined ? undefined : stringifyJson(input.rawOrder),
          updatedAtMs: nowMs(),
        })
        .where(eq(orders.id, id))
        .returning()
        .get(),
      `Order not found: ${id}`,
    );
  }
}
