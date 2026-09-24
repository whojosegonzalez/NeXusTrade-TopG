import { describe, expect, it } from "vitest";

import { mapRaydiumQuote } from "./raydium.mappers.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("Raydium mappers", () => {
  it("normalizes swap-base-in quote responses", () => {
    const quote = mapRaydiumQuote(
      {
        id: "quote-1",
        success: true,
        version: "V1",
        data: {
          inputMint: SOL_MINT,
          inputAmount: "100000000",
          outputMint: USDC_MINT,
          outputAmount: "14000000",
          otherAmountThreshold: "13860000",
          slippageBps: 100,
          priceImpactPct: "0.25",
          routePlan: [
            {
              poolId: "pool-1",
              inputMint: SOL_MINT,
              outputMint: USDC_MINT,
              feeMint: SOL_MINT,
              feeRate: 1,
              feeAmount: "10000",
            },
          ],
        },
      },
      new Date("2026-07-15T00:00:00.000Z"),
    );

    expect(quote.source).toBe("RAYDIUM");
    expect(quote.outputAmountRaw).toBe("14000000");
    expect(quote.minimumOutAmountRaw).toBe("13860000");
    expect(quote.estimatedPriceImpactPct).toBe(0.25);
    expect(quote.rawReferenceId).toBe("quote-1");
    expect(quote.routeSummary?.[0]?.label).toBe("pool-1");
    expect(quote.provenance).toMatchObject({
      quoteProvider: "RAYDIUM",
      quoteSourceType: "LIVE",
      fallbackReason: "NONE",
    });
  });

  it("handles numeric price impact and empty routes", () => {
    const quote = mapRaydiumQuote(
      {
        success: true,
        data: {
          inputMint: SOL_MINT,
          inputAmount: "100000000",
          outputMint: USDC_MINT,
          outputAmount: "14000000",
          priceImpactPct: 0,
          routePlan: [],
        },
      },
      new Date("2026-07-15T00:00:00.000Z"),
    );

    expect(quote.estimatedPriceImpactPct).toBe(0);
    expect(quote.routeSummary).toBeUndefined();
  });
});
