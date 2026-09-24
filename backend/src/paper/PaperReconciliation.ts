import type {
  SessionRecord,
  OrderRecord,
  FillRecord,
  PositionRecord,
  StrategyDecisionRecord,
  TokenRadarRecord,
} from "../db/schema/index.js";
import type { paperOperations } from "../db/schema/paperOperations.js";
import { identifyPaperOperation } from "./PaperOperationIdentity.js";
import { paperOperationResultSchema } from "./PaperOperationResult.js";
import { isPositiveDecimal } from "./PaperMath.js";

export interface PaperReconciliationSnapshot {
  readonly session: SessionRecord | undefined;
  readonly orders: readonly OrderRecord[];
  readonly fills: readonly FillRecord[];
  readonly positions: readonly PositionRecord[];
  readonly operations: readonly (typeof paperOperations.$inferSelect)[];
  readonly decisions: readonly StrategyDecisionRecord[];
  readonly radar: readonly TokenRadarRecord[];
}
export interface PaperReconciliationReader {
  /** Supply a consistent, complete scoped snapshot. No database factory or mutation capability is needed. */
  readSnapshot(sessionId: string): PaperReconciliationSnapshot;
}
export type ReconciliationStatus = "PASS" | "INCOMPLETE" | "DISCREPANCY";
const checks = [
  "CASH",
  "FILL_ORDER",
  "OWNERSHIP",
  "OPERATIONS",
  "POSITIONS",
  "FEES_PNL",
  "HISTORY",
] as const;
type Check = (typeof checks)[number];
export interface ReconciliationFinding {
  readonly check: Check;
  readonly status: Exclude<ReconciliationStatus, "PASS">;
  readonly code: string;
  readonly ids: readonly string[];
}

