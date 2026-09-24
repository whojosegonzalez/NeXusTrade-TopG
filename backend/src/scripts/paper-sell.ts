import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { MarketDataService } from "../providers/MarketDataService.js";
import { ProviderHealthService } from "../providers/ProviderHealthService.js";
import { createProviderRegistry } from "../providers/ProviderRegistry.js";
import { parsePaperSellArgs } from "../paper/PaperSellConfig.js";
import { PaperSellRunner } from "../paper/PaperSellRunner.js";

async function runPaperSell(): Promise<void> {
  const paperSellConfig = parsePaperSellArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`Paper sell only runs in PAPER mode. Current mode: ${appConfig.mode}.`);
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
    const runner = new PaperSellRunner({
      config: paperSellConfig,
      repositories,
      marketDataService,
    });

    console.log(`MODE: ${appConfig.mode}`);
    console.log(`Paper sell once: ${paperSellConfig.once ? "yes" : "default one-shot"}`);
    console.log(`Paper sell dry-run: ${paperSellConfig.dryRun ? "yes" : "no"}`);
    console.log(`Trigger: ${formatTrigger(paperSellConfig.trigger)}`);
    console.log(
      `Session: ${paperSellConfig.sessionId ?? "latest RUNNING PAPER session with open positions"}`,
    );
    console.log(`Candidate limit: ${paperSellConfig.limit}`);
    console.log(`Base fee lamports: ${paperSellConfig.baseFeeLamports}`);
    console.log(`Priority fee lamports: ${paperSellConfig.priorityFeeLamports}`);
    console.log(`Slippage bps: ${paperSellConfig.slippageBps}`);
    console.log(
      `Cached TokenRadar price fallback: ${paperSellConfig.allowCachedRadarPrice ? "enabled" : "disabled"}`,
    );
    console.log(`Providers enabled: ${registry.listProviderNames().join(", ") || "none"}`);
    console.log("Wallet loaded: no");
    console.log("Transaction signing: disabled");
    console.log("Transaction submission: disabled");
    console.log("");

    const result = await runner.run();

    console.log(
      `Paper sell summary: session=${result.sessionId} selected=${result.selectedCount} evaluated=${result.evaluatedCount} quoted=${result.quotedCount} refreshedPrice=${result.refreshedPriceCount} cachedFallback=${result.cachedFallbackCount} closed=${result.closedCount} rejected=${result.rejectedCount} failed=${result.failedCount} orders=${result.orderCreatedCount} fills=${result.fillCreatedCount} cashUpdated=${result.cashUpdatedCount} radarStatusUpdated=${result.radarStatusUpdatedCount} gross=${result.totalGrossProceedsLamports} net=${result.totalNetProceedsLamports} realizedPnl=${result.totalRealizedPnlLamports} fees=${result.totalSellFeesLamports} slippage=${result.totalSlippageLamports}`,
    );
  } finally {
    database.close();
  }
}

function formatTrigger(trigger: ReturnType<typeof parsePaperSellArgs>["trigger"]): string {
  return trigger.type === "SELL_ALL" ? "SELL_ALL" : `MINT ${trigger.mintAddress}`;
}

runPaperSell().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown paper sell failure.";
  console.error(message);
  process.exitCode = 1;
});
