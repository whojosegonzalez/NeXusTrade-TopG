import {
  isSolanaMintAddress,
  parseTokenMintAddress,
  type QuoteResult,
  type QuoteRouteHop,
} from "@nexustrade/shared";

import type { RaydiumQuoteSuccessResponse } from "./raydium.schemas.js";

function optionalNumber(value: number | string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function mapRaydiumQuote(
  response: RaydiumQuoteSuccessResponse,
  fetchedAt: Date,
): QuoteResult {
  const data = response.data;
  const estimatedPriceImpactPct = optionalNumber(data.priceImpactPct);
  const routeSummary: QuoteRouteHop[] =
    data.routePlan
      ?.map((hop) => {
        const inputMint = hop.inputMint;
        const outputMint = hop.outputMint;

        return {
          ...(hop.poolId ? { label: hop.poolId } : {}),
          ...(inputMint && isSolanaMintAddress(inputMint)
            ? { inputMint: parseTokenMintAddress(inputMint) }
            : {}),
          ...(outputMint && isSolanaMintAddress(outputMint)
            ? { outputMint: parseTokenMintAddress(outputMint) }
            : {}),
        };
      })
      .filter((hop) => Object.keys(hop).length > 0) ?? [];

  return {
    inputMint: parseTokenMintAddress(data.inputMint),
    outputMint: parseTokenMintAddress(data.outputMint),
    inputAmountRaw: data.inputAmount,
    outputAmountRaw: data.outputAmount,
    source: "RAYDIUM",
    fetchedAt,
    provenance: {
      quoteProvider: "RAYDIUM",
      quoteSourceType: "LIVE",
      fallbackReason: "NONE",
    },
    ...(response.id ? { rawReferenceId: response.id } : {}),
    ...(estimatedPriceImpactPct !== undefined ? { estimatedPriceImpactPct } : {}),
    ...(routeSummary.length > 0 ? { routeSummary } : {}),
    ...(data.otherAmountThreshold ? { minimumOutAmountRaw: data.otherAmountThreshold } : {}),
  };
}
