import type { PositionRecord } from "../db/schema/index.js";
import type { PaperSellRuntimeConfig } from "./PaperSellConfig.js";
import type { PaperSellQuoteContext } from "./PaperSellQuoteService.js";
import { calculateSlippageLamports } from "./PaperMath.js";

export interface PaperSellAccountingResult {
  readonly grossProceedsLamports: number;
  readonly netSellProceedsLamports: number;
  readonly sellFeesLamports: number;
  readonly sellSlippageLamports: number;
  readonly realizedPnlLamports: number;
  readonly realizedPnlBps?: number;
  readonly totalFeesPaidLamports: number;
}

export class PaperSellAccountingService {
  calculate(input: {
    readonly position: PositionRecord;
    readonly quote: PaperSellQuoteContext;
    readonly config: PaperSellRuntimeConfig;
  }): PaperSellAccountingResult | undefined {
    if (
      ![
        input.config.baseFeeLamports,
        input.config.priorityFeeLamports,
        input.quote.grossProceedsLamports,
        input.position.costBasisLamports,
        input.position.feesPaidLamports,
      ].every((value) => Number.isSafeInteger(value) && value >= 0)
    )
      throw new Error("ACCOUNTING_INVALID_AMOUNT");
    const sellFeesLamports = safeAmount(
      BigInt(input.config.baseFeeLamports) + BigInt(input.config.priorityFeeLamports),
    );
    const sellSlippageLamports = calculateSlippageLamports(
      input.quote.grossProceedsLamports,
      input.config.slippageBps,
    );
    const netSellProceedsLamports = safeAmount(
      BigInt(input.quote.grossProceedsLamports) -
        BigInt(sellFeesLamports) -
        BigInt(sellSlippageLamports),
    );

    if (netSellProceedsLamports <= 0) {
      return undefined;
    }

    const realizedPnlLamports = safeAmount(
      BigInt(netSellProceedsLamports) -
        BigInt(input.position.costBasisLamports) -
        BigInt(input.position.feesPaidLamports),
    );
    const basisLamports =
      BigInt(input.position.costBasisLamports) + BigInt(input.position.feesPaidLamports);
    const realizedPnlBps =
      basisLamports > 0n
        ? safeAmount(roundRatio(BigInt(realizedPnlLamports) * 10_000n, basisLamports))
        : undefined;

    return {
      grossProceedsLamports: input.quote.grossProceedsLamports,
      netSellProceedsLamports,
      sellFeesLamports,
      sellSlippageLamports,
      realizedPnlLamports,
      ...(realizedPnlBps !== undefined ? { realizedPnlBps } : {}),
      totalFeesPaidLamports: safeAmount(
        BigInt(input.position.feesPaidLamports) + BigInt(sellFeesLamports),
      ),
    };
  }
}

function safeAmount(value: bigint): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > max || value < -max) throw new Error("ACCOUNTING_INVALID_AMOUNT");
  return Number(value);
}
// Match Math.round's ties toward positive infinity without floating-point multiplication.
function roundRatio(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder >= 0n) return quotient + (remainder * 2n >= denominator ? 1n : 0n);
  return quotient + (-remainder * 2n > denominator ? -1n : 0n);
}
