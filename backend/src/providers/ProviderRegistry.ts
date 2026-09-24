import type {
  ExecutionMode,
  ProviderCapability,
  ProviderName,
  TokenMintAddress,
} from "@nexustrade/shared";

import type { ProviderConfig } from "./config/providerConfig.js";
import { BirdeyeAdapter } from "./birdeye/BirdeyeAdapter.js";
import { BirdeyeBudgetTracker } from "./birdeye/BirdeyeBudgetTracker.js";
import { BirdeyeCache } from "./birdeye/BirdeyeCache.js";
import { DasMetadataAdapter } from "./das/DasMetadataAdapter.js";
import { DexScreenerAdapter } from "./dexscreener/DexScreenerAdapter.js";
import { HeliusAdapter } from "./helius/HeliusAdapter.js";
import { HeliusBackoffPolicy } from "./helius/HeliusBackoffPolicy.js";
import { HeliusEvidenceCache } from "./helius/HeliusEvidenceCache.js";
import { ProviderHttpClient } from "./http/ProviderHttpClient.js";
import { ProviderRateLimiter } from "./http/providerRateLimiter.js";
import type {
  LiquidityProvider,
  PriceProvider,
  PriorityFeeProvider,
  ProviderAdapter,
  QuoteProvider,
  RiskEvidenceProvider,
  TokenDiscoveryProvider,
  TokenMetadataProvider,
} from "./interfaces/index.js";
import { JupiterAdapter } from "./jupiter/JupiterAdapter.js";
import { JupiterDemandController } from "./jupiter/JupiterDemandController.js";
import type { ProviderHealthService } from "./ProviderHealthService.js";
import {
  QuoteAttemptJournal,
  QuoteBackoffPolicy,
  QuoteCache,
  QuoteNegativeCache,
  QuoteProviderRouter,
  QuoteScheduler,
  QuoteSingleFlight,
} from "./quotes/index.js";
import { RaydiumAdapter } from "./raydium/RaydiumAdapter.js";
import { RaydiumNegativeCache } from "./raydium/RaydiumNegativeCache.js";
import { RaydiumPoolPreflightService } from "./raydium/RaydiumPoolPreflightService.js";
import { RaydiumPreflightCache } from "./raydium/RaydiumPreflightCache.js";
import { RaydiumVenueGuard } from "./raydium/RaydiumVenueGuard.js";
import { SolanaRpcAdapter } from "./solana-rpc/SolanaRpcAdapter.js";
import { SolanaRpcMintAccountCache } from "./solana-rpc/SolanaRpcMintAccountCache.js";

export interface CreateProviderRegistryOptions {
  readonly config: ProviderConfig;
  readonly mode: ExecutionMode;
  readonly healthService?: ProviderHealthService;
  readonly rateLimiter?: ProviderRateLimiter;
}

export class ProviderRegistry {
  constructor(
    private readonly adapters: readonly ProviderAdapter[],
    private readonly quoteProviderRouter?: QuoteProvider,
  ) {}

  listAdapters(): readonly ProviderAdapter[] {
    return this.adapters;
  }

  listProviderNames(): readonly ProviderName[] {
    return this.adapters.map((adapter) => adapter.name);
  }

  getPriceProviders(): readonly PriceProvider[] {
    return this.adapters.filter(isPriceProvider);
  }

  getQuoteProviders(): readonly QuoteProvider[] {
    if (this.quoteProviderRouter) {
      return [this.quoteProviderRouter];
    }

    return this.adapters.filter(isQuoteProvider);
  }

  getTokenMetadataProviders(): readonly TokenMetadataProvider[] {
    return this.adapters.filter(isTokenMetadataProvider).sort(compareTokenMetadataProviders);
  }

  getLiquidityProviders(): readonly LiquidityProvider[] {
    return this.adapters.filter(isLiquidityProvider);
  }

  getTokenDiscoveryProviders(): readonly TokenDiscoveryProvider[] {
    return this.adapters.filter(isTokenDiscoveryProvider);
  }

  getRiskEvidenceProviders(): readonly RiskEvidenceProvider[] {
    return this.adapters.filter(isRiskEvidenceProvider).sort(compareRiskEvidenceProviders);
  }

