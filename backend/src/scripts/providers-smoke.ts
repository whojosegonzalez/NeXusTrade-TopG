import { parseTokenMintAddress } from "@nexustrade/shared";

import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { stringifyJson } from "../db/utils/json.js";
import { MarketDataService } from "../providers/MarketDataService.js";
import { summarizeProviderPressureMetrics } from "../providers/ProviderPressureClassifier.js";
import { ProviderHealthService } from "../providers/ProviderHealthService.js";
import { createProviderRegistry } from "../providers/ProviderRegistry.js";
import type { BirdeyeAdapter } from "../providers/birdeye/BirdeyeAdapter.js";
import type {
  LiquidityProvider,
  PriceProvider,
  QuoteProvider,
  RiskEvidenceProvider,
  TokenMetadataProvider,
} from "../providers/interfaces/index.js";

const DEFAULT_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface SmokeArgs {
  readonly mint: string;
  readonly strict: boolean;
}

interface SmokeCheck {
  readonly label: string;
  readonly status: "ok" | "skipped" | "failed";
  readonly message?: string;
}

interface CheckProviderOptions {
  readonly toleratedErrorCodes?: readonly string[];
}

function parseArgs(argv: readonly string[]): SmokeArgs {
  const mintArg = argv.find((arg) => arg.startsWith("--mint="));

  return {
    mint: mintArg?.slice("--mint=".length) ?? DEFAULT_MINT,
    strict: argv.includes("--strict"),
  };
}

function formatProviders(providers: readonly string[]): string {
  return providers.length > 0 ? providers.join(", ") : "none";
}

function findByName<TProvider extends { readonly name: string }>(
  providers: readonly TProvider[],
  name: string,
): TProvider | undefined {
  return providers.find((provider) => provider.name === name);
}

function findQuoteAdapterByName(
  providers: readonly { readonly name: string }[],
  name: string,
): QuoteProvider | undefined {
  const provider = providers.find((candidate) => candidate.name === name);

  if (provider && "getQuote" in provider) {
    return provider as QuoteProvider;
  }

  return undefined;
}

function findBirdeyeAdapter(
  providers: readonly { readonly name: string }[],
): BirdeyeAdapter | undefined {
  const provider = providers.find((candidate) => candidate.name === "BIRDEYE");

  return provider && "getTokenOverview" in provider ? (provider as BirdeyeAdapter) : undefined;
}

