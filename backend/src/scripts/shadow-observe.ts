import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { MarketDataService } from "../providers/MarketDataService.js";
import { ProviderHealthService } from "../providers/ProviderHealthService.js";
import { createProviderRegistry } from "../providers/ProviderRegistry.js";
import { parseShadowArgs, resolveShadowSourceDecisions } from "../shadow/ShadowConfig.js";
import { ShadowObservationRunner, toWatchlistConfig } from "../shadow/ShadowObservationRunner.js";
import {
  formatWatchlistReturnJson,
  formatWatchlistReturnSummary,
} from "../watchlist/WatchlistReturnFormatter.js";

async function runShadowObserve(): Promise<void> {
  const shadowConfig = parseShadowArgs(process.argv.slice(2));
  const watchlistConfig = toWatchlistConfig(shadowConfig);
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`Shadow observe only runs in PAPER mode. Current mode: ${appConfig.mode}.`);
  }

  const database = createPaperDatabaseContext();

  try {
    assertMigrationsApplied(database);

    const repositories = createRepositories(database.db);
    const healthService = new ProviderHealthService({
      providerHealth: repositories.providerHealth,
      systemLogs: repositories.systemLogs,
      writeProviderHealth: appConfig.providers.writeProviderHealth,
    });
    const registry = createProviderRegistry({
      config: appConfig.providers,
      mode: appConfig.mode,
      healthService,
    });
    const runner = new ShadowObservationRunner({
      config: shadowConfig,
      repositories,
      marketDataService: new MarketDataService(registry),
    });

    if (!shadowConfig.json) {
      console.log(`MODE: ${appConfig.mode}`);
      console.log(`Shadow observe once: ${shadowConfig.once ? "yes" : "default one-shot"}`);
      console.log(`Shadow observe dry-run: ${shadowConfig.dryRun ? "yes" : "no"}`);
      console.log(
        `Session: ${shadowConfig.sessionId ?? "latest RUNNING PAPER session with decisions"}`,
      );
      console.log(`Source decisions: ${resolveShadowSourceDecisions(shadowConfig).join(",")}`);
      console.log(`Include shadow scores: ${shadowConfig.includeShadowScores ? "yes" : "no"}`);
      console.log(`Shadow score min: ${shadowConfig.shadowScoreMin}`);
      console.log(`Horizons minutes: ${shadowConfig.horizonsMinutes.join(",")}`);
      console.log(`Max late minutes: ${shadowConfig.maxLateMinutes}`);
      console.log(`Watchlist min score: ${watchlistConfig.minScore}`);
      console.log(`Providers enabled: ${registry.listProviderNames().join(", ") || "none"}`);
      console.log("Wallet loaded: no");
      console.log("Transaction signing: disabled");
      console.log("Transaction submission: disabled");
      console.log("");
    }

    const result = await runner.run();

    console.log(
      shadowConfig.json ? formatWatchlistReturnJson(result) : formatWatchlistReturnSummary(result),
    );
  } finally {
    database.close();
  }
}

runShadowObserve().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown shadow observe failure.";
  console.error(message);
  process.exitCode = 1;
});
