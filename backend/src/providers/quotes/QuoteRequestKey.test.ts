import { describe, expect, it } from "vitest";

import { parseTokenMintAddress, type QuoteRequest } from "@nexustrade/shared";

import { buildQuoteRequestKey } from "./QuoteRequestKey.js";

const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const USDC_MINT = parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const request: QuoteRequest = {
  inputMint: SOL_MINT,
  outputMint: USDC_MINT,
  amountRaw: "10000000",
  side: "BUY",
  slippageBps: 100,
};

describe("buildQuoteRequestKey", () => {
  it("builds stable keys for equivalent requests", () => {
    expect(buildQuoteRequestKey({ provider: "JUPITER", request })).toBe(
      buildQuoteRequestKey({ provider: "JUPITER", request: { ...request } }),
    );
  });

  it("separates amount, slippage, and provider", () => {
    const base = buildQuoteRequestKey({ provider: "JUPITER", request });

    expect(
      buildQuoteRequestKey({
        provider: "JUPITER",
        request: { ...request, amountRaw: "20000000" },
      }),
    ).not.toBe(base);
    expect(
      buildQuoteRequestKey({
        provider: "JUPITER",
        request: { ...request, slippageBps: 50 },
      }),
    ).not.toBe(base);
    expect(buildQuoteRequestKey({ provider: "MOCK", request })).not.toBe(base);
  });
});