async function runSmoke(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mintAddress = parseTokenMintAddress(args.mint);
  const outputMint = parseTokenMintAddress(USDC_MINT);
  const config = loadAppConfig();
  const smokeStartedAtMs = Date.now();

  if (config.mode !== "PAPER") {
    throw new Error(`Provider smoke tests only run in PAPER mode. Current mode: ${config.mode}.`);
  }

  const database = createPaperDatabaseContext();

  try {
    assertMigrationsApplied(database);

    const repos = createRepositories(database.db);
    const healthService = new ProviderHealthService({
      providerHealth: repos.providerHealth,
      systemLogs: repos.systemLogs,
      writeProviderHealth: config.providers.writeProviderHealth,
    });

    repos.systemLogs.createLog({
      level: "INFO",
      scope: "PROVIDER",
      message: "Provider smoke test started.",
      contextJson: stringifyJson({
        mintAddress,
        strict: args.strict,
      }),
    });

    for (const disabled of config.providers.disabledProviders) {
      healthService.recordDisabled(disabled.provider, disabled.reason);
    }

    const registry = createProviderRegistry({
      config: config.providers,
      mode: config.mode,
      healthService,
    });
    const marketData = new MarketDataService(registry);
    const checks: SmokeCheck[] = [];
    const strictDisabledProviders = args.strict
      ? config.providers.disabledProviders.filter((provider) => provider.provider !== "RUGCHECK")
      : [];

    for (const disabled of strictDisabledProviders) {
      checks.push({
        label: `${disabled.provider} configured`,
        status: "failed",
        message: disabled.reason,
      });
    }

    console.log(`MODE: ${config.mode}`);
    console.log(`Providers requested: ${formatProviders(config.providers.requestedProviders)}`);
    console.log(`Providers enabled: ${formatProviders(registry.listProviderNames())}`);
    console.log(
      `Quote budget planner: ${config.providers.quoteResilience.planner.enabled ? "enabled" : "disabled"} limit=${config.providers.quoteResilience.planner.maxCandidatesPerCycle}`,
    );
    console.log("Wallet loaded: no");
    console.log("Transaction signing: disabled");
    console.log("Transaction submission: disabled");
    console.log("");

    checks.push(
      await checkProvider(
        "DEXSCREENER pairs",
        findByName(registry.getLiquidityProviders(), "DEXSCREENER"),
        async (provider) => {
          const result = await provider.getBestPairForToken(mintAddress);
          return result.ok
            ? `best pair ${result.data.pairAddress}`
            : `${result.error.code}: ${result.error.message}`;
        },
      ),
    );

    checks.push(
      await checkProvider(
        "JUPITER price",
        findByName(registry.getPriceProviders(), "JUPITER"),
        async (provider) => {
          const result = await provider.getPrice(mintAddress);
          return result.ok
            ? `price ${result.data.priceUsd ?? "unknown"}`
            : `${result.error.code}: ${result.error.message}`;
        },
      ),
    );

    checks.push(
      await checkProvider(
        "BIRDEYE price",
        findByName(registry.getPriceProviders(), "BIRDEYE"),
        async (provider) => {
          const result = await provider.getPrice(mintAddress);
          return result.ok
            ? `price ${result.data.priceUsd ?? "unknown"}`
            : `${result.error.code}: ${result.error.message}`;
        },
      ),
    );

    checks.push(
      await checkProvider(
        "BIRDEYE overview",
        findBirdeyeAdapter(registry.listAdapters()),
        async (provider) => {
          const result = await provider.getTokenOverview(mintAddress, {
            selectionReason: "provider-smoke",
          });
          return result.ok
            ? `overview ${result.data.symbol ?? result.data.name ?? "partial"}`
            : `${result.error.code}: ${result.error.message}`;
        },
      ),
    );

    checks.push(
      await checkProvider("QUOTE router", registry.getQuoteProviders()[0], async (provider) => {
        const result = await provider.getQuote({
          inputMint: mintAddress,
          outputMint,
          amountRaw: "100000000",
          slippageBps: 100,
        });
        return result.ok
          ? `out ${result.data.outputAmountRaw}`
          : `${result.error.code}: ${result.error.message}`;
      }),
    );

    checks.push(
      await checkProvider(
        "RAYDIUM quote",
        findQuoteAdapterByName(registry.listAdapters(), "RAYDIUM"),
        async (provider) => {
          const result = await provider.getQuote({
            inputMint: mintAddress,
            outputMint,
            amountRaw: "100000000",
            slippageBps: 100,
          });
          return result.ok
            ? `out ${result.data.outputAmountRaw}`
            : `${result.error.code}: ${result.error.message}`;
        },
      ),
    );

    checks.push(
      await checkProvider(
        "HELIUS metadata",
        findByName(registry.getTokenMetadataProviders(), "HELIUS"),
        async (provider) => {
          const result = await provider.getTokenMetadata(mintAddress);
          return result.ok
            ? `metadata ${result.data.symbol ?? result.data.name ?? "partial"}`
            : `${result.error.code}: ${result.error.message}`;
        },
        {
          toleratedErrorCodes: args.strict ? [] : ["RATE_LIMITED"],
        },
      ),
    );

    checks.push(
      await checkProvider(
        "SOLANA_RPC authority evidence",
        findByName(registry.getRiskEvidenceProviders(), "SOLANA_RPC"),
        async (provider) => {
          const result = await provider.getRiskEvidence(mintAddress);
          return result.ok
            ? `mint ${result.data.mintAuthorityState ?? "unknown"} freeze ${
                result.data.freezeAuthorityState ?? "unknown"
              } source ${result.data.authorityEvidenceSource ?? result.data.source}`
            : `${result.error.code}: ${result.error.message}`;
        },
      ),
    );

    checks.push(
      await checkProvider(
        "QUICKNODE_DAS metadata",
        findByName(registry.getTokenMetadataProviders(), "QUICKNODE_DAS"),
        async (provider) => {
          const result = await provider.getTokenMetadata(mintAddress);
          return result.ok
            ? `metadata ${result.data.symbol ?? result.data.name ?? "partial"}`
            : `${result.error.code}: ${result.error.message}`;
        },
      ),
    );

    checks.push(
      await checkProvider(
        "ALCHEMY_DAS metadata",
        findByName(registry.getTokenMetadataProviders(), "ALCHEMY_DAS"),
        async (provider) => {
          const result = await provider.getTokenMetadata(mintAddress);
          return result.ok
            ? `metadata ${result.data.symbol ?? result.data.name ?? "partial"}`
            : `${result.error.code}: ${result.error.message}`;
        },
      ),
    );

    const enrichment = await marketData.enrichToken({ mintAddress });
    checks.push({
      label: "MarketDataService enrichment",
      status: enrichment.ok ? "ok" : "failed",
      message: enrichment.ok
        ? `sources ${formatProviders(enrichment.data.sourcesUsed)}`
        : enrichment.error.message,
    });

    const latestProviderHealth = repos.providerHealth.listProviderHealth({ limit: 1 });
    const recentProviderLogs = repos.systemLogs.listLogs({ scope: "PROVIDER", limit: 1 });

    checks.push({
      label: "ProviderHealth writes",
      status: latestProviderHealth.length > 0 ? "ok" : "failed",
    });
    checks.push({
      label: "SystemLog writes",
      status: recentProviderLogs.length > 0 ? "ok" : "failed",
    });

    const smokeProviderHealth = repos.providerHealth.listProviderHealth({
      fromMs: smokeStartedAtMs,
      limit: 500,
    });
    const smokeProviderPressure = summarizeProviderPressureMetrics(smokeProviderHealth);

    checks.push({
      label: "Provider diagnostics",
      status: "ok",
      message: formatProviderDiagnostics(smokeProviderPressure),
    });

    repos.systemLogs.createLog({
      level: checks.some((check) => check.status === "failed") ? "ERROR" : "INFO",
      scope: "PROVIDER",
      message: "Provider smoke test finished.",
      contextJson: stringifyJson({
        checks,
      }),
    });

    for (const check of checks) {
      console.log(`${check.label}: ${check.status}${check.message ? ` (${check.message})` : ""}`);
    }

    const failedChecks = checks.filter((check) => check.status === "failed");

    if (failedChecks.length > 0) {
      console.log("");
      console.log("Result: provider smoke check failed");
      process.exitCode = 1;
      return;
    }

    console.log("");
    console.log("Result: provider smoke check passed");
  } finally {
    database.close();
  }
}