  getPriorityFeeProviders(): readonly PriorityFeeProvider[] {
    return this.adapters.filter(isPriorityFeeProvider);
  }
}

export function createProviderRegistry(options: CreateProviderRegistryOptions): ProviderRegistry {
  const rateLimiter = options.rateLimiter ?? new ProviderRateLimiter();
  const adapters: ProviderAdapter[] = [];
  const healthServiceOption = options.healthService ? { healthService: options.healthService } : {};
  const jupiterDemandController = new JupiterDemandController(
    options.config.jupiter.demandController,
  );

  if (options.config.enabledProviders.includes("DEXSCREENER")) {
    adapters.push(
      new DexScreenerAdapter({
        httpClient: new ProviderHttpClient({
          provider: "DEXSCREENER",
          baseUrl: options.config.baseUrls.dexScreener,
          timeoutMs: options.config.timeoutMs,
          rateLimitPerMinute: options.config.rateLimitsPerMinute.DEXSCREENER,
          rateLimiter,
        }),
        ...healthServiceOption,
        maxRetries: options.config.maxRetries,
        retryBackoffMs: options.config.retryBackoffMs,
        allowRawPayloadLogging: options.config.allowRawPayloadLogging,
      }),
    );
  }

  if (options.config.enabledProviders.includes("JUPITER") && options.config.apiKeys.jupiter) {
    const defaultHeaders = {
      "x-api-key": options.config.apiKeys.jupiter,
    };

    adapters.push(
      new JupiterAdapter({
        priceHttpClient: new ProviderHttpClient({
          provider: "JUPITER",
          baseUrl: options.config.baseUrls.jupiterPrice,
          timeoutMs: options.config.timeoutMs,
          rateLimitPerMinute: options.config.rateLimitsPerMinute.JUPITER,
          rateLimiter,
          defaultHeaders,
        }),
        swapHttpClient: new ProviderHttpClient({
          provider: "JUPITER",
          baseUrl: options.config.baseUrls.jupiterSwap,
          timeoutMs: options.config.timeoutMs,
          rateLimitPerMinute: options.config.rateLimitsPerMinute.JUPITER,
          rateLimiter,
          defaultHeaders,
        }),
        ...healthServiceOption,
        maxRetries: options.config.maxRetries,
        retryBackoffMs: options.config.retryBackoffMs,
        allowRawPayloadLogging: options.config.allowRawPayloadLogging,
        enableTokenMetadata: options.config.jupiter.tokenMetadataEnabled,
        demandController: jupiterDemandController,
      }),
    );
  }

  if (options.config.enabledProviders.includes("BIRDEYE") && options.config.apiKeys.birdeye) {
    adapters.push(
      new BirdeyeAdapter({
        httpClient: new ProviderHttpClient({
          provider: "BIRDEYE",
          baseUrl: options.config.baseUrls.birdeye,
          timeoutMs: options.config.timeoutMs,
          rateLimitPerMinute: options.config.rateLimitsPerMinute.BIRDEYE,
          rateLimiter,
          defaultHeaders: {
            "X-API-KEY": options.config.apiKeys.birdeye,
            "x-chain": "solana",
          },
        }),
        ...healthServiceOption,
        maxRetries: options.config.maxRetries,
        retryBackoffMs: options.config.retryBackoffMs,
        allowRawPayloadLogging: options.config.allowRawPayloadLogging,
        priceEnabled: options.config.birdeye.priceEnabled,
        tokenOverviewEnabled: options.config.birdeye.tokenOverviewEnabled,
        cacheEnabled: options.config.birdeye.cacheEnabled,
        overviewFrames: options.config.birdeye.overviewFrames,
        budget: new BirdeyeBudgetTracker({
          maxRequestsPerRun: options.config.birdeye.maxRequestsPerRun,
          maxCuPerRun: options.config.birdeye.maxCuPerRun,
        }),
        cache: new BirdeyeCache({
          ttlMs: options.config.birdeye.cacheTtlMs,
        }),
      }),
    );
  }

  if (options.config.enabledProviders.includes("SOLANA_RPC") && options.config.baseUrls.solanaRpc) {
    adapters.push(
      new SolanaRpcAdapter({
        httpClient: new ProviderHttpClient({
          provider: "SOLANA_RPC",
          baseUrl: options.config.baseUrls.solanaRpc,
          timeoutMs: options.config.timeoutMs,
          rateLimitPerMinute: options.config.rateLimitsPerMinute.SOLANA_RPC,
          rateLimiter,
        }),
        ...healthServiceOption,
        maxRetries: options.config.maxRetries,
        retryBackoffMs: options.config.retryBackoffMs,
        allowRawPayloadLogging: options.config.allowRawPayloadLogging,
        mintAccountCache: new SolanaRpcMintAccountCache({
          ttlMs: options.config.solanaRpc.mintAccountCacheTtlMs,
        }),
        mintAccountCacheEnabled: options.config.solanaRpc.mintAccountCacheEnabled,
        useJsonParsed: options.config.solanaRpc.useJsonParsed,
        base64FallbackEnabled: options.config.solanaRpc.base64FallbackEnabled,
      }),
    );
  }

  if (
    options.config.enabledProviders.includes("QUICKNODE_DAS") &&
    options.config.baseUrls.quickNodeDas
  ) {
    adapters.push(
      new DasMetadataAdapter({
        providerName: "QUICKNODE_DAS",
        httpClient: new ProviderHttpClient({
          provider: "QUICKNODE_DAS",
          baseUrl: options.config.baseUrls.quickNodeDas,
          timeoutMs: options.config.timeoutMs,
          rateLimitPerMinute: options.config.rateLimitsPerMinute.QUICKNODE_DAS,
          rateLimiter,
        }),
        ...healthServiceOption,
        maxRetries: options.config.maxRetries,
        retryBackoffMs: options.config.retryBackoffMs,
        allowRawPayloadLogging: options.config.allowRawPayloadLogging,
        metadataEnabled: options.config.quickNodeDas.metadataEnabled,
      }),
    );
  }

  if (
    options.config.enabledProviders.includes("ALCHEMY_DAS") &&
    options.config.baseUrls.alchemySolana
  ) {
    adapters.push(
      new DasMetadataAdapter({
        providerName: "ALCHEMY_DAS",
        httpClient: new ProviderHttpClient({
          provider: "ALCHEMY_DAS",
          baseUrl: options.config.baseUrls.alchemySolana,
          timeoutMs: options.config.timeoutMs,
          rateLimitPerMinute: options.config.rateLimitsPerMinute.ALCHEMY_DAS,
          rateLimiter,
        }),
        ...healthServiceOption,
        maxRetries: options.config.maxRetries,
        retryBackoffMs: options.config.retryBackoffMs,
        allowRawPayloadLogging: options.config.allowRawPayloadLogging,
        metadataEnabled: options.config.alchemyDas.metadataEnabled,
      }),
    );
  }

  if (options.config.enabledProviders.includes("HELIUS") && options.config.apiKeys.helius) {
    const evidenceCache = new HeliusEvidenceCache({
      metadataTtlMs: options.config.helius.metadataCacheTtlMs,
      riskEvidenceTtlMs: options.config.helius.riskEvidenceCacheTtlMs,
    });
    const backoff = new HeliusBackoffPolicy({
      enabled: options.config.helius.backoffEnabled,
      baseCooldownMs: options.config.helius.backoffBaseCooldownMs,
      maxCooldownMs: options.config.helius.backoffMaxCooldownMs,
    });

    adapters.push(
      new HeliusAdapter({
        httpClient: new ProviderHttpClient({
          provider: "HELIUS",
          baseUrl: options.config.baseUrls.heliusRpc,
          timeoutMs: options.config.timeoutMs,
          rateLimitPerMinute: options.config.rateLimitsPerMinute.HELIUS,
          rateLimiter,
        }),
        apiKey: options.config.apiKeys.helius,
        ...healthServiceOption,
        maxRetries: options.config.maxRetries,
        retryBackoffMs: options.config.retryBackoffMs,
        allowRawPayloadLogging: options.config.allowRawPayloadLogging,
        evidenceCache,
        backoff,
        metadataCacheEnabled: options.config.helius.metadataCacheEnabled,
        riskEvidenceCacheEnabled: options.config.helius.riskEvidenceCacheEnabled,
        skipLowPriorityDuringCooldown: options.config.helius.skipLowPriorityDuringCooldown,
      }),
    );
  }

  if (options.config.enabledProviders.includes("RAYDIUM")) {
    const raydiumApiV3HttpClient = new ProviderHttpClient({
      provider: "RAYDIUM",
      baseUrl: options.config.baseUrls.raydiumApiV3,
      timeoutMs: options.config.timeoutMs,
      rateLimitPerMinute: options.config.rateLimitsPerMinute.RAYDIUM,
      rateLimiter,
    });

    adapters.push(
      new RaydiumAdapter({
        httpClient: new ProviderHttpClient({
          provider: "RAYDIUM",
          baseUrl: options.config.baseUrls.raydiumTrade,
          timeoutMs: options.config.timeoutMs,
          rateLimitPerMinute: options.config.rateLimitsPerMinute.RAYDIUM,
          rateLimiter,
        }),
        apiV3HttpClient: raydiumApiV3HttpClient,
        poolPreflightService: new RaydiumPoolPreflightService({
          enabled: options.config.raydium.precheckEnabled,
          httpClient: raydiumApiV3HttpClient,
          cache: new RaydiumPreflightCache({
            ttlMs: options.config.raydium.precheckTtlMs,
          }),
          allowRawPayloadLogging: options.config.allowRawPayloadLogging,
          poolType: options.config.raydium.preflightPoolType,
          sortField: options.config.raydium.preflightSortField,
          sortType: options.config.raydium.preflightSortType,
          pageSize: options.config.raydium.preflightPageSize,
          page: options.config.raydium.preflightPage,
          maxErrorMessageLength: options.config.raydium.maxErrorMessageLength,
        }),
        ...healthServiceOption,
        maxRetries: options.config.maxRetries,
        retryBackoffMs: options.config.retryBackoffMs,
        allowRawPayloadLogging: options.config.allowRawPayloadLogging,
        txVersion: options.config.raydium.txVersion,
        diagnosticsEnabled: options.config.raydium.diagnosticsEnabled,
        mintPriceDiagnosticsEnabled: options.config.raydium.mintPriceDiagnosticsEnabled,
        captureSanitizedErrorContext: options.config.raydium.captureSanitizedErrorContext,
        maxErrorMessageLength: options.config.raydium.maxErrorMessageLength,
      }),
    );
  }

  const quoteProviders = adapters.filter(isQuoteProvider);
  const quoteProviderRouter =
    quoteProviders.length > 0
      ? new QuoteProviderRouter({
          providers: quoteProviders,
          cache: new QuoteCache({
            enabled: options.config.quoteResilience.cache.enabled,
            ttlMs: options.config.quoteResilience.cache.ttlMs,
            maxEntries: options.config.quoteResilience.cache.maxEntries,
          }),
          negativeCache: new QuoteNegativeCache({
            enabled: options.config.quoteResilience.negativeCache.enabled,
            ttlMs: options.config.quoteResilience.negativeCache.ttlMs,
            maxEntries: options.config.quoteResilience.negativeCache.maxEntries,
          }),
          raydiumNegativeCache: new RaydiumNegativeCache({
            enabled: options.config.quoteResilience.negativeCache.enabled,
            ttlMs: options.config.raydium.negativeCacheTtlMs,
            maxEntries: options.config.raydium.negativeCacheMaxEntries,
          }),
          backoff: new QuoteBackoffPolicy({
            enabled: options.config.quoteResilience.backoff.enabled,
            baseCooldownMs: options.config.quoteResilience.backoff.baseCooldownMs,
            maxCooldownMs: options.config.quoteResilience.backoff.maxCooldownMs,
            multiplier: options.config.quoteResilience.backoff.multiplier,
            jitterPct: options.config.quoteResilience.backoff.jitterPct,
          }),
          scheduler: new QuoteScheduler({
            enabled: options.config.quoteResilience.scheduler.enabled,
            minIntervalMsByProvider: {
              // Jupiter's shared demand controller owns its interval so price and quote
              // work compete for the same budget. Raydium retains the 9.4B scheduler.
              JUPITER: options.config.jupiter.demandController.enabled
                ? 0
                : options.config.quoteResilience.scheduler.jupiterMinIntervalMs,
              RAYDIUM: options.config.quoteResilience.scheduler.raydiumMinIntervalMs,
            },
          }),
          singleFlight: new QuoteSingleFlight({
            enabled: options.config.quoteResilience.singleFlight.enabled,
            ttlMs: options.config.quoteResilience.singleFlight.ttlMs,
          }),
          raydiumVenueGuard: new RaydiumVenueGuard({
            enabled: options.config.raydium.venueGuardEnabled,
            skipWhenVenueAbsent: options.config.raydium.skipWhenDexScreenerVenueAbsent,
            requireVenueEvidence: options.config.raydium.requireDexScreenerRaydiumVenue,
          }),
          attemptJournal: new QuoteAttemptJournal({
            enabled: options.config.quoteResilience.attemptJournal.enabled,
            ttlMs: options.config.quoteResilience.attemptJournal.ttlMs,
            maxEntries: options.config.quoteResilience.attemptJournal.maxEntries,
          }),
          ...(options.healthService ? { healthService: options.healthService } : {}),
          skipLowPriorityDuringCooldown:
            options.config.quoteResilience.backoff.skipLowPriorityDuringCooldown,
        })
      : undefined;

  return new ProviderRegistry(adapters, quoteProviderRouter);
}

