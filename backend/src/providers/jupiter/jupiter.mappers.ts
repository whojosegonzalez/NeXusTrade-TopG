import {
  isSolanaMintAddress,
  parseTokenMintAddress,
  type QuoteResult,
  type QuoteRouteHop,
  type TokenMetadataSnapshot,
  type TokenMintAddress,
  type TokenPriceSnapshot,
} from "@nexustrade/shared";

import type { JupiterPriceEntry, JupiterQuoteResponse } from "./jupiter.schemas.js";

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function mapJupiterPrice(
  mintAddress: TokenMintAddress,
  entry: JupiterPriceEntry,
  fetchedAt: Date,
): TokenPriceSnapshot {
  return {
    mintAddress,
    source: "JUPITER",
    fetchedAt,
    confidence: entry.usdPrice === undefined ? "UNKNOWN" : "HIGH",
    ...(entry.usdPrice !== undefined ? { priceUsd: entry.usdPrice } : {}),
    ...(entry.blockId !== undefined ? { rawReferenceId: String(entry.blockId) } : {}),
  };
}

export function mapJupiterPriceToMetadata(
  mintAddress: TokenMintAddress,
  entry: JupiterPriceEntry,
  fetchedAt: Date,
): TokenMetadataSnapshot {
  return {
    mintAddress,
    source: "JUPITER",
    fetchedAt,
    ...(entry.decimals !== undefined ? { decimals: entry.decimals } : {}),
  };
}

export function mapJupiterQuote(response: JupiterQuoteResponse, fetchedAt: Date): QuoteResult {
  const estimatedPriceImpactPct = optionalNumber(response.priceImpactPct);
  const routeSummary: QuoteRouteHop[] =
    response.routePlan
      ?.map((route) => {
        const inputMint = route.swapInfo?.inputMint;
        const outputMint = route.swapInfo?.outputMint;

        return {
          ...(route.swapInfo?.label ? { label: route.swapInfo.label } : {}),
          ...(inputMint && isSolanaMintAddress(inputMint)
            ? { inputMint: parseTokenMintAddress(inputMint) }
            : {}),
          ...(outputMint && isSolanaMintAddress(outputMint)
            ? { outputMint: parseTokenMintAddress(outputMint) }
            : {}),
          ...(route.percent !== undefined ? { percent: route.percent } : {}),
        };
      })
      .filter((route) => Object.keys(route).length > 0) ?? [];

  return {
    inputMint: parseTokenMintAddress(response.inputMint),
    outputMint: parseTokenMintAddress(response.outputMint),
    inputAmountRaw: response.inAmount,
    outputAmountRaw: response.outAmount,
    source: "JUPITER",
    fetchedAt,
    provenance: {
      quoteProvider: "JUPITER",
      quoteSourceType: "LIVE",
      fallbackReason: "NONE",
    },
    ...(estimatedPriceImpactPct !== undefined ? { estimatedPriceImpactPct } : {}),
    ...(routeSummary.length > 0 ? { routeSummary } : {}),
    ...(response.otherAmountThreshold
      ? { minimumOutAmountRaw: response.otherAmountThreshold }
      : {}),
    ...(response.contextSlot !== undefined ? { contextSlot: response.contextSlot } : {}),
  };
}
