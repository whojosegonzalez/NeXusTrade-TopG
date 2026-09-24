import type { ProviderName } from "../providers/provider.types.js";
import type { TokenMintAddress, TokenSymbol } from "./token.types.js";

export type PriceConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface TokenPriceSnapshot {
  readonly mintAddress: TokenMintAddress;
  readonly symbol?: TokenSymbol;
  readonly priceUsd?: number;
  readonly priceSol?: number;
  readonly source: ProviderName;
  readonly fetchedAt: Date;
  readonly confidence?: PriceConfidence;
  readonly rawReferenceId?: string;
}