async function checkProvider<
  TProvider extends
    | LiquidityProvider
    | PriceProvider
    | QuoteProvider
    | RiskEvidenceProvider
    | TokenMetadataProvider,
>(
  label: string,
  provider: TProvider | undefined,
  run: (provider: TProvider) => Promise<string>,
  options: CheckProviderOptions = {},
): Promise<SmokeCheck> {
  if (!provider) {
    return {
      label,
      status: "skipped",
      message: "provider not enabled",
    };
  }

  const message = await run(provider);
  const errorCode = readProviderErrorCode(message);

  if (errorCode && options.toleratedErrorCodes?.includes(errorCode)) {
    return {
      label,
      status: "skipped",
      message,
    };
  }

  if (errorCode) {
    return {
      label,
      status: "failed",
      message,
    };
  }

  return {
    label,
    status: "ok",
    message,
  };
}

function readProviderErrorCode(message: string): string | undefined {
  const match = /^([A-Z_]+):/.exec(message);

  return match?.[1];
}

function formatProviderDiagnostics(
  pressure: ReturnType<typeof summarizeProviderPressureMetrics>,
): string {
  return [
    `rows=${pressure.totalRows}`,
    `liveRateLimited=${pressure.liveRateLimitedPct.toFixed(2)}%`,
    `combinedRateLimited=${pressure.combinedRateLimitedPct.toFixed(2)}%`,
    `cacheHits=${pressure.routerCacheHits}`,
    `cooldownSkips=${pressure.routerCooldownSkips}`,
    `quoteSchedulerWaitMs=${pressure.quoteSchedulerWaitMsTotal}`,
    `quoteSingleFlightJoins=${pressure.quoteSingleFlightJoinCount}`,
    `quoteNegativeCacheHits=${pressure.quoteNegativeCacheHitCount}`,
    `liveQuoteCallsAvoided=${pressure.liveQuoteCallsAvoidedEstimate}`,
    `jupiterDemandDeferred=${pressure.jupiterDemandDeferredCount}`,
    `jupiterDemandAllowed=${pressure.jupiterLiveAllowedCount}`,
    `jupiter429Observed=${pressure.jupiterControllerRateLimitObservedCount}`,
    `jupiterIntervalAvgMs=${pressure.jupiterEffectiveIntervalMsAverage.toFixed(0)}`,
    `jupiterAdaptiveMax=${pressure.jupiterAdaptiveLevelMax}`,
    `jupiterWindowUsageMax=${pressure.jupiterSharedWindowUsageMax}`,
    formatCounts("quoteDemand", pressure.quoteDemandActionCounts),
    formatCounts("jupiterDemand", pressure.jupiterDemandActionCounts),
    formatCounts("jupiterOperations", pressure.jupiterDemandOperationCounts),
    formatCounts("jupiterPriorities", pressure.jupiterDemandPriorityCounts),
    formatCounts("negativeCacheReasons", pressure.quoteNegativeCacheReasonCounts),
    formatCounts("raydiumVenueGuard", pressure.raydiumVenueGuardDecisionCounts),
    formatCounts("raydiumVenueReasons", pressure.raydiumVenueGuardReasonCounts),
    formatCounts("raydiumFailures", pressure.raydiumFailureCategoryCounts),
    formatCounts("raydiumFailureDetails", pressure.raydiumFailureDetailCounts),
    formatCounts("raydiumPreflight", pressure.raydiumPreflightStatusCounts),
    formatCounts("raydiumPreflightDetails", pressure.raydiumPreflightFailureDetailCounts),
    formatCounts("httpEndpoints", pressure.httpEndpointIdCounts),
    formatCounts("httpOutcomes", pressure.httpAttemptOutcomeCounts),
    formatCounts("httpStatuses", pressure.httpStatusCodeCounts),
    formatCounts("quoteLatest", pressure.quoteLatestAttemptOutcomeCounts),
    formatCounts("quoteLastSuccess", pressure.quoteLastSuccessfulProviderCounts),
    formatCounts("quoteDivergence", pressure.quoteLatestVsLastSuccessDivergenceCounts),
    formatCounts("authoritySources", pressure.authorityEvidenceSourceCounts),
    formatCounts("mintAuthority", pressure.mintAuthorityStateCounts),
    formatCounts("freezeAuthority", pressure.freezeAuthorityStateCounts),
    formatCounts("rpcCache", pressure.rpcCacheStatusCounts),
    formatCounts("rpcFailures", pressure.rpcFailureCategoryCounts),
    formatCounts("dasProviders", pressure.dasProviderCounts),
    formatCounts("dasFailures", pressure.dasFailureCategoryCounts),
    formatCounts("heliusSources", pressure.heliusEvidenceSourceCounts),
    formatCounts("heliusCache", pressure.heliusCacheStatusCounts),
    formatCounts("birdeyeEndpoints", pressure.birdeyeEndpointCounts),
    formatCounts("birdeyeCache", pressure.birdeyeCacheStatusCounts),
    formatCounts("birdeyeFailures", pressure.birdeyeFailureCategoryCounts),
    formatCounts("birdeyeReasons", pressure.birdeyeSelectionReasonCounts),
    formatCounts("birdeyeBudget", pressure.birdeyeBudgetReasonCounts),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

function formatCounts(label: string, counts: Readonly<Record<string, number>>): string {
  const formatted = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");

  return formatted ? `${label}=${formatted}` : "";
}

runSmoke().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown provider smoke failure.";
  console.error(message);
  process.exitCode = 1;
});
