import {
  mergeTokenEnrichmentSources,
  providerSuccess,
  type DexPairSnapshot,
  type ProviderName,
  type ProviderResult,
  type QuoteRequest,
  type QuoteResult,
  type RiskEvidenceSnapshot,
  type TokenEnrichmentSnapshot,
  type TokenMetadataSnapshot,
  type TokenMintAddress,
  type TokenPriceSnapshot,
} from "@nexustrade/shared";

import type { ProviderRegistry } from "./ProviderRegistry.js";
import type {
  LiquidityProvider,
  PriceProvider,
  QuoteProvider,
  RiskEvidenceProvider,
  TokenMetadataProvider,
} from "./interfaces/index.js";

export interface TokenEnrichmentRequest {
  readonly mintAddress: TokenMintAddress;
  readonly buyQuoteRequest?: QuoteRequest;
  readonly sellQuoteRequest?: QuoteRequest;
}

export class MarketDataService {
  constructor(private readonly registry: ProviderRegistry) {}

  async enrichToken(
    request: TokenEnrichmentRequest,
  ): Promise<ProviderResult<TokenEnrichmentSnapshot>> {
    const warnings: string[] = [];
    let sourcesUsed: readonly ProviderName[] = [];
    const fetchedAt = new Date();
    const price = await firstSuccessful(
      this.registry.getPriceProviders(),
      (provider) => provider.getPrice(request.mintAddress),
      warnings,
    );
    const bestPair = await firstSuccessful(
      this.registry.getLiquidityProviders(),
      (provider) => provider.getBestPairForToken(request.mintAddress),
      warnings,
    );
    const metadata = await firstSuccessful(
      this.registry.getTokenMetadataProviders(),
      (provider) => provider.getTokenMetadata(request.mintAddress),
      warnings,
    );
    const riskEvidence = await firstSuccessful(
      this.registry.getRiskEvidenceProviders(),
      (provider) => provider.getRiskEvidence(request.mintAddress),
      warnings,
    );
    const buyQuote = request.buyQuoteRequest
      ? await firstSuccessful(
          this.registry.getQuoteProviders(),
          (provider) =>
            getQuoteWithAvailableVenueEvidence(
              provider,
              request.buyQuoteRequest as QuoteRequest,
              bestPair?.dexId,
            ),
          warnings,
        )
      : undefined;
    const sellQuote = request.sellQuoteRequest
      ? await firstSuccessful(
          this.registry.getQuoteProviders(),
          (provider) =>
            getQuoteWithAvailableVenueEvidence(
              provider,
              request.sellQuoteRequest as QuoteRequest,
              bestPair?.dexId,
            ),
          warnings,
        )
      : undefined;

    for (const source of [
      price?.source,
      bestPair?.source,
      metadata?.source,
      riskEvidence?.source,
      buyQuote?.source,
      sellQuote?.source,
    ]) {
      sourcesUsed = mergeTokenEnrichmentSources(sourcesUsed, source);
    }

    const identitySymbol = metadata?.symbol ?? price?.symbol ?? bestPair?.baseSymbol;

    return providerSuccess({
      provider: sourcesUsed[0] ?? "MOCK",
      data: {
        identity: {
          chainId: "solana",
          mintAddress: request.mintAddress,
          ...(identitySymbol ? { symbol: identitySymbol } : {}),
          ...(metadata?.name ? { name: metadata.name } : {}),
          ...(metadata?.decimals !== undefined ? { decimals: metadata.decimals } : {}),
          ...(metadata?.imageUri ? { logoUri: metadata.imageUri } : {}),
          ...(metadata?.tokenProgram ? { tokenProgram: metadata.tokenProgram } : {}),
        },
        ...(price ? { price } : {}),
        ...(bestPair ? { bestPair } : {}),
        ...(metadata ? { metadata } : {}),
        ...(riskEvidence ? { riskEvidence } : {}),
        ...(buyQuote ? { buyQuote } : {}),
        ...(sellQuote ? { sellQuote } : {}),
        sourcesUsed,
        warnings,
        fetchedAt,
      },
      fetchedAt,
      warnings,
    });
  }
}

async function firstSuccessful<TProvider, TResult>(
  providers: readonly TProvider[],
  request: (provider: TProvider) => Promise<ProviderResult<TResult>>,
  warnings: string[],
): Promise<TResult | undefined> {
  for (const provider of providers) {
    const result = await request(provider);

    warnings.push(...result.warnings);

    if (result.ok) {
      return result.data;
    }

    warnings.push(`${result.provider}: ${result.error.code} - ${result.error.message}`);
  }

  return undefined;
}

export type MarketDataProvider =
  | LiquidityProvider
  | PriceProvider
  | QuoteProvider
  | RiskEvidenceProvider
  | TokenMetadataProvider;

export type MarketDataServiceResult = ProviderResult<TokenEnrichmentSnapshot>;
export type MarketDataServiceQuote = QuoteResult;
export type MarketDataServicePrice = TokenPriceSnapshot;
export type MarketDataServicePair = DexPairSnapshot;
export type MarketDataServiceMetadata = TokenMetadataSnapshot;
export type MarketDataServiceRiskEvidence = RiskEvidenceSnapshot;

function getQuoteWithAvailableVenueEvidence(
  provider: QuoteProvider,
  request: QuoteRequest,
  dexId: string | undefined,
): Promise<ProviderResult<QuoteResult>> {
  if ("getQuoteWithContext" in provider && typeof provider.getQuoteWithContext === "function") {
    return provider.getQuoteWithContext(request, {
      ...(dexId ? { raydiumObservedDexIds: [dexId] } : {}),
    });
  }

  return provider.getQuote(request);
}
