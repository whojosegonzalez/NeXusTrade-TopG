import type { ProviderResult, TokenIdentity } from "@nexustrade/shared";

import type { ProviderAdapter } from "./ProviderAdapter.js";

export interface TokenDiscoveryProvider extends ProviderAdapter {
  readonly discoverTokens: (limit?: number) => Promise<ProviderResult<readonly TokenIdentity[]>>;
}
