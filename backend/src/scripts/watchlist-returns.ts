import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { MarketDataService } from "../providers/MarketDataService.js";
import { ProviderHealthService } from "../providers/ProviderHealthService.js";
import { createProviderRegistry } from "../providers/ProviderRegistry.js";
import { parseWatchlistReturnArgs } from "../watchlist/WatchlistReturnConfig.js";
import {
  formatWatchlistReturnJson,
  formatWatchlistReturnSummary,
} from "../watchlist/WatchlistReturnFormatter.js";
import { WatchlistReturnRunner } from "../watchlist/WatchlistReturnRunner.js";

async function runWatchlistReturns(): Promise<void> {
  const watchlistConfig = parseWatchlistReturnArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`Watchlist returns only run in PAPER mode. Current mode: ${appConfig.mode}.`);
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
    const runner = new WatchlistReturnRunner({
      config: watchlistConfig,
      repositories,
      marketDataService: new MarketDataService(registry),
    });

    if (!watchlistConfig.json) {
      console.log(`MODE: ${appConfig.mode}`);
      console.log(`Watchlist returns once: ${watchlistConfig.once ? "yes" : "default one-shot"}`);
      console.log(`Watchlist returns dry-run: ${watchlistConfig.dryRun ? "yes" : "no"}`);
      console.log(`Session: ${watchlistConfig.sessionId ?? "latest PAPER session with decisions"}`);
      console.log(`Since hours: ${watchlistConfig.sinceHours}`);
      console.log(`Limit: ${watchlistConfig.limit}`);
      console.log(`Horizons minutes: ${watchlistConfig.horizonsMinutes.join(",")}`);
      console.log(`Source decisions: ${watchlistConfig.sourceDecisions.join(",")}`);
      console.log(`Min score: ${watchlistConfig.minScore}`);
      console.log(`Max late minutes: ${watchlistConfig.maxLateMinutes}`);
      console.log(`Providers enabled: ${registry.listProviderNames().join(", ") || "none"}`);
      console.log("Wallet loaded: no");
      console.log("Transaction signing: disabled");
      console.log("Transaction submission: disabled");
      console.log("");
    }

    const result = await runner.run();

    console.log(
      watchlistConfig.json
        ? formatWatchlistReturnJson(result)
        : formatWatchlistReturnSummary(result),
    );
  } finally {
    database.close();
  }
}

runWatchlistReturns().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown watchlist returns failure.";
  console.error(message);
  process.exitCode = 1;
});
