import { describe, expect, it } from "vitest";

import { parseTokenMintAddress } from "@nexustrade/shared";

import { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { RaydiumAdapter } from "./RaydiumAdapter.js";

const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const USDC_MINT = parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

describe("RaydiumAdapter", () => {
  it("builds swap-base-in quote requests and maps successful responses", async () => {
    let requestedUrl = "";
    const adapter = createAdapter(async (input) => {
      requestedUrl = String(input);

      return jsonResponse({
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
          priceImpactPct: 0.1,
          routePlan: [],
        },
      });
    });

    const result = await adapter.getQuote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amountRaw: "100000000",
      slippageBps: 100,
    });

    expect(result.ok).toBe(true);
    expect(requestedUrl).toBe(
      "https://transaction-v1.raydium.io/compute/swap-base-in?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000&slippageBps=100&txVersion=V0",
    );
    expect(result.ok ? result.data.source : undefined).toBe("RAYDIUM");
    expect(result.ok ? result.data.provenance?.quoteProvider : undefined).toBe("RAYDIUM");
  });

  it("returns provider failures for unsuccessful Raydium responses", async () => {
    const adapter = createAdapter(async () =>
      jsonResponse({
        id: "quote-1",
        success: false,
        msg: "REQ_AMOUNT_ERROR",
      }),
    );

    const result = await adapter.getQuote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amountRaw: "100000000",
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("BAD_REQUEST");
    expect(result.diagnostics).toMatchObject({
      raydiumFailureCategory: "BAD_AMOUNT",
      raydiumFailureDetail: "REQ_AMOUNT_ERROR",
    });
  });

  it("returns invalid response failures when output amount is missing", async () => {
    const adapter = createAdapter(async () =>
      jsonResponse({
        id: "quote-1",
        success: true,
        data: {
          inputMint: SOL_MINT,
          inputAmount: "100000000",
          outputMint: USDC_MINT,
        },
      }),
    );

    const result = await adapter.getQuote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amountRaw: "100000000",
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("INVALID_RESPONSE");
  });

  it("does not call Raydium transaction endpoints", async () => {
    const requestedUrls: string[] = [];
    const adapter = createAdapter(async (input) => {
      requestedUrls.push(String(input));

      return jsonResponse({
        success: true,
        data: {
          inputMint: SOL_MINT,
          inputAmount: "100000000",
          outputMint: USDC_MINT,
          outputAmount: "14000000",
        },
      });
    });

    await adapter.getQuote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amountRaw: "100000000",
      onlyDirectRoutes: true,
      maxAccounts: 12,
    });

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain("/compute/swap-base-in");
    expect(requestedUrls[0]).not.toContain("/transaction/");
  });
});

function createAdapter(fetchImpl: typeof fetch): RaydiumAdapter {
  return new RaydiumAdapter({
    httpClient: new ProviderHttpClient({
      provider: "RAYDIUM",
      baseUrl: "https://transaction-v1.raydium.io",
      timeoutMs: 1_000,
      rateLimitPerMinute: 60,
      fetchImpl,
    }),
    maxRetries: 0,
    retryBackoffMs: 0,
    allowRawPayloadLogging: false,
    txVersion: "V0",
    diagnosticsEnabled: true,
    mintPriceDiagnosticsEnabled: false,
    captureSanitizedErrorContext: true,
    maxErrorMessageLength: 240,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}
