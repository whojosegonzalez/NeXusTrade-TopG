import type { SessionRecord } from "../db/schema/index.js";
import type { PositionValuationResult } from "./PositionValuationService.js";

export interface PositionEquitySnapshotInput {
  readonly valuation: PositionValuationResult;
  readonly unrealizedPnlLamports: number;
  readonly unrealizedPnlBps?: number;
}

export interface EquityCalculationResult {
  readonly cashLamports: number;
  readonly openPositionValueLamports: number;
  readonly totalEquityLamports: number;
  readonly realizedPnlLamports: number;
  readonly unrealizedPnlLamports: number;
  readonly positions: readonly PositionEquitySnapshotInput[];
}

export class EquityCalculationService {
  calculate(
    session: SessionRecord,
    valuations: readonly PositionValuationResult[],
  ): EquityCalculationResult {
    const positions = valuations.map((valuation) => {
      const totalBasisLamports =
        valuation.position.costBasisLamports + valuation.position.feesPaidLamports;
      const unrealizedPnlLamports = valuation.marketValueLamports - totalBasisLamports;
      const unrealizedPnlBps =
        totalBasisLamports > 0
          ? Math.round((unrealizedPnlLamports / totalBasisLamports) * 10_000)
          : undefined;

      return {
        valuation,
        unrealizedPnlLamports,
        ...(unrealizedPnlBps !== undefined ? { unrealizedPnlBps } : {}),
      };
    });
    const openPositionValueLamports = positions.reduce(
      (sum, position) => sum + position.valuation.marketValueLamports,
      0,
    );
    const unrealizedPnlLamports = positions.reduce(
      (sum, position) => sum + position.unrealizedPnlLamports,
      0,
    );

    return {
      cashLamports: session.currentCashLamports,
      openPositionValueLamports,
      totalEquityLamports: session.currentCashLamports + openPositionValueLamports,
      realizedPnlLamports: session.realizedPnlLamports,
      unrealizedPnlLamports,
      positions,
    };
  }
}
