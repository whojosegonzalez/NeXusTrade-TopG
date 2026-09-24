import type { DexPairSnapshot, ProviderResult, TokenMintAddress } from "@nexustrade/shared";

import type { ProviderAdapter } from "./ProviderAdapter.js";

export interface LiquidityProvider extends ProviderAdapter {
  readonly getPairsForToken: (
    mintAddress: TokenMintAddress,
  ) => Promise<ProviderResult<readonly DexPairSnapshot[]>>;
  readonly getBestPairForToken: (
    mintAddress: TokenMintAddress,
  ) => Promise<ProviderResult<DexPairSnapshot>>;
}
