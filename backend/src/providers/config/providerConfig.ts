import {
  PROVIDER_NAMES,
  parseProviderName,
  type ExecutionMode,
  type ProviderName,
} from "@nexustrade/shared";
import type { JupiterDemandControllerConfig } from "../jupiter/JupiterDemandController.js";

export interface DisabledProviderConfig {
  readonly provider: ProviderName;
  readonly reason: string;
}

export interface ProviderApiKeys {
  readonly birdeye?: string;
  readonly dexScreener?: string;
  readonly helius?: string;
  readonly jupiter?: string;
  readonly rugCheck?: string;
}

export interface ProviderBaseUrls {
  readonly alchemySolana?: string;
  readonly birdeye: string;
  readonly dexScreener: string;
  readonly heliusRpc: string;
  readonly jupiterPrice: string;
  readonly jupiterSwap: string;
  readonly quickNodeDas?: string;
  readonly raydiumApiV3: string;
  readonly raydiumTrade: string;
  readonly rugCheck: string;
  readonly solanaRpc?: string;
}

export interface ProviderRuntimeOptions {
  readonly mode: ExecutionMode;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly rateLimitPerMinute: number;
  readonly allowRawPayloadLogging: boolean;
  readonly strictValidation: boolean;
  readonly writeProviderHealth: boolean;
}

export interface QuoteCacheConfig {
  readonly enabled: boolean;
  readonly ttlMs: number;
  readonly maxEntries: number;
}

export interface QuoteBackoffConfig {
  readonly enabled: boolean;
  readonly baseCooldownMs: number;
  readonly maxCooldownMs: number;
  readonly multiplier: number;
  readonly jitterPct: number;
  readonly skipLowPriorityDuringCooldown: boolean;
}

export interface QuoteAttemptJournalConfig {
  readonly enabled: boolean;
  readonly ttlMs: number;
  readonly maxEntries: number;
}

export interface QuoteSchedulerConfig {
  readonly enabled: boolean;
  readonly jupiterMinIntervalMs: number;
  readonly raydiumMinIntervalMs: number;
}

export interface QuoteSingleFlightConfig {
  readonly enabled: boolean;
  readonly ttlMs: number;
}

export interface QuoteNegativeCacheConfig {
  readonly enabled: boolean;
  readonly ttlMs: number;
  readonly maxEntries: number;
}

/**
 * A local per-risk-cycle allocation limit. This protects quote capacity; it is
 * intentionally independent of strategy scoring and the Jupiter controller.
 */
export interface QuoteBudgetPlannerConfig {
  readonly enabled: boolean;
  readonly maxCandidatesPerCycle: number;
  readonly recencyWeight: number;
  readonly liquidityWeight: number;
  readonly volumeWeight: number;
  readonly ageWeight: number;
  readonly priorEvidenceWeight: number;
}

export interface QuoteResilienceConfig {
  readonly cache: QuoteCacheConfig;
  readonly backoff: QuoteBackoffConfig;
  readonly attemptJournal: QuoteAttemptJournalConfig;
  readonly scheduler: QuoteSchedulerConfig;
  readonly singleFlight: QuoteSingleFlightConfig;
  readonly negativeCache: QuoteNegativeCacheConfig;
  readonly planner: QuoteBudgetPlannerConfig;
}

export interface JupiterProviderConfig {
  readonly tokenMetadataEnabled: boolean;
  readonly demandController: JupiterDemandControllerConfig;
}

export interface RaydiumProviderConfig {
  readonly txVersion: "LEGACY" | "V0";
  readonly diagnosticsEnabled: boolean;
  readonly precheckEnabled: boolean;
  readonly precheckTtlMs: number;
  readonly preflightPoolType: RaydiumPreflightPoolType;
  readonly preflightSortField: RaydiumPreflightSortField;
  readonly preflightSortType: RaydiumPreflightSortType;
  readonly preflightPageSize: number;
  readonly preflightPage: number;
  readonly mintPriceDiagnosticsEnabled: boolean;
  readonly captureSanitizedErrorContext: boolean;
  readonly maxErrorMessageLength: number;
  readonly venueGuardEnabled: boolean;
  readonly skipWhenDexScreenerVenueAbsent: boolean;
  readonly requireDexScreenerRaydiumVenue: boolean;
  readonly negativeCacheTtlMs: number;
  readonly negativeCacheMaxEntries: number;
}

