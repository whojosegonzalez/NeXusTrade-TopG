import type { ProviderResult, TokenMintAddress, TokenPriceSnapshot } from "@nexustrade/shared";

import type { ProviderAdapter } from "./ProviderAdapter.js";

export interface PriceProvider extends ProviderAdapter {
  readonly getPrice: (mintAddress: TokenMintAddress) => Promise<ProviderResult<TokenPriceSnapshot>>;
  readonly getPrices?: (
    mintAddresses: readonly TokenMintAddress[],
  ) => Promise<ProviderResult<readonly TokenPriceSnapshot[]>>;
}
