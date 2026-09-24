import type { Repositories } from "../db/repositories/index.js";
import { stringifyJson } from "../db/utils/json.js";
import type { EquityCalculationResult } from "./EquityCalculationService.js";
import type { DrawdownEvaluation } from "./DrawdownTrackingService.js";

export interface SnapshotWriteResult {
  readonly equitySnapshotCreated: boolean;
  readonly positionSnapshotCount: number;
}

export class SnapshotService {
  constructor(private readonly repositories: Pick<Repositories, "snapshots">) {}

  createSnapshots(input: {
    readonly sessionId: string;
    readonly timestampMs: number;
    readonly equity: EquityCalculationResult;
    readonly drawdown: DrawdownEvaluation;
    readonly dryRun: boolean;
  }): SnapshotWriteResult {
    if (input.dryRun) {
      return {
        equitySnapshotCreated: false,
        positionSnapshotCount: 0,
      };
    }

    let positionSnapshotCount = 0;

    for (const position of input.equity.positions) {
      this.repositories.snapshots.createPositionSnapshot({
        positionId: position.valuation.position.id,
        sessionId: input.sessionId,
        timestampMs: input.timestampMs,
        ...(position.valuation.markPriceSol
          ? { markPriceSol: position.valuation.markPriceSol }
          : {}),
        sellQuoteLamports: position.valuation.marketValueLamports,
        unrealizedPnlLamports: position.unrealizedPnlLamports,
        ...(position.unrealizedPnlBps !== undefined
          ? { unrealizedPnlBps: position.unrealizedPnlBps }
          : {}),
        ...(position.valuation.liquidityUsd
          ? { liquidityUsd: position.valuation.liquidityUsd }
          : {}),
        rawQuoteJson: stringifyJson({
          phase: "PHASE_8_SESSION_MANAGER",
          mintAddress: position.valuation.position.mintAddress,
          tokensHeld: position.valuation.position.tokensHeld,
          valuationSource: position.valuation.valuationSource,
          quoteSource: position.valuation.quoteSource,
          provider: position.valuation.provider,
          marketValueLamports: position.valuation.marketValueLamports,
          markPriceSol: position.valuation.markPriceSol,
          priceUsd: position.valuation.priceUsd,
          liquidityUsd: position.valuation.liquidityUsd,
          priceImpactBps: position.valuation.priceImpactBps,
          quoteFetchedAtMs: position.valuation.quoteFetchedAtMs,
          priceFetchedAtMs: position.valuation.priceFetchedAtMs,
          cachedPriceAgeMs: position.valuation.cachedPriceAgeMs,
          tokenDecimals: position.valuation.tokenDecimals,
          tokenAmountRaw: position.valuation.tokenAmountRaw,
          fallbackUsed: position.valuation.fallbackUsed,
          fallbackReason: position.valuation.fallbackReason,
          valuationUnavailable: position.valuation.valuationUnavailable,
          warnings: position.valuation.warnings,
        }),
      });
      positionSnapshotCount += 1;
    }

    this.repositories.snapshots.createEquitySnapshot({
      sessionId: input.sessionId,
      timestampMs: input.timestampMs,
      cashLamports: input.equity.cashLamports,
      openPositionValueLamports: input.equity.openPositionValueLamports,
      totalEquityLamports: input.equity.totalEquityLamports,
      realizedPnlLamports: input.equity.realizedPnlLamports,
      unrealizedPnlLamports: input.equity.unrealizedPnlLamports,
      drawdownLamports: input.drawdown.drawdownLamports,
    });

    return {
      equitySnapshotCreated: true,
      positionSnapshotCount,
    };
  }
}