export const RAYDIUM_PREFLIGHT_POOL_TYPES = [
  "all",
  "concentrated",
  "standard",
  "allFarm",
  "concentratedFarm",
  "standardFarm",
] as const;

export type RaydiumPreflightPoolType = (typeof RAYDIUM_PREFLIGHT_POOL_TYPES)[number];

export const RAYDIUM_PREFLIGHT_SORT_FIELDS = [
  "default",
  "liquidity",
  "volume24h",
  "fee24h",
  "apr24h",
  "volume7d",
  "fee7d",
  "apr7d",
  "volume30d",
  "fee30d",
  "apr30d",
] as const;

export type RaydiumPreflightSortField = (typeof RAYDIUM_PREFLIGHT_SORT_FIELDS)[number];

export const RAYDIUM_PREFLIGHT_SORT_TYPES = ["asc", "desc"] as const;

export type RaydiumPreflightSortType = (typeof RAYDIUM_PREFLIGHT_SORT_TYPES)[number];

export interface HeliusProviderConfig {
  readonly metadataCacheEnabled: boolean;
  readonly riskEvidenceCacheEnabled: boolean;
  readonly metadataCacheTtlMs: number;
  readonly riskEvidenceCacheTtlMs: number;
  readonly backoffEnabled: boolean;
  readonly backoffBaseCooldownMs: number;
  readonly backoffMaxCooldownMs: number;
  readonly skipLowPriorityDuringCooldown: boolean;
}

export interface SolanaRpcProviderConfig {
  readonly mintAccountCacheEnabled: boolean;
  readonly mintAccountCacheTtlMs: number;
  readonly useJsonParsed: boolean;
  readonly base64FallbackEnabled: boolean;
}

export interface DasProviderConfig {
  readonly metadataEnabled: boolean;
}

export interface BirdeyeProviderConfig {
  readonly priceEnabled: boolean;
  readonly tokenOverviewEnabled: boolean;
  readonly marketDataEnabled: boolean;
  readonly exitLiquidityEnabled: boolean;
  readonly creditsCheckEnabled: boolean;
  readonly cacheEnabled: boolean;
  readonly cacheTtlMs: number;
  readonly maxRequestsPerRun: number;
  readonly maxCuPerRun: number;
  readonly maxCandidatesPerCycle: number;
  readonly minScore: number;
  readonly overviewFrames: readonly string[];
}

export interface ProviderConfig {
  readonly requestedProviders: readonly ProviderName[];
  readonly enabledProviders: readonly ProviderName[];
  readonly disabledProviders: readonly DisabledProviderConfig[];
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly allowRawPayloadLogging: boolean;
  readonly writeProviderHealth: boolean;
  readonly rateLimitsPerMinute: Readonly<Record<ProviderName, number>>;
  readonly apiKeys: ProviderApiKeys;
  readonly baseUrls: ProviderBaseUrls;
  readonly quoteResilience: QuoteResilienceConfig;
  readonly alchemyDas: DasProviderConfig;
  readonly birdeye: BirdeyeProviderConfig;
  readonly helius: HeliusProviderConfig;
  readonly jupiter: JupiterProviderConfig;
  readonly quickNodeDas: DasProviderConfig;
  readonly raydium: RaydiumProviderConfig;
  readonly solanaRpc: SolanaRpcProviderConfig;
}

const DEFAULT_PROVIDERS: readonly ProviderName[] = ["DEXSCREENER", "JUPITER", "HELIUS", "RAYDIUM"];

const DEFAULT_BASE_URLS: ProviderBaseUrls = {
  birdeye: "https://public-api.birdeye.so",
  dexScreener: "https://api.dexscreener.com",
  heliusRpc: "https://mainnet.helius-rpc.com",
  jupiterPrice: "https://api.jup.ag/price/v3",
  jupiterSwap: "https://api.jup.ag/swap/v1",
  raydiumApiV3: "https://api-v3.raydium.io",
  raydiumTrade: "https://transaction-v1.raydium.io",
  rugCheck: "https://api.rugcheck.xyz",
};

