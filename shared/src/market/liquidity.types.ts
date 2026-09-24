import type { ProviderName } from "../providers/provider.types.js";
import type { ChainId, TokenMintAddress, TokenSymbol } from "./token.types.js";

export interface DexPairSnapshot {
  readonly chainId: ChainId;
  readonly dexId: string;
  readonly pairAddress: string;
  readonly baseMint: TokenMintAddress;
  readonly quoteMint: TokenMintAddress;
  readonly baseSymbol?: TokenSymbol;
  readonly quoteSymbol?: TokenSymbol;
  readonly priceUsd?: number;
  readonly priceNative?: number;
  readonly liquidityUsd?: number;
  readonly volume5m?: number;
  readonly volume1h?: number;
  readonly volume6h?: number;
  readonly volume24h?: number;
  readonly txns5mBuys?: number;
  readonly txns5mSells?: number;
  readonly pairCreatedAt?: Date;
  readonly source: ProviderName;
  readonly fetchedAt: Date;
}
