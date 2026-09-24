import {
  createProviderError,
  providerFailure,
  providerSuccess,
  type DexPairSnapshot,
  type ProviderCapability,
  type ProviderResult,
  type ProviderSuccess,
  type TokenIdentity,
  type TokenMintAddress,
  type TokenPriceSnapshot,
} from "@nexustrade/shared";

import type { ProviderHealthService } from "../ProviderHealthService.js";
import type {
  LiquidityProvider,
  PriceProvider,
  TokenDiscoveryProvider,
} from "../interfaces/index.js";
import type { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { withProviderRetries } from "../http/providerRetry.js";
import {
  dexScreenerPairListSchema,
  dexScreenerTokenProfileListSchema,
  dexScreenerWrappedPairsSchema,
  type DexScreenerPair,
  type DexScreenerTokenProfile,
} from "./dexscreener.schemas.js";
import {
  mapDexScreenerPairToPrice,
  mapDexScreenerPairs,
  mapDexScreenerTokenProfiles,
  selectBestDexScreenerPair,
} from "./dexscreener.mappers.js";

export interface DexScreenerAdapterOptions {
  readonly httpClient: ProviderHttpClient;
  readonly healthService?: ProviderHealthService;
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly allowRawPayloadLogging: boolean;
}

export class DexScreenerAdapter
  implements LiquidityProvider, PriceProvider, TokenDiscoveryProvider
{
  readonly name = "DEXSCREENER" as const;
  readonly capabilities: readonly ProviderCapability[] = ["PRICE", "LIQUIDITY", "TOKEN_DISCOVERY"];

  constructor(private readonly options: DexScreenerAdapterOptions) {}

  async getPairsForToken(
    mintAddress: TokenMintAddress,
  ): Promise<ProviderResult<readonly DexPairSnapshot[]>> {
    return this.execute("token-pairs", async () => {
      const httpResult = await this.options.httpClient.getJson<unknown>({
        path: `token-pairs/v1/solana/${mintAddress}`,
        allowRawPayloadLogging: this.options.allowRawPayloadLogging,
      });

      return this.mapPairsResult(httpResult, "Expected DexScreener token pairs array.");
    });
  }

  async getBestPairForToken(
    mintAddress: TokenMintAddress,
  ): Promise<ProviderResult<DexPairSnapshot>> {
    const pairsResult = await this.getPairsForToken(mintAddress);

    if (!pairsResult.ok) {
      return pairsResult;
    }

    const bestPair = selectBestDexScreenerPair(pairsResult.data);

    if (!bestPair) {
      return providerFailure({
        provider: this.name,
        error: createProviderError({
          code: "NOT_FOUND",
          message: `No DexScreener Solana pairs found for ${mintAddress}.`,
          retryable: false,
        }),
        fetchedAt: pairsResult.fetchedAt,
        latencyMs: pairsResult.latencyMs,
        warnings: pairsResult.warnings,
      });
    }

    return providerSuccess({
      provider: this.name,
      data: bestPair,
      fetchedAt: pairsResult.fetchedAt,
      latencyMs: pairsResult.latencyMs,
      warnings: pairsResult.warnings,
    });
  }

  async getPrice(mintAddress: TokenMintAddress): Promise<ProviderResult<TokenPriceSnapshot>> {
    const pairResult = await this.getBestPairForToken(mintAddress);

    if (!pairResult.ok) {
      return providerFailure({
        provider: this.name,
        error: pairResult.error,
        fetchedAt: pairResult.fetchedAt,
        latencyMs: pairResult.latencyMs,
        rateLimited: pairResult.rateLimited,
        warnings: pairResult.warnings,
      });
    }

    return providerSuccess({
      provider: this.name,
      data: mapDexScreenerPairToPrice(pairResult.data, mintAddress),
      fetchedAt: pairResult.fetchedAt,
      latencyMs: pairResult.latencyMs,
      warnings: pairResult.warnings,
    });
  }

  async discoverTokens(limit = 20): Promise<ProviderResult<readonly TokenIdentity[]>> {
    return this.execute("token-profiles-latest", async () => {
      const httpResult = await this.options.httpClient.getJson<unknown>({
        path: "token-profiles/latest/v1",
        allowRawPayloadLogging: this.options.allowRawPayloadLogging,
      });

      if (!httpResult.ok) {
        return httpResult;
      }

      const parsed = dexScreenerTokenProfileListSchema.safeParse(httpResult.data);

      if (!parsed.success) {
        return this.invalidResponse<readonly TokenIdentity[]>(
          httpResult,
          "Expected DexScreener token profile list.",
        );
      }

      const profiles = normalizeProfilePayload(parsed.data);

      return providerSuccess({
        provider: this.name,
        data: mapDexScreenerTokenProfiles(profiles).slice(0, limit),
        fetchedAt: httpResult.fetchedAt,
        latencyMs: httpResult.latencyMs,
        warnings: httpResult.warnings,
        raw: this.options.allowRawPayloadLogging ? httpResult.data : undefined,
      });
    });
  }

  private async execute<T>(
    operation: string,
    request: () => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    const result = await withProviderRetries(request, {
      maxRetries: this.options.maxRetries,
      retryBackoffMs: this.options.retryBackoffMs,
    });

    this.options.healthService?.recordResult(operation, result);

    return result;
  }

  private mapPairsResult(
    httpResult: ProviderResult<unknown>,
    invalidMessage: string,
  ): ProviderResult<readonly DexPairSnapshot[]> {
    if (!httpResult.ok) {
      return httpResult;
    }

    const direct = dexScreenerPairListSchema.safeParse(httpResult.data);
    const wrapped = dexScreenerWrappedPairsSchema.safeParse(httpResult.data);
    const pairs: readonly DexScreenerPair[] | undefined = direct.success
      ? direct.data
      : wrapped.success
        ? (wrapped.data.pairs ?? undefined)
        : undefined;

    if (!pairs) {
      return this.invalidResponse(httpResult, invalidMessage);
    }

    return providerSuccess({
      provider: this.name,
      data: mapDexScreenerPairs(pairs, httpResult.fetchedAt),
      fetchedAt: httpResult.fetchedAt,
      latencyMs: httpResult.latencyMs,
      warnings: httpResult.warnings,
      raw: this.options.allowRawPayloadLogging ? httpResult.data : undefined,
    });
  }

  private invalidResponse<T>(
    httpResult: ProviderSuccess<unknown>,
    message: string,
  ): ProviderResult<T> {
    return providerFailure({
      provider: this.name,
      error: createProviderError({
        code: "INVALID_RESPONSE",
        message,
        retryable: false,
      }),
      fetchedAt: httpResult.fetchedAt,
      latencyMs: httpResult.latencyMs,
      warnings: httpResult.warnings,
      raw: this.options.allowRawPayloadLogging ? httpResult.data : undefined,
    });
  }
}

function normalizeProfilePayload(
  payload:
    | readonly DexScreenerTokenProfile[]
    | DexScreenerTokenProfile
    | { readonly data?: readonly DexScreenerTokenProfile[] },
): readonly DexScreenerTokenProfile[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  const maybeData = (payload as { readonly data?: unknown }).data;

  if (Array.isArray(maybeData)) {
    return maybeData as readonly DexScreenerTokenProfile[];
  }

  return [payload as DexScreenerTokenProfile];
}