const DEFAULT_RATE_LIMITS: Readonly<Record<ProviderName, number>> = {
  ALCHEMY_DAS: 60,
  BIRDEYE: 60,
  DEXSCREENER: 300,
  HELIUS: 60,
  JUPITER: 60,
  MOCK: 60_000,
  QUICKNODE_DAS: 60,
  RAYDIUM: 60,
  RUGCHECK: 60,
  SOLANA_RPC: 120,
};

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum = 1,
): number {
  const raw = readOptionalString(env[name]);

  if (!raw) {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`Invalid provider configuration: ${name} must be an integer >= ${minimum}.`);
  }

  return parsed;
}

function parseIntegerRange(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = parsePositiveInteger(env, name, defaultValue, minimum);

  if (parsed > maximum) {
    throw new Error(`Invalid provider configuration: ${name} must be an integer <= ${maximum}.`);
  }

  return parsed;
}

function parseBoolean(env: NodeJS.ProcessEnv, name: string, defaultValue: boolean): boolean {
  const raw = readOptionalString(env[name]);

  if (!raw) {
    return defaultValue;
  }

  const normalized = raw.toLowerCase();

  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }

  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  throw new Error(`Invalid provider configuration: ${name} must be true or false.`);
}

function parseRaydiumTxVersion(env: NodeJS.ProcessEnv): RaydiumProviderConfig["txVersion"] {
  const raw = readOptionalString(env.RAYDIUM_TX_VERSION) ?? "V0";
  const normalized = raw.toUpperCase();

  if (normalized === "V0" || normalized === "LEGACY") {
    return normalized;
  }

  throw new Error("Invalid provider configuration: RAYDIUM_TX_VERSION must be V0 or LEGACY.");
}

function parseEnumValue<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const raw = readOptionalString(env[name]);

  if (!raw) {
    return defaultValue;
  }

  if (allowed.includes(raw as T)) {
    return raw as T;
  }

  throw new Error(`Invalid provider configuration: ${name} must be one of ${allowed.join(", ")}.`);
}

function parseUrl(env: NodeJS.ProcessEnv, name: string, defaultValue: string): string {
  const raw = readOptionalString(env[name]) ?? defaultValue;

  try {
    return new URL(raw).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid provider configuration: ${name} must be a valid URL.`);
  }
}

function parseOptionalUrl(env: NodeJS.ProcessEnv, ...names: readonly string[]): string | undefined {
  const raw = names.map((name) => readOptionalString(env[name])).find(Boolean);

  if (!raw) {
    return undefined;
  }

  try {
    return new URL(raw).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid provider configuration: ${names.join(" or ")} must be a valid URL.`);
  }
}

function parseStringList(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: readonly string[],
): readonly string[] {
  const raw = readOptionalString(env[name]);

  if (!raw) {
    return defaultValue;
  }

  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (values.length === 0) {
    throw new Error(`Invalid provider configuration: ${name} must include at least one value.`);
  }

  return [...new Set(values)];
}

function parseRequestedProviders(env: NodeJS.ProcessEnv): readonly ProviderName[] {
  const raw = readOptionalString(env.PROVIDERS_ENABLED);

  if (!raw) {
    return DEFAULT_PROVIDERS;
  }

  const providers = raw
    .split(",")
    .map((provider) => provider.trim())
    .filter((provider) => provider.length > 0)
    .map(parseProviderName);

  if (providers.length === 0) {
    throw new Error(
      `Invalid provider configuration: PROVIDERS_ENABLED must include at least one provider (${PROVIDER_NAMES.join(
        ", ",
      )}).`,
    );
  }

  return [...new Set(providers)];
}

