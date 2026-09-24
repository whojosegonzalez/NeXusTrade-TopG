import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { ProviderHealthService } from "../providers/ProviderHealthService.js";
import { createProviderRegistry } from "../providers/ProviderRegistry.js";
import { MarketDataService } from "../providers/MarketDataService.js";
import { parseScannerArgs } from "../scanner/ScannerConfig.js";
import { ScannerRunner } from "../scanner/ScannerRunner.js";

async function runScannerDiscover(): Promise<void> {
  const scannerConfig = parseScannerArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`Scanner discover only runs in PAPER mode. Current mode: ${appConfig.mode}.`);
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
    const marketDataService = new MarketDataService(registry);
    const providerNames = registry.listProviderNames();
    const discoveryProviderNames = registry
      .getTokenDiscoveryProviders()
      .map((provider) => provider.name);
    const runner = new ScannerRunner({
      config: scannerConfig,
      repositories,
      registry,
      marketDataService,
    });

    process.once("SIGINT", () => {
      console.log("Scanner stop requested. Finishing current cycle...");
      runner.stop();
    });

    console.log(`MODE: ${appConfig.mode}`);
    console.log(`Scanner once: ${scannerConfig.once ? "yes" : "no"}`);
    console.log(`Scanner dry-run: ${scannerConfig.dryRun ? "yes" : "no"}`);
    console.log(`Interval ms: ${scannerConfig.intervalMs}`);
    console.log(`Candidate limit: ${scannerConfig.limit}`);
    console.log(`Enrichment concurrency: ${scannerConfig.concurrency}`);
    console.log(`Session: ${scannerConfig.sessionId ?? "auto-create"}`);
    console.log(`Providers enabled: ${providerNames.join(", ") || "none"}`);
    console.log(`Discovery providers: ${discoveryProviderNames.join(", ") || "none"}`);
    console.log("Wallet loaded: no");
    console.log("Transaction signing: disabled");
    console.log("Transaction submission: disabled");
    console.log("");

    const result = await runner.run();

    if (result) {
      console.log(
        `Cycle summary: discovered=${result.discoveredCount} unique=${result.uniqueCount} enriched=${result.enrichedCount} stored=${result.storedCount} errors=${result.errorCount}`,
      );
    }
  } finally {
    database.close();
  }
}

runScannerDiscover().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown scanner discover failure.";
  console.error(message);
  process.exitCode = 1;
});