function hasCapability(adapter: ProviderAdapter, capability: ProviderCapability): boolean {
  return adapter.capabilities.includes(capability);
}

function isPriceProvider(adapter: ProviderAdapter): adapter is PriceProvider {
  return hasCapability(adapter, "PRICE") && "getPrice" in adapter;
}

function isQuoteProvider(adapter: ProviderAdapter): adapter is QuoteProvider {
  return hasCapability(adapter, "QUOTE") && "getQuote" in adapter;
}

function isTokenMetadataProvider(adapter: ProviderAdapter): adapter is TokenMetadataProvider {
  return hasCapability(adapter, "TOKEN_METADATA") && "getTokenMetadata" in adapter;
}

function compareTokenMetadataProviders(
  left: TokenMetadataProvider,
  right: TokenMetadataProvider,
): number {
  return tokenMetadataProviderRank(left.name) - tokenMetadataProviderRank(right.name);
}

function tokenMetadataProviderRank(provider: ProviderName): number {
  switch (provider) {
    case "SOLANA_RPC":
      return 0;
    case "QUICKNODE_DAS":
      return 1;
    case "ALCHEMY_DAS":
      return 2;
    case "HELIUS":
      return 3;
    case "JUPITER":
      return 4;
    case "BIRDEYE":
      return 5;
    default:
      return 6;
  }
}

