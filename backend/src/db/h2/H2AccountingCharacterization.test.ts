import { afterEach, describe, expect, it } from "vitest";
import { defaultPaperExchangeConfig } from "../../paper/PaperExchangeConfig.js";
import { buildPaperQuote } from "../../paper/PaperFillFactory.js";
import {
  calculateTokensFilled,
  calculateGrossProceedsLamports,
  calculateSlippageLamports,
} from "../../paper/PaperMath.js";
import { PaperSellAccountingService } from "../../paper/PaperSellAccountingService.js";
import { defaultPaperSellConfig } from "../../paper/PaperSellConfig.js";
import { buildSellFillInput } from "../../paper/PaperSellFillFactory.js";
import { h2Fixture } from "./H2Fixtures.js";

let fixture: ReturnType<typeof h2Fixture> | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});
describe("H2 existing economic conventions", () => {
  it("preserves BUY principal, slippage, fees, and the zero-cost-policy control", () => {
    fixture = h2Fixture();
    const candidate = { tokenRadar: fixture.radar, strategyDecision: fixture.decision };
    const config = defaultPaperExchangeConfig();
    expect(buildPaperQuote({ candidate, config })).toMatchObject({
      requestedSolLamports: 10_000_000,
      estimatedSlippageLamports: 100_000,
      estimatedBaseFeeLamports: 5_000,
      totalCostLamports: 10_105_000,
    });
    expect(
      buildPaperQuote({
        candidate,
        config: { ...config, baseFeeLamports: 0, priorityFeeLamports: 0, slippageBps: 0 },
      })?.totalCostLamports,
    ).toBe(10_000_000);
  });
  it("preserves decimal truncation and upward slippage rounding", () => {
    expect(calculateTokensFilled(1, "0.000000003")).toBe("0.333333333333");
    expect(calculateGrossProceedsLamports("0.000000001", "1.999999999")).toBe(1);
    expect(calculateSlippageLamports(1, 1)).toBe(1);
    expect(calculateSlippageLamports(Number.MAX_SAFE_INTEGER, 9999)).toBe(
      Number((BigInt(Number.MAX_SAFE_INTEGER) * 9999n + 9999n) / 10000n),
    );
    expect(() => calculateSlippageLamports(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(
      "INVALID_AMOUNT",
    );
  });
  it("preserves negative realized P/L and already-net SELL fill proceeds", () => {
    fixture = h2Fixture();
    const position = fixture.repositories.positions.openPosition({
      sessionId: fixture.session.id,
      mintAddress: fixture.radar.mintAddress,
      openedAtMs: 1000,
      tokensHeld: "10",
      costBasisLamports: 10_100_000,
      feesPaidLamports: 5_000,
    });
    const quote = {
      priceSource: "QUOTE" as const,
      quoteSource: "FAKE",
      priceSol: "0.0005",
      tokensSold: "10",
      grossProceedsLamports: 5_000_000,
      fallbackUsed: false,
      warnings: [],
    };
    const config = defaultPaperSellConfig({ type: "SELL_ALL" });
    const accounting = new PaperSellAccountingService().calculate({ position, quote, config });
    expect(accounting).toMatchObject({
      netSellProceedsLamports: 4_945_000,
      realizedPnlLamports: -5_160_000,
      sellFeesLamports: 5_000,
      sellSlippageLamports: 50_000,
      totalFeesPaidLamports: 10_000,
    });
    if (!accounting) throw new Error("Expected positive net proceeds despite a realized loss");
    expect(
      buildSellFillInput({
        orderId: "fixture-order",
        candidate: { session: fixture.session, position },
        quote,
        accounting,
        config,
        filledAtMs: 2000,
      }),
    ).toMatchObject({
      solReceivedLamports: 4_945_000,
      estimatedBaseFeeLamports: 5_000,
      estimatedSlippageLamports: 50_000,
    });
  });
});
