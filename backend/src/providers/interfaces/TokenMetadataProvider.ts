import type { ProviderResult, TokenMetadataSnapshot, TokenMintAddress } from "@nexustrade/shared";

import type { ProviderAdapter } from "./ProviderAdapter.js";

export interface TokenMetadataProvider extends ProviderAdapter {
  readonly getTokenMetadata: (
    mintAddress: TokenMintAddress,
  ) => Promise<ProviderResult<TokenMetadataSnapshot>>;
}
