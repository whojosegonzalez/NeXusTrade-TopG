import { describe, expect, it } from "vitest";

import { parseTokenMintAddress } from "@nexustrade/shared";

import { mapJupiterPrice, mapJupiterPriceToMetadata, mapJupiterQuote } from "./jupiter.mappers.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("Jupiter mappers", () => {
  it("normalizes price and partial metadata entries", () => {
    const fetchedAt = new Date("2026-06-20T12:00:00.000Z");
    const mint = parseTokenMintAddress(SOL_MINT);
    const price = mapJupiterPrice(mint, { usdPrice: 140, decimals: 9, blockId: 123 }, fetchedAt);
    const metadata = mapJupiterPriceToMetadata(mint, { decimals: 9 }, fetchedAt);

    expect(price.priceUsd).toBe(140);
    expect(price.rawReferenceId).toBe("123");
    expect(metadata.decimals).toBe(9);
  });

  it("normalizes quote responses", () => {
    const quote = mapJupiterQuote(
      {
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        inAmount: "100000000",
        outAmount: "14000000",
        otherAmountThreshold: "13800000",
        priceImpactPct: "0.01",
        contextSlot: 123,
        routePlan: [
          {
            swapInfo: {
              label: "Raydium",
              inputMint: SOL_MINT,
              outputMint: USDC_MINT,
            },
            percent: 100,
            bps: null,
          },
        ],
      },
      new Date("2026-06-20T12:00:00.000Z"),
    );

    expect(quote.outputAmountRaw).toBe("14000000");
    expect(quote.minimumOutAmountRaw).toBe("13800000");
    expect(quote.routeSummary?.[0]?.label).toBe("Raydium");
    expect(quote.provenance).toMatchObject({
      quoteProvider: "JUPITER",
      quoteSourceType: "LIVE",
      fallbackReason: "NONE",
    });
  });
});
