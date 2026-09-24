import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { MarketDataService } from "../providers/MarketDataService.js";
import { ProviderHealthService } from "../providers/ProviderHealthService.js";
import { createProviderRegistry } from "../providers/ProviderRegistry.js";
import { parseFastShadowArgs } from "../shadow-fast/FastShadowConfig.js";
import {
  formatFastShadowObservationJson,
  formatFastShadowObservationSummary,
} from "../shadow-fast/FastShadowFormatter.js";
import { FastShadowObservationRunner } from "../shadow-fast/FastShadowObservationRunner.js";

async function main(): Promise<void> {
  const config = parseFastShadowArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();
  if (appConfig.mode !== "PAPER") {
    throw new Error(
      `Fast shadow observation requires MODE=PAPER. Current mode: ${appConfig.mode}.`,
    );
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
    const runner = new FastShadowObservationRunner({
      config,
      repositories,
      marketDataService: new MarketDataService(registry),
    });

    if (!config.json) {
      console.log(`MODE: ${appConfig.mode}`);
      console.log("Fast shadow profile: F65E@v1");
      console.log(`Session: ${config.sessionId}`);
      console.log(`Once: ${config.once ? "yes" : "no"}`);
      console.log(`Max runtime minutes: ${config.maxRuntimeMinutes ?? "not set"}`);
      console.log(`Interval ms: ${config.intervalMs}`);
      console.log("Paper execution: disabled");
      console.log("Wallet loaded: no");
      console.log("Transaction signing: disabled");
      console.log("Transaction submission: disabled");
      console.log("");
    }

    const deadlineMs = config.maxRuntimeMinutes
      ? Date.now() + config.maxRuntimeMinutes * 60_000
      : undefined;
    let shouldStop = false;
    process.once("SIGINT", () => {
      shouldStop = true;
      console.log("Fast shadow observation stop requested.");
    });

    do {
      const summary = await runner.runOnce();
      console.log(
        config.json
          ? formatFastShadowObservationJson(summary)
          : formatFastShadowObservationSummary(summary),
      );
      if (config.once || shouldStop || deadlineMs === undefined || Date.now() >= deadlineMs) break;
      await sleep(Math.min(config.intervalMs, Math.max(0, deadlineMs - Date.now())));
    } while (!shouldStop);
  } finally {
    database.close();
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Unknown fast shadow observation failure.",
  );
  process.exitCode = 1;
});
