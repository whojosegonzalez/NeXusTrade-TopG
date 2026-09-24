import type { ProviderResult, RiskEvidenceSnapshot, TokenMintAddress } from "@nexustrade/shared";

import type { ProviderAdapter } from "./ProviderAdapter.js";

export interface RiskEvidenceProvider extends ProviderAdapter {
  readonly getRiskEvidence: (
    mintAddress: TokenMintAddress,
  ) => Promise<ProviderResult<RiskEvidenceSnapshot>>;
}
