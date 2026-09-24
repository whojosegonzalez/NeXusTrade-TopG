import type { TokenMintAddress } from "@nexustrade/shared";

import { loadLocalEnvFile } from "../config/loadEnvFile.js";
import { DexScreenerAdapter } from "../providers/dexscreener/DexScreenerAdapter.js";
import { ProviderHttpClient } from "../providers/http/ProviderHttpClient.js";
import { JupiterAdapter } from "../providers/jupiter/JupiterAdapter.js";
import { createProviderConfig } from "../providers/config/providerConfig.js";
import { WRAPPED_SOL_MINT } from "./ExploratoryCohortConstants.js";
import type {
  DiscoveryCandidate,
  ExploratoryCohortGateway,
  GatewayResult,
  MarketContext,
  QuoteImpact,
} from "./ExploratoryCohortTypes.js";

export function createDirectExploratoryCohortGateway(): ExploratoryCohortGateway {
  loadLocalEnvFile();
  const config = createProviderConfig(process.env);
  const dexScreener = new DexScreenerAdapter({
    httpClient: new ProviderHttpClient({
      provider: "DEXSCREENER",
      baseUrl: config.baseUrls.dexScreener,
      timeoutMs: 10_000,
      rateLimitPerMinute: 1,
    }),
    maxRetries: 0,
    retryBackoffMs: 0,
    allowRawPayloadLogging: false,
  });
  const jupiter = config.apiKeys.jupiter
    ? new JupiterAdapter({
        priceHttpClient: new ProviderHttpClient({
          provider: "JUPITER",
          baseUrl: config.baseUrls.jupiterPrice,
          timeoutMs: 10_000,
          rateLimitPerMinute: 1,
          defaultHeaders: { "x-api-key": config.apiKeys.jupiter },
        }),
        swapHttpClient: new ProviderHttpClient({
          provider: "JUPITER",
          baseUrl: config.baseUrls.jupiterSwap,
          timeoutMs: 10_000,
          rateLimitPerMinute: 1,
          defaultHeaders: { "x-api-key": config.apiKeys.jupiter },
        }),
        maxRetries: 0,
        retryBackoffMs: 0,
        allowRawPayloadLogging: false,
        enableTokenMetadata: false,
      })
    : undefined;

  return new DirectExploratoryCohortGateway(dexScreener, jupiter);
}

class DirectExploratoryCohortGateway implements ExploratoryCohortGateway {
  readonly available = true;
  readonly quoteAvailable: boolean;

  constructor(
    private readonly dexScreener: DexScreenerAdapter,
    private readonly jupiter: JupiterAdapter | undefined,
  ) {
    this.quoteAvailable = jupiter !== undefined;
  }

  async discover(limit: 100): Promise<GatewayResult<readonly DiscoveryCandidate[]>> {
    const result = await this.dexScreener.discoverTokens(limit);
    if (!result.ok) return failure(result, "DEXSCREENER");
    return {
      ok: true,
      value: result.data.map((identity) => ({
        mint: identity.mintAddress,
        sourceKind: "DEXSCREENER_TOKEN_PROFILE",
        firstObservedAt: result.fetchedAt,
      })),
      observedAt: result.fetchedAt,
      provider: "DEXSCREENER",
      outcomeCode: "OK",
      latencyMs: result.latencyMs,
    };
  }

  async marketContext(mint: string): Promise<GatewayResult<MarketContext>> {
    const result = await this.dexScreener.getBestPairForToken(mint as TokenMintAddress);
    if (!result.ok) return failure(result, "DEXSCREENER");
    const pair = result.data;
    return {
      ok: true,
      value: {
        observedAt: result.fetchedAt,
        ...(pair.baseMint === mint && finite(pair.priceUsd) ? { priceUsd: pair.priceUsd } : {}),
        ...(finite(pair.liquidityUsd) ? { liquidityUsd: pair.liquidityUsd } : {}),
        ...(finite(pair.volume5m) ? { volume5mUsd: pair.volume5m } : {}),
        ...(finite(pair.volume1h) ? { volume1hUsd: pair.volume1h } : {}),
        ...(pair.pairCreatedAt ? { assetCreatedAt: pair.pairCreatedAt } : {}),
      },
      observedAt: result.fetchedAt,
      provider: "DEXSCREENER",
      outcomeCode: "OK",
      latencyMs: result.latencyMs,
    };
  }

  async quoteImpact(mint: string): Promise<GatewayResult<QuoteImpact>> {
    if (!this.jupiter) {
      return {
        ok: false,
        observedAt: new Date(),
        provider: "JUPITER",
        outcomeCode: "NOT_REQUESTED",
        latencyMs: 0,
      };
    }
    const result = await this.jupiter.getQuote({
      inputMint: WRAPPED_SOL_MINT as TokenMintAddress,
      outputMint: mint as TokenMintAddress,
      amountRaw: "100000000",
      slippageBps: 100,
      side: "BUY",
    });
    if (!result.ok) return failure(result, "JUPITER");
    const impact = result.data.estimatedPriceImpactPct;
    return {
      ok: true,
      value: {
        observedAt: result.fetchedAt,
        ...(finite(impact) ? { priceImpactBps: impact * 10_000 } : {}),
      },
      observedAt: result.fetchedAt,
      provider: "JUPITER",
      outcomeCode: "OK",
      latencyMs: result.latencyMs,
    };
  }

  async laterPrice(mint: string): Promise<GatewayResult<{ readonly priceUsd?: number }>> {
    const result = await this.marketContext(mint);
    if (!result.ok) {
      return {
        ok: false,
        observedAt: result.observedAt,
        provider: result.provider,
        outcomeCode: result.outcomeCode,
        latencyMs: result.latencyMs,
      };
    }
    return {
      ok: true,
      value: finite(result.value?.priceUsd) ? { priceUsd: result.value.priceUsd } : {},
      observedAt: result.observedAt,
      provider: result.provider,
      outcomeCode: result.outcomeCode,
      latencyMs: result.latencyMs,
    };
  }
}

function failure<
  T extends {
    readonly error: { readonly code: string };
    readonly fetchedAt: Date;
    readonly latencyMs: number;
  },
>(result: T, provider: "DEXSCREENER" | "JUPITER"): GatewayResult<never> {
  return {
    ok: false,
    observedAt: result.fetchedAt,
    provider,
    outcomeCode: result.error.code,
    latencyMs: result.latencyMs,
  };
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}