/** Pure analysis of supplied evidence. Never opens a database, reads configuration, writes, or repairs. */
export function reconcilePaperSession(sessionId: string, reader: PaperReconciliationReader) {
  if (!sessionId || sessionId.length > 256) throw new Error("RECONCILIATION_INVALID_SCOPE");
  const data = reader.readSnapshot(sessionId);
  const statuses: Record<Check, ReconciliationStatus> = {
    CASH: "PASS",
    FILL_ORDER: "PASS",
    OWNERSHIP: "PASS",
    OPERATIONS: "PASS",
    POSITIONS: "PASS",
    FEES_PNL: "PASS",
    HISTORY: "PASS",
  };
  const findings: ReconciliationFinding[] = [];
  let findingCount = 0;
  const note = (
    check: Check,
    status: Exclude<ReconciliationStatus, "PASS">,
    code: string,
    ...ids: string[]
  ) => {
    if (statuses[check] !== "DISCREPANCY") statuses[check] = status;
    findingCount++;
    if (findings.length < 100)
      findings.push({ check, status, code, ids: ids.slice(0, 4).map((id) => id.slice(0, 256)) });
  };
  const amount = (value: number | null, check: Check, id: string, signed = false): bigint => {
    if (value === null) {
      note(check, "INCOMPLETE", "MISSING_AMOUNT", id);
      return 0n;
    }
    if (!Number.isSafeInteger(value) || (!signed && value < 0)) {
      note(check, "DISCREPANCY", "INVALID_AMOUNT", id);
      return 0n;
    }
    return BigInt(value);
  };
  const index = <T extends { id: string; sessionId: string }>(rows: readonly T[]) => {
    const map = new Map<string, T>();
    for (const row of rows) {
      if (map.has(row.id)) note("OWNERSHIP", "DISCREPANCY", "DUPLICATE_ID", row.id);
      if (row.sessionId !== sessionId) note("OWNERSHIP", "DISCREPANCY", "FOREIGN_SESSION", row.id);
      map.set(row.id, row);
    }
    return map;
  };
  const orders = index(data.orders),
    fills = index(data.fills),
    positions = index(data.positions),
    operations = index(data.operations),
    decisions = index(data.decisions),
    radar = index(data.radar);
  const fillGroups = new Map<string, FillRecord[]>();
  let cashDelta = 0n,
    realized = 0n;
  for (const fill of data.fills) {
    const group = fillGroups.get(fill.orderId) ?? [];
    group.push(fill);
    fillGroups.set(fill.orderId, group);
    const order = orders.get(fill.orderId);
    if (!order) {
      note("FILL_ORDER", "DISCREPANCY", "ORPHAN_FILL", fill.id);
      continue;
    }
    if (order.sessionId !== fill.sessionId)
      note("OWNERSHIP", "DISCREPANCY", "FILL_OWNER_MISMATCH", fill.id, order.id);
    if (order.status !== "FILLED")
      note("FILL_ORDER", "DISCREPANCY", "FILL_ORDER_STATE", fill.id, order.id);
    const fees =
      amount(fill.estimatedBaseFeeLamports, "FEES_PNL", fill.id) +
      amount(fill.estimatedPriorityFeeLamports, "FEES_PNL", fill.id);
    const slip = amount(fill.estimatedSlippageLamports, "FEES_PNL", fill.id);
    if (!isPositiveDecimal(fill.tokensFilled))
      note("FILL_ORDER", "INCOMPLETE", "MISSING_OR_UNSUPPORTED_QUANTITY", fill.id);
    if (order.side === "BUY") {
      cashDelta -= amount(fill.solSpentLamports, "CASH", fill.id) + fees + slip;
      if (fill.solReceivedLamports !== null)
        note("FILL_ORDER", "DISCREPANCY", "BUY_RECEIVED_AMOUNT", fill.id);
    } else if (order.side === "SELL") {
      cashDelta += amount(fill.solReceivedLamports, "CASH", fill.id);
      if (fill.solSpentLamports !== null)
        note("FILL_ORDER", "DISCREPANCY", "SELL_SPENT_AMOUNT", fill.id);
    } else note("FILL_ORDER", "DISCREPANCY", "INVALID_ORDER_SIDE", order.id);
    if (!fill.operationId) note("HISTORY", "INCOMPLETE", "LEGACY_FILL_WITHOUT_OPERATION", fill.id);
    else {
      const operation = operations.get(fill.operationId);
      if (
        !operation ||
        operation.state !== "COMMITTED" ||
        operation.fillId !== fill.id ||
        order.operationId !== operation.id
      )
        note("OPERATIONS", "DISCREPANCY", "FILL_OPERATION_MISMATCH", fill.id);
    }
  }
  for (const order of data.orders) {
    const group = fillGroups.get(order.id) ?? [];
    if (order.mode !== "PAPER") note("OWNERSHIP", "DISCREPANCY", "NON_PAPER_ORDER", order.id);
    if (order.status === "FILLED" && group.length === 0)
      note("FILL_ORDER", "DISCREPANCY", "FILLED_ORDER_WITHOUT_FILL", order.id);
    if (group.length > 1)
      note(
        "FILL_ORDER",
        order.operationId ? "DISCREPANCY" : "INCOMPLETE",
        "MULTIPLE_FILLS_UNSUPPORTED",
        order.id,
      );
    if (!order.operationId)
      note("HISTORY", "INCOMPLETE", "LEGACY_ORDER_WITHOUT_OPERATION", order.id);
    else if (!operations.has(order.operationId))
      note("OPERATIONS", "DISCREPANCY", "ORPHAN_ORDER_OPERATION", order.id);
    if (order.strategyDecisionId) {
      const decision = decisions.get(order.strategyDecisionId);
      if (
        !decision ||
        decision.sessionId !== order.sessionId ||
        decision.mintAddress !== order.mintAddress
      )
        note("OWNERSHIP", "DISCREPANCY", "ORDER_DECISION_MISMATCH", order.id);
    }
  }
  const buys = new Map<string, (typeof data.operations)[number][]>(),
    sells = new Map<string, (typeof data.operations)[number][]>();
  for (const op of data.operations) {
    try {
      const identity = identifyPaperOperation(JSON.parse(op.intentJson));
      if (
        identity.id !== op.id ||
        identity.intentDigest !== op.intentDigest ||
        identity.intentJson !== op.intentJson ||
        identity.sessionId !== op.sessionId ||
        identity.side !== op.side ||
        identity.sourceId !== op.sourceId ||
        identity.mint !== op.mintAddress ||
        op.mode !== "PAPER" ||
        op.version !== 1
      )
        note("OPERATIONS", "DISCREPANCY", "INVALID_OPERATION_IDENTITY", op.id);
    } catch {
      note("OPERATIONS", "DISCREPANCY", "INVALID_OPERATION_IDENTITY", op.id);
    }
    if (op.side === "BUY") {
      const decision = op.strategyDecisionId ? decisions.get(op.strategyDecisionId) : undefined;
      const row = op.radarId ? radar.get(op.radarId) : undefined;
      if (
        !decision ||
        !row ||
        decision.id !== op.sourceId ||
        decision.mintAddress !== op.mintAddress ||
        row.mintAddress !== op.mintAddress ||
        op.inputPositionId !== null
      )
        note("OWNERSHIP", "DISCREPANCY", "BUY_SOURCE_MISMATCH", op.id);
    } else {
      const position = op.inputPositionId ? positions.get(op.inputPositionId) : undefined;
      if (
        !position ||
        position.id !== op.sourceId ||
        position.mintAddress !== op.mintAddress ||
        op.strategyDecisionId !== null
      )
        note("OWNERSHIP", "DISCREPANCY", "SELL_SOURCE_MISMATCH", op.id);
    }
    const ownedOrders = data.orders.filter((row) => row.operationId === op.id);
    if (op.state === "PENDING") {
      if (op.resultJson || op.orderId || op.fillId || op.resultPositionId || ownedOrders.length)
        note("OPERATIONS", "DISCREPANCY", "PENDING_HAS_EFFECTS", op.id);
      else note("OPERATIONS", "INCOMPLETE", "PENDING_OPERATION", op.id);
      continue;
    }
    let parsed: ReturnType<typeof paperOperationResultSchema.safeParse>;
    try {
      parsed = paperOperationResultSchema.safeParse(JSON.parse(op.resultJson ?? ""));
    } catch {
      note("OPERATIONS", "DISCREPANCY", "INVALID_TERMINAL_RESULT", op.id);
      continue;
    }
    if (!parsed.success) {
      note("OPERATIONS", "DISCREPANCY", "INVALID_TERMINAL_RESULT", op.id);
      continue;
    }
    const result = parsed.data,
      order = op.orderId ? orders.get(op.orderId) : undefined;
    if (
      result.operationId !== op.id ||
      result.state !== op.state ||
      result.side !== op.side ||
      result.orderId !== op.orderId ||
      (result.fillId ?? null) !== op.fillId ||
      (result.positionId ?? null) !== op.resultPositionId ||
      !order ||
      ownedOrders.length !== 1 ||
      order.operationId !== op.id ||
      order.side !== op.side ||
      order.mintAddress !== op.mintAddress ||
      order.status !== (op.state === "COMMITTED" ? "FILLED" : "REJECTED")
    )
      note("OPERATIONS", "DISCREPANCY", "TERMINAL_REFERENCE_MISMATCH", op.id);
    if (op.state === "REJECTED") continue;
    const fill = op.fillId ? fills.get(op.fillId) : undefined,
      position = op.resultPositionId ? positions.get(op.resultPositionId) : undefined;
    if (
      !fill ||
      !position ||
      fill.operationId !== op.id ||
      fill.orderId !== op.orderId ||
      position.mintAddress !== op.mintAddress
    ) {
      note("OPERATIONS", "DISCREPANCY", "COMMITTED_REFERENCE_MISSING", op.id);
      continue;
    }
    const map = op.side === "BUY" ? buys : sells;
    const list = map.get(position.id) ?? [];
    list.push(op);
    map.set(position.id, list);
    const fees =
        amount(fill.estimatedBaseFeeLamports, "FEES_PNL", fill.id) +
        amount(fill.estimatedPriorityFeeLamports, "FEES_PNL", fill.id),
      slip = amount(fill.estimatedSlippageLamports, "FEES_PNL", fill.id);
    if (BigInt(result.feesLamports) !== fees || BigInt(result.slippageLamports) !== slip)
      note("FEES_PNL", "DISCREPANCY", "RESULT_COST_MISMATCH", op.id);
    if (op.side === "BUY") {
      const principal = amount(fill.solSpentLamports, "FEES_PNL", fill.id);
      if (
        BigInt(result.cashDeltaLamports) !== -(principal + fees + slip) ||
        result.realizedPnlDeltaLamports !== 0 ||
        result.grossProceedsLamports !== 0 ||
        amount(position.costBasisLamports, "FEES_PNL", position.id) !== principal + slip
      )
        note("FEES_PNL", "DISCREPANCY", "BUY_ACCOUNTING_MISMATCH", op.id);
    } else {
      const net = amount(fill.solReceivedLamports, "FEES_PNL", fill.id);
      if (
        position.id !== op.sourceId ||
        position.status !== "CLOSED" ||
        position.tokensHeld !== "0"
      )
        note("POSITIONS", "DISCREPANCY", "SELL_POSITION_STATE", op.id);
      if (
        BigInt(result.cashDeltaLamports) !== net ||
        BigInt(result.grossProceedsLamports) !== net + fees + slip ||
        amount(position.proceedsLamports, "FEES_PNL", position.id) !== net ||
        BigInt(result.realizedPnlDeltaLamports) !==
          net -
            amount(position.costBasisLamports, "FEES_PNL", position.id) -
            (amount(position.feesPaidLamports, "FEES_PNL", position.id) - fees) ||
        position.realizedPnlLamports !== result.realizedPnlDeltaLamports
      )
        note("FEES_PNL", "DISCREPANCY", "SELL_ACCOUNTING_MISMATCH", op.id);
      realized += BigInt(result.realizedPnlDeltaLamports);
    }
  }
  const active = new Set<string>();
  for (const position of data.positions) {
    const opening = buys.get(position.id) ?? [],
      closing = sells.get(position.id) ?? [];
    if (opening.length === 0)
      note("HISTORY", "INCOMPLETE", "MISSING_LINKED_OPENING_FILL", position.id);
    if (opening.length > 1 || closing.length > 1)
      note("POSITIONS", "DISCREPANCY", "MULTIPLE_POSITION_OPERATIONS", position.id);
    if (position.status === "OPEN" || position.status === "CLOSING") {
      if (active.has(position.mintAddress))
        note("POSITIONS", "DISCREPANCY", "DUPLICATE_ACTIVE_MINT", position.id);
      active.add(position.mintAddress);
      if (position.status === "CLOSING")
        note("POSITIONS", "INCOMPLETE", "UNSUPPORTED_POSITION_STATE", position.id);
      if (closing.length || position.closedAtMs !== null)
        note("POSITIONS", "DISCREPANCY", "ACTIVE_POSITION_HAS_CLOSE", position.id);
      const fill = opening[0]?.fillId ? fills.get(opening[0].fillId) : undefined;
      if (fill && position.tokensHeld !== fill.tokensFilled)
        note("POSITIONS", "INCOMPLETE", "UNSUPPORTED_QUANTITY_CHANGE", position.id);
    } else if (position.status === "CLOSED") {
      if (closing.length === 0)
        note("HISTORY", "INCOMPLETE", "MISSING_LINKED_CLOSING_FILL", position.id);
      if (position.closedAtMs === null || position.closedAtMs < position.openedAtMs)
        note("POSITIONS", "DISCREPANCY", "INVALID_CLOSE_TIME", position.id);
    } else note("POSITIONS", "INCOMPLETE", "UNSUPPORTED_POSITION_STATE", position.id);
    const related = [...opening, ...closing];
    if (opening.length === 1 && (position.status !== "CLOSED" || closing.length === 1)) {
      const expectedFees = related.reduce((total, op) => {
        const fill = op.fillId ? fills.get(op.fillId) : undefined;
        return (
          total +
          (fill
            ? amount(fill.estimatedBaseFeeLamports, "FEES_PNL", fill.id) +
              amount(fill.estimatedPriorityFeeLamports, "FEES_PNL", fill.id)
            : 0n)
        );
      }, 0n);
      if (amount(position.feesPaidLamports, "FEES_PNL", position.id) !== expectedFees)
        note("FEES_PNL", "DISCREPANCY", "POSITION_FEES_MISMATCH", position.id);
    }
  }
  const session = data.session;
  if (!session) {
    for (const check of checks) note(check, "INCOMPLETE", "SESSION_MISSING", sessionId);
  } else {
    if (session.id !== sessionId || session.mode !== "PAPER")
      note("OWNERSHIP", "DISCREPANCY", "SESSION_SCOPE_MISMATCH", session.id);
    if (
      statuses.CASH === "PASS" &&
      amount(session.currentCashLamports, "CASH", session.id) !==
        amount(session.startingBalanceLamports, "CASH", session.id) + cashDelta
    ) {
      note("CASH", "DISCREPANCY", "CASH_EQUATION_MISMATCH", session.id);
      note("HISTORY", "INCOMPLETE", "UNEXPLAINED_CASH_MOVEMENT", session.id);
    }
    if (amount(session.realizedPnlLamports, "FEES_PNL", session.id, true) !== realized)
      note(
        "FEES_PNL",
        statuses.HISTORY === "PASS" ? "DISCREPANCY" : "INCOMPLETE",
        "SESSION_PNL_MISMATCH",
        session.id,
      );
  }
  const invariants = checks.map((check) => ({ check, status: statuses[check] }));
  const status: ReconciliationStatus = invariants.some((row) => row.status === "DISCREPANCY")
    ? "DISCREPANCY"
    : invariants.some((row) => row.status === "INCOMPLETE")
      ? "INCOMPLETE"
      : "PASS";
  return {
    sessionId,
    status,
    invariants,
    findings,
    omittedFindingCount: findingCount - findings.length,
  };
}
