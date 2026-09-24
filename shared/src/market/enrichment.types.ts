import type { ProviderName } from "../providers/provider.types.js";
import type { DexPairSnapshot } from "./liquidity.types.js";
import type { TokenMetadataSnapshot } from "./metadata.types.js";
import type { TokenPriceSnapshot } from "./price.types.js";
import type { QuoteResult } from "./quote.types.js";
import type { RiskEvidenceSnapshot } from "./risk-evidence.types.js";
import type { TokenIdentity } from "./token.types.js";

export interface TokenEnrichmentSnapshot {
  readonly identity: TokenIdentity;
  readonly price?: TokenPriceSnapshot;
  readonly bestPair?: DexPairSnapshot;
  readonly metadata?: TokenMetadataSnapshot;
  readonly riskEvidence?: RiskEvidenceSnapshot;
  readonly buyQuote?: QuoteResult;
  readonly sellQuote?: QuoteResult;
  readonly sourcesUsed: readonly ProviderName[];
  readonly warnings: readonly string[];
  readonly fetchedAt: Date;
}

export function mergeTokenEnrichmentSources(
  existing: readonly ProviderName[],
  next: ProviderName | undefined,
): readonly ProviderName[] {
  if (!next || existing.includes(next)) {
    return existing;
  }

  return [...existing, next];
}