function compareRiskEvidenceProviders(
  left: RiskEvidenceProvider,
  right: RiskEvidenceProvider,
): number {
  return riskEvidenceProviderRank(left.name) - riskEvidenceProviderRank(right.name);
}

function riskEvidenceProviderRank(provider: ProviderName): number {
  switch (provider) {
    case "SOLANA_RPC":
      return 0;
    case "HELIUS":
      return 1;
    default:
      return 2;
  }
}

function isLiquidityProvider(adapter: ProviderAdapter): adapter is LiquidityProvider {
  return hasCapability(adapter, "LIQUIDITY") && "getBestPairForToken" in adapter;
}

function isTokenDiscoveryProvider(adapter: ProviderAdapter): adapter is TokenDiscoveryProvider {
  return hasCapability(adapter, "TOKEN_DISCOVERY") && "discoverTokens" in adapter;
}

function isRiskEvidenceProvider(adapter: ProviderAdapter): adapter is RiskEvidenceProvider {
  return hasCapability(adapter, "RISK_EVIDENCE") && "getRiskEvidence" in adapter;
}

function isPriorityFeeProvider(adapter: ProviderAdapter): adapter is PriorityFeeProvider {
  return hasCapability(adapter, "PRIORITY_FEE") && "getPriorityFeeEstimate" in adapter;
}

export function tokenBelongsToPairBase(
  mintAddress: TokenMintAddress,
  pairBaseMint: TokenMintAddress,
): boolean {
  return mintAddress === pairBaseMint;
}
