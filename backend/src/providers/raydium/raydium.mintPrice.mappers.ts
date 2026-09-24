import type { RaydiumMintPriceResponse } from "./raydium.mintPrice.schemas.js";

export function raydiumMintPriceKnown(
  response: RaydiumMintPriceResponse,
  mintAddress: string,
): boolean {
  const value = response.data?.[mintAddress];

  return typeof value === "string" && value.trim().length > 0;
}
