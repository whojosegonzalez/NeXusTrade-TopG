import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "../connection.js";
import { paperOperations, orders, fills, positions } from "../schema/index.js";
import {
  identifyPaperOperation,
  type PaperOperationIdentity,
} from "../../paper/PaperOperationIdentity.js";
import {
  paperOperationResultSchema,
  type PaperOperationResult,
} from "../../paper/PaperOperationResult.js";

export class PaperOperationRepository {
  constructor(private readonly db: AppDatabase) {}
  getOperation(id: string) {
    return this.db.select().from(paperOperations).where(eq(paperOperations.id, id)).get();
  }
  listOperations(sessionId: string) {
    return this.db
      .select()
      .from(paperOperations)
      .where(eq(paperOperations.sessionId, sessionId))
      .all();
  }
  register(identity: PaperOperationIdentity, now: number) {
    let input: unknown;
    try {
      input = JSON.parse(identity.intentJson);
    } catch {
      throw new Error("PAPER_OPERATION_INVALID_INTENT");
    }
    const checked = identifyPaperOperation(input);
    if (
      (Object.keys(checked) as (keyof PaperOperationIdentity)[]).some(
        (key) => checked[key] !== identity[key],
      )
    )
      throw new Error("PAPER_OPERATION_INVALID_INTENT");
    const refs = z.object({ radarId: z.string().optional() }).parse(input);
    this.db
      .insert(paperOperations)
      .values({
        id: identity.id,
        version: 1,
        sessionId: identity.sessionId,
        side: identity.side,
        sourceId: identity.sourceId,
        mintAddress: identity.mint,
        strategyDecisionId: identity.side === "BUY" ? identity.sourceId : null,
        inputPositionId: identity.side === "SELL" ? identity.sourceId : null,
        radarId: refs.radarId ?? null,
        intentDigest: identity.intentDigest,
        intentJson: identity.intentJson,
        createdAtMs: now,
        updatedAtMs: now,
      })
      .onConflictDoNothing({ target: paperOperations.id })
      .run();
    return this.requireMatching(identity);
  }
  requireMatching(identity: PaperOperationIdentity) {
    const row = this.getOperation(identity.id);
    if (!row) throw new Error("PAPER_OPERATION_CORRUPT_OPERATION");
    if (row.intentDigest !== identity.intentDigest || row.intentJson !== identity.intentJson)
      throw new Error("PAPER_OPERATION_IDENTITY_CONFLICT");
    const refs = z
      .object({ radarId: z.string().optional() })
      .parse(JSON.parse(identity.intentJson));
    if (
      row.sessionId !== identity.sessionId ||
      row.side !== identity.side ||
      row.sourceId !== identity.sourceId ||
      row.mintAddress !== identity.mint ||
      row.version !== 1 ||
      row.mode !== "PAPER" ||
      row.radarId !== (refs.radarId ?? null) ||
      row.strategyDecisionId !== (identity.side === "BUY" ? identity.sourceId : null) ||
      row.inputPositionId !== (identity.side === "SELL" ? identity.sourceId : null)
    )
      throw new Error("PAPER_OPERATION_CORRUPT_OPERATION");
    return row;
  }
  readTerminal(identity: PaperOperationIdentity): PaperOperationResult | undefined {
    const row = this.requireMatching(identity);
    if (row.state === "PENDING") return undefined;
    let value: unknown;
    try {
      value = JSON.parse(row.resultJson ?? "");
    } catch {
      throw new Error("PAPER_OPERATION_CORRUPT_OPERATION");
    }
    const parsed = paperOperationResultSchema.safeParse(value);
    if (!parsed.success) throw new Error("PAPER_OPERATION_CORRUPT_OPERATION");
    const result = parsed.data;
    if (
      result.operationId !== row.id ||
      result.side !== row.side ||
      result.state !== row.state ||
      result.orderId !== row.orderId ||
      (result.fillId ?? null) !== row.fillId ||
      (result.positionId ?? null) !== row.resultPositionId
    )
      throw new Error("PAPER_OPERATION_CORRUPT_OPERATION");
    this.validateResultReferences(identity, result);
    return result;
  }
  finish(
    identity: PaperOperationIdentity,
    input: PaperOperationResult,
    now: number,
  ): PaperOperationResult {
    const result = paperOperationResultSchema.parse(input);
    if (result.operationId !== identity.id || result.side !== identity.side)
      throw new Error("PAPER_OPERATION_INVALID_INTENT");
    const current = this.requireMatching(identity);
    if (current.state !== "PENDING") throw new Error("PAPER_OPERATION_INVALID_STATE");
    this.validateResultReferences(identity, result);
    const changed = this.db
      .update(paperOperations)
      .set({
        state: result.state,
        orderId: result.orderId,
        fillId: result.fillId ?? null,
        resultPositionId: result.positionId ?? null,
        resultJson: JSON.stringify(result),
        updatedAtMs: now,
      })
      .where(
        and(
          eq(paperOperations.id, identity.id),
          eq(paperOperations.state, "PENDING"),
          eq(paperOperations.intentDigest, identity.intentDigest),
        ),
      )
      .run();
    if (changed.changes !== 1) throw new Error("PAPER_OPERATION_INVALID_STATE");
    return result;
  }
  private validateResultReferences(
    identity: PaperOperationIdentity,
    result: PaperOperationResult,
  ): void {
    const order = this.db.select().from(orders).where(eq(orders.id, result.orderId)).get();
    if (
      !order ||
      order.operationId !== identity.id ||
      order.sessionId !== identity.sessionId ||
      order.side !== identity.side ||
      order.mintAddress !== identity.mint ||
      order.mode !== "PAPER" ||
      order.status !== (result.state === "COMMITTED" ? "FILLED" : "REJECTED")
    )
      throw new Error("PAPER_OPERATION_CORRUPT_OPERATION");
    const ownedFills = this.db.select().from(fills).where(eq(fills.orderId, order.id)).all();
    if (result.state === "REJECTED") {
      if (ownedFills.length) throw new Error("PAPER_OPERATION_CORRUPT_OPERATION");
      return;
    }
    const fill = ownedFills[0];
    const position = result.positionId
      ? this.db.select().from(positions).where(eq(positions.id, result.positionId)).get()
      : undefined;
    if (
      ownedFills.length !== 1 ||
      !fill ||
      fill.id !== result.fillId ||
      fill.operationId !== identity.id ||
      fill.sessionId !== identity.sessionId ||
      !position ||
      position.sessionId !== identity.sessionId ||
      position.mintAddress !== identity.mint ||
      (identity.side === "SELL" &&
        (position.id !== identity.sourceId || position.status !== "CLOSED"))
    )
      throw new Error("PAPER_OPERATION_CORRUPT_OPERATION");
    const fees = BigInt(fill.estimatedBaseFeeLamports) + BigInt(fill.estimatedPriorityFeeLamports);
    const slippage = BigInt(fill.estimatedSlippageLamports);
    if (BigInt(result.feesLamports) !== fees || BigInt(result.slippageLamports) !== slippage)
      throw new Error("PAPER_OPERATION_CORRUPT_OPERATION");
    if (identity.side === "BUY") {
      if (
        fill.solSpentLamports === null ||
        fill.solReceivedLamports !== null ||
        result.realizedPnlDeltaLamports !== 0 ||
        result.grossProceedsLamports !== 0 ||
        BigInt(result.cashDeltaLamports) !== -(BigInt(fill.solSpentLamports) + fees + slippage) ||
        BigInt(position.costBasisLamports) !== BigInt(fill.solSpentLamports) + slippage ||
        order.strategyDecisionId !== identity.sourceId
      )
        throw new Error("PAPER_OPERATION_CORRUPT_OPERATION");
    } else {
      if (
        fill.solReceivedLamports === null ||
        fill.solSpentLamports !== null ||
        result.cashDeltaLamports !== fill.solReceivedLamports ||
        BigInt(result.grossProceedsLamports) !==
          BigInt(fill.solReceivedLamports) + fees + slippage ||
        BigInt(result.realizedPnlDeltaLamports) !==
          BigInt(fill.solReceivedLamports) -
            BigInt(position.costBasisLamports) -
            (BigInt(position.feesPaidLamports) - fees) ||
        position.realizedPnlLamports !== result.realizedPnlDeltaLamports ||
        position.proceedsLamports !== fill.solReceivedLamports ||
        position.tokensHeld !== "0"
      )
        throw new Error("PAPER_OPERATION_CORRUPT_OPERATION");
    }
  }
}