function getDisabledReason(
  provider: ProviderName,
  apiKeys: ProviderApiKeys,
  baseUrls: ProviderBaseUrls,
): string | undefined {
  switch (provider) {
    case "ALCHEMY_DAS":
      return baseUrls.alchemySolana ? undefined : "ALCHEMY_SOLANA_BASE_URL is not set.";
    case "BIRDEYE":
      return apiKeys.birdeye ? undefined : "BIRDEYE_API_KEY is not set.";
    case "DEXSCREENER":
    case "MOCK":
      return undefined;
    case "HELIUS":
      return apiKeys.helius ? undefined : "HELIUS_API_KEY is not set.";
    case "JUPITER":
      return apiKeys.jupiter ? undefined : "JUPITER_API_KEY is not set.";
    case "QUICKNODE_DAS":
      return baseUrls.quickNodeDas ? undefined : "QUICKNODE_DAS_BASE_URL is not set.";
    case "RAYDIUM":
      return undefined;
    case "RUGCHECK":
      return "RugCheck integration is deferred until its API contract is selected.";
    case "SOLANA_RPC":
      return baseUrls.solanaRpc ? undefined : "SOLANA_RPC_BASE_URL is not set.";
  }
}

export function createProviderConfig(env: NodeJS.ProcessEnv): ProviderConfig {
  const requestedProviders = parseRequestedProviders(env);
  const timeoutMs = parsePositiveInteger(env, "PROVIDER_TIMEOUT_MS", 10_000, 100);
  const maxRetries = parsePositiveInteger(env, "PROVIDER_MAX_RETRIES", 2, 0);
  const retryBackoffMs = parsePositiveInteger(env, "PROVIDER_RETRY_BACKOFF_MS", 250, 0);
  const allowRawPayloadLogging = parseBoolean(env, "ENABLE_PROVIDER_RAW_PAYLOAD_LOGGING", false);
  const writeProviderHealth = parseBoolean(env, "WRITE_PROVIDER_HEALTH", true);
  const birdeyeApiKey = readOptionalString(env.BIRDEYE_API_KEY);
  const dexScreenerApiKey = readOptionalString(env.DEXSCREENER_API_KEY);
  const heliusApiKey = readOptionalString(env.HELIUS_API_KEY);
  const jupiterApiKey = readOptionalString(env.JUPITER_API_KEY);
  const rugCheckApiKey = readOptionalString(env.RUGCHECK_API_KEY);
  const apiKeys: ProviderApiKeys = {
    ...(birdeyeApiKey ? { birdeye: birdeyeApiKey } : {}),
    ...(dexScreenerApiKey ? { dexScreener: dexScreenerApiKey } : {}),
    ...(heliusApiKey ? { helius: heliusApiKey } : {}),
    ...(jupiterApiKey ? { jupiter: jupiterApiKey } : {}),
    ...(rugCheckApiKey ? { rugCheck: rugCheckApiKey } : {}),
  };
  const alchemySolanaBaseUrl = parseOptionalUrl(
    env,
    "ALCHEMY_SOLANA_BASE_URL",
    "ALCHEMY_DAS_BASE_URL",
  );
  const quickNodeDasBaseUrl = parseOptionalUrl(
    env,
    "QUICKNODE_DAS_BASE_URL",
    "QUICKNODE_SOLANA_BASE_URL",
  );
  const solanaRpcBaseUrl = parseOptionalUrl(env, "SOLANA_RPC_BASE_URL");
  const baseUrls: ProviderBaseUrls = {
    ...(alchemySolanaBaseUrl ? { alchemySolana: alchemySolanaBaseUrl } : {}),
    birdeye: parseUrl(env, "BIRDEYE_BASE_URL", DEFAULT_BASE_URLS.birdeye),
    dexScreener: parseUrl(env, "DEXSCREENER_BASE_URL", DEFAULT_BASE_URLS.dexScreener),
    heliusRpc: parseUrl(env, "HELIUS_RPC_BASE_URL", DEFAULT_BASE_URLS.heliusRpc),
    jupiterPrice: parseUrl(env, "JUPITER_PRICE_BASE_URL", DEFAULT_BASE_URLS.jupiterPrice),
    jupiterSwap: parseUrl(env, "JUPITER_SWAP_BASE_URL", DEFAULT_BASE_URLS.jupiterSwap),
    ...(quickNodeDasBaseUrl ? { quickNodeDas: quickNodeDasBaseUrl } : {}),
    raydiumApiV3: parseUrl(env, "RAYDIUM_API_V3_BASE_URL", DEFAULT_BASE_URLS.raydiumApiV3),
    raydiumTrade: parseUrl(env, "RAYDIUM_BASE_URL", DEFAULT_BASE_URLS.raydiumTrade),
    rugCheck: parseUrl(env, "RUGCHECK_BASE_URL", DEFAULT_BASE_URLS.rugCheck),
    ...(solanaRpcBaseUrl ? { solanaRpc: solanaRpcBaseUrl } : {}),
  };
  const rateLimitsPerMinute: Readonly<Record<ProviderName, number>> = {
    ALCHEMY_DAS: parsePositiveInteger(
      env,
      "ALCHEMY_DAS_RATE_LIMIT_PER_MINUTE",
      DEFAULT_RATE_LIMITS.ALCHEMY_DAS,
    ),
    BIRDEYE: parsePositiveInteger(
      env,
      "BIRDEYE_RATE_LIMIT_PER_MINUTE",
      DEFAULT_RATE_LIMITS.BIRDEYE,
    ),
    DEXSCREENER: parsePositiveInteger(
      env,
      "DEXSCREENER_RATE_LIMIT_PER_MINUTE",
      DEFAULT_RATE_LIMITS.DEXSCREENER,
    ),
    HELIUS: parsePositiveInteger(env, "HELIUS_RATE_LIMIT_PER_MINUTE", DEFAULT_RATE_LIMITS.HELIUS),
    JUPITER: parsePositiveInteger(
      env,
      "JUPITER_RATE_LIMIT_PER_MINUTE",
      DEFAULT_RATE_LIMITS.JUPITER,
    ),
    MOCK: DEFAULT_RATE_LIMITS.MOCK,
    QUICKNODE_DAS: parsePositiveInteger(
      env,
      "QUICKNODE_DAS_RATE_LIMIT_PER_MINUTE",
      DEFAULT_RATE_LIMITS.QUICKNODE_DAS,
    ),
    RAYDIUM: parsePositiveInteger(
      env,
      "RAYDIUM_RATE_LIMIT_PER_MINUTE",
      DEFAULT_RATE_LIMITS.RAYDIUM,
    ),
    RUGCHECK: parsePositiveInteger(
      env,
      "RUGCHECK_RATE_LIMIT_PER_MINUTE",
      DEFAULT_RATE_LIMITS.RUGCHECK,
    ),
    SOLANA_RPC: parsePositiveInteger(
      env,
      "SOLANA_RPC_RATE_LIMIT_PER_MINUTE",
      DEFAULT_RATE_LIMITS.SOLANA_RPC,
    ),
  };
  const quoteResilience: QuoteResilienceConfig = {
    cache: {
      enabled: parseBoolean(env, "QUOTE_CACHE_ENABLED", true),
      ttlMs: parsePositiveInteger(env, "QUOTE_CACHE_TTL_MS", 90_000),
      maxEntries: parsePositiveInteger(env, "QUOTE_CACHE_MAX_ENTRIES", 1_000),
    },
    backoff: {
      enabled: parseBoolean(env, "QUOTE_BACKOFF_ENABLED", true),
      baseCooldownMs: parsePositiveInteger(env, "QUOTE_BACKOFF_BASE_COOLDOWN_MS", 30_000),
      maxCooldownMs: parsePositiveInteger(env, "QUOTE_BACKOFF_MAX_COOLDOWN_MS", 120_000),
      multiplier: parsePositiveInteger(env, "QUOTE_BACKOFF_MULTIPLIER", 2),
      jitterPct: parsePositiveInteger(env, "QUOTE_BACKOFF_JITTER_PCT", 10, 0),
      skipLowPriorityDuringCooldown: parseBoolean(
        env,
        "QUOTE_SKIP_LOW_PRIORITY_DURING_COOLDOWN",
        true,
      ),
    },
    attemptJournal: {
      enabled: parseBoolean(env, "QUOTE_ATTEMPT_JOURNAL_ENABLED", true),
      ttlMs: parsePositiveInteger(env, "QUOTE_ATTEMPT_JOURNAL_TTL_MS", 300_000),
      maxEntries: parsePositiveInteger(env, "QUOTE_ATTEMPT_JOURNAL_MAX_ENTRIES", 1_000),
    },
    scheduler: {
      enabled: parseBoolean(env, "QUOTE_SCHEDULER_ENABLED", true),
      jupiterMinIntervalMs: parsePositiveInteger(
        env,
        "QUOTE_SCHEDULER_JUPITER_MIN_INTERVAL_MS",
        1_100,
        0,
      ),
      raydiumMinIntervalMs: parsePositiveInteger(
        env,
        "QUOTE_SCHEDULER_RAYDIUM_MIN_INTERVAL_MS",
        250,
        0,
      ),
    },
    singleFlight: {
      enabled: parseBoolean(env, "QUOTE_SINGLE_FLIGHT_ENABLED", true),
      ttlMs: parsePositiveInteger(env, "QUOTE_SINGLE_FLIGHT_TTL_MS", 15_000),
    },
    negativeCache: {
      enabled: parseBoolean(env, "QUOTE_NEGATIVE_CACHE_ENABLED", true),
      ttlMs: parsePositiveInteger(env, "QUOTE_NEGATIVE_CACHE_TTL_MS", 120_000),
      maxEntries: parsePositiveInteger(env, "QUOTE_NEGATIVE_CACHE_MAX_ENTRIES", 1_000),
    },
    planner: {
      enabled: parseBoolean(env, "QUOTE_BUDGET_PLANNER_ENABLED", true),
      maxCandidatesPerCycle: parsePositiveInteger(env, "QUOTE_BUDGET_MAX_CANDIDATES_PER_CYCLE", 20),
      recencyWeight: parsePositiveInteger(env, "QUOTE_BUDGET_RECENCY_WEIGHT", 4, 0),
      liquidityWeight: parsePositiveInteger(env, "QUOTE_BUDGET_LIQUIDITY_WEIGHT", 3, 0),
      volumeWeight: parsePositiveInteger(env, "QUOTE_BUDGET_VOLUME_WEIGHT", 3, 0),
      ageWeight: parsePositiveInteger(env, "QUOTE_BUDGET_AGE_WEIGHT", 2, 0),
      priorEvidenceWeight: parsePositiveInteger(env, "QUOTE_BUDGET_PRIOR_EVIDENCE_WEIGHT", 2, 0),
    },
  };
  const jupiter: JupiterProviderConfig = {
    tokenMetadataEnabled: parseBoolean(env, "JUPITER_TOKEN_METADATA_ENABLED", false),
    demandController: {
      enabled: parseBoolean(env, "JUPITER_DEMAND_CONTROLLER_ENABLED", true),
      windowMs: parsePositiveInteger(env, "JUPITER_DEMAND_WINDOW_MS", 60_000),
      maxLiveRequestsPerWindow: parsePositiveInteger(
        env,
        "JUPITER_DEMAND_MAX_LIVE_REQUESTS_PER_WINDOW",
        48,
      ),
      baseMinIntervalMs: parsePositiveInteger(env, "JUPITER_DEMAND_BASE_MIN_INTERVAL_MS", 1_250),
      maxIntervalMs: parsePositiveInteger(env, "JUPITER_DEMAND_MAX_INTERVAL_MS", 15_000),
      adaptiveEnabled: parseBoolean(env, "JUPITER_DEMAND_ADAPTIVE_ENABLED", true),
      rateLimitMultiplier: parsePositiveInteger(env, "JUPITER_DEMAND_RATE_LIMIT_MULTIPLIER", 2),
      successDecayCount: parsePositiveInteger(env, "JUPITER_DEMAND_SUCCESS_DECAY_COUNT", 4),
      maxLowPriorityRequestsPerWindow: parsePositiveInteger(
        env,
        "JUPITER_DEMAND_MAX_LOW_PRIORITY_REQUESTS_PER_WINDOW",
        12,
      ),
      deferLowPriorityFirst: parseBoolean(env, "JUPITER_DEMAND_DEFER_LOW_PRIORITY_FIRST", true),
      respectRetryAfter: parseBoolean(env, "JUPITER_DEMAND_RESPECT_RETRY_AFTER", true),
    },
  };
  if (jupiter.demandController.baseMinIntervalMs > jupiter.demandController.maxIntervalMs) {
    throw new Error(
      "JUPITER_DEMAND_BASE_MIN_INTERVAL_MS must be less than or equal to JUPITER_DEMAND_MAX_INTERVAL_MS.",
    );
  }
  const helius: HeliusProviderConfig = {
    metadataCacheEnabled: parseBoolean(env, "HELIUS_METADATA_CACHE_ENABLED", true),
    riskEvidenceCacheEnabled: parseBoolean(env, "HELIUS_RISK_EVIDENCE_CACHE_ENABLED", true),
    metadataCacheTtlMs: parsePositiveInteger(env, "HELIUS_METADATA_CACHE_TTL_MS", 3_600_000),
    riskEvidenceCacheTtlMs: parsePositiveInteger(
      env,
      "HELIUS_RISK_EVIDENCE_CACHE_TTL_MS",
      3_600_000,
    ),
    backoffEnabled: parseBoolean(env, "HELIUS_BACKOFF_ENABLED", true),
    backoffBaseCooldownMs: parsePositiveInteger(env, "HELIUS_BACKOFF_BASE_COOLDOWN_MS", 60_000),
    backoffMaxCooldownMs: parsePositiveInteger(env, "HELIUS_BACKOFF_MAX_COOLDOWN_MS", 600_000),
    skipLowPriorityDuringCooldown: parseBoolean(
      env,
      "HELIUS_SKIP_LOW_PRIORITY_DURING_COOLDOWN",
      true,
    ),
  };
  const raydium: RaydiumProviderConfig = {
    txVersion: parseRaydiumTxVersion(env),
    diagnosticsEnabled: parseBoolean(env, "RAYDIUM_DIAGNOSTICS_ENABLED", true),
    precheckEnabled: parseBoolean(env, "RAYDIUM_PRECHECK_ENABLED", true),
    precheckTtlMs: parsePositiveInteger(env, "RAYDIUM_PRECHECK_TTL_MS", 60_000),
    preflightPoolType: parseEnumValue(
      env,
      "RAYDIUM_PREFLIGHT_POOL_TYPE",
      RAYDIUM_PREFLIGHT_POOL_TYPES,
      "all",
    ),
    preflightSortField: parseEnumValue(
      env,
      "RAYDIUM_PREFLIGHT_SORT_FIELD",
      RAYDIUM_PREFLIGHT_SORT_FIELDS,
      "liquidity",
    ),
    preflightSortType: parseEnumValue(
      env,
      "RAYDIUM_PREFLIGHT_SORT_TYPE",
      RAYDIUM_PREFLIGHT_SORT_TYPES,
      "desc",
    ),
    preflightPageSize: parseIntegerRange(env, "RAYDIUM_PREFLIGHT_PAGE_SIZE", 5, 1, 1_000),
    preflightPage: parsePositiveInteger(env, "RAYDIUM_PREFLIGHT_PAGE", 1, 1),
    mintPriceDiagnosticsEnabled: parseBoolean(env, "RAYDIUM_MINT_PRICE_DIAGNOSTICS_ENABLED", false),
    captureSanitizedErrorContext: parseBoolean(
      env,
      "RAYDIUM_CAPTURE_SANITIZED_ERROR_CONTEXT",
      true,
    ),
    maxErrorMessageLength: parsePositiveInteger(env, "RAYDIUM_MAX_ERROR_MESSAGE_LENGTH", 240),
    venueGuardEnabled: parseBoolean(env, "RAYDIUM_VENUE_GUARD_ENABLED", true),
    skipWhenDexScreenerVenueAbsent: parseBoolean(
      env,
      "RAYDIUM_SKIP_WHEN_DEXSCREENER_VENUE_ABSENT",
      true,
    ),
    requireDexScreenerRaydiumVenue: parseBoolean(
      env,
      "RAYDIUM_REQUIRE_DEXSCREENER_RAYDIUM_VENUE",
      false,
    ),
    negativeCacheTtlMs: parsePositiveInteger(env, "RAYDIUM_NEGATIVE_CACHE_TTL_MS", 300_000),
    negativeCacheMaxEntries: parsePositiveInteger(env, "RAYDIUM_NEGATIVE_CACHE_MAX_ENTRIES", 1_000),
  };
  const solanaRpc: SolanaRpcProviderConfig = {
    mintAccountCacheEnabled: parseBoolean(env, "SOLANA_RPC_MINT_ACCOUNT_CACHE_ENABLED", true),
    mintAccountCacheTtlMs: parsePositiveInteger(
      env,
      "SOLANA_RPC_MINT_ACCOUNT_CACHE_TTL_MS",
      900_000,
    ),
    useJsonParsed: parseBoolean(env, "SOLANA_RPC_USE_JSON_PARSED", true),
    base64FallbackEnabled: parseBoolean(env, "SOLANA_RPC_BASE64_FALLBACK_ENABLED", true),
  };
  const quickNodeDas: DasProviderConfig = {
    metadataEnabled: parseBoolean(env, "QUICKNODE_DAS_METADATA_ENABLED", true),
  };
  const alchemyDas: DasProviderConfig = {
    metadataEnabled: parseBoolean(env, "ALCHEMY_DAS_METADATA_ENABLED", true),
  };
  const birdeye: BirdeyeProviderConfig = {
    priceEnabled: parseBoolean(env, "BIRDEYE_PRICE_ENABLED", true),
    tokenOverviewEnabled: parseBoolean(env, "BIRDEYE_TOKEN_OVERVIEW_ENABLED", true),
    marketDataEnabled: parseBoolean(env, "BIRDEYE_MARKET_DATA_ENABLED", false),
    exitLiquidityEnabled: parseBoolean(env, "BIRDEYE_EXIT_LIQUIDITY_ENABLED", false),
    creditsCheckEnabled: parseBoolean(env, "BIRDEYE_CREDITS_CHECK_ENABLED", true),
    cacheEnabled: parseBoolean(env, "BIRDEYE_CACHE_ENABLED", true),
    cacheTtlMs: parsePositiveInteger(env, "BIRDEYE_CACHE_TTL_MS", 300_000),
    maxRequestsPerRun: parsePositiveInteger(env, "BIRDEYE_MAX_REQUESTS_PER_RUN", 60),
    maxCuPerRun: parsePositiveInteger(env, "BIRDEYE_MAX_CU_PER_RUN", 1_200),
    maxCandidatesPerCycle: parsePositiveInteger(env, "BIRDEYE_MAX_CANDIDATES_PER_CYCLE", 2),
    minScore: parsePositiveInteger(env, "BIRDEYE_MIN_SCORE", 50, 0),
    overviewFrames: parseStringList(env, "BIRDEYE_OVERVIEW_FRAMES", [
      "1m",
      "5m",
      "15m",
      "30m",
      "1h",
    ]),
  };
  const disabledProviders: DisabledProviderConfig[] = [];
  const enabledProviders: ProviderName[] = [];

  for (const provider of requestedProviders) {
    const disabledReason = getDisabledReason(provider, apiKeys, baseUrls);

    if (disabledReason) {
      disabledProviders.push({
        provider,
        reason: disabledReason,
      });
    } else {
      enabledProviders.push(provider);
    }
  }

  return {
    requestedProviders,
    enabledProviders,
    disabledProviders,
    timeoutMs,
    maxRetries,
    retryBackoffMs,
    allowRawPayloadLogging,
    writeProviderHealth,
    rateLimitsPerMinute,
    apiKeys,
    baseUrls,
    quoteResilience,
    alchemyDas,
    birdeye,
    helius,
    jupiter,
    quickNodeDas,
    raydium,
    solanaRpc,
  };
}

export function createProviderRuntimeOptions(
  config: ProviderConfig,
  provider: ProviderName,
  mode: ExecutionMode,
): ProviderRuntimeOptions {
  return {
    mode,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    retryBackoffMs: config.retryBackoffMs,
    rateLimitPerMinute: config.rateLimitsPerMinute[provider],
    allowRawPayloadLogging: config.allowRawPayloadLogging,
    strictValidation: true,
    writeProviderHealth: config.writeProviderHealth,
  };
}
