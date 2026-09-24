import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { parseExitManagerArgs } from "../exits/ExitManagerConfig.js";
import { ExitManagerRunner } from "../exits/ExitManagerRunner.js";
import { MarketDataService } from "../providers/MarketDataService.js";
import { ProviderHealthService } from "../providers/ProviderHealthService.js";
import { createProviderRegistry } from "../providers/ProviderRegistry.js";

async function runExitManager(): Promise<void> {
  const exitConfig = parseExitManagerArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`ExitManager only runs in PAPER mode. Current mode: ${appConfig.mode}.`);
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
    const runner = new ExitManagerRunner({
      config: exitConfig,
      repositories,
      marketDataService,
    });

    console.log(`MODE: ${appConfig.mode}`);
    console.log(`ExitManager once: ${exitConfig.once ? "yes" : "no"}`);
    console.log(`ExitManager dry-run: ${exitConfig.dryRun ? "yes" : "no"}`);
    console.log(`Session: ${exitConfig.sessionId ?? "latest gated RUNNING PAPER session"}`);
    console.log(`Target action: ${exitConfig.targetAction}`);
    console.log(`Drawdown action: ${exitConfig.drawdownAction}`);
    console.log(`Complete session on exit: ${exitConfig.completeSessionOnExit ? "yes" : "no"}`);
    console.log(`Candidate limit: ${exitConfig.limit}`);
    console.log(`Base fee lamports: ${exitConfig.baseFeeLamports}`);
    console.log(`Priority fee lamports: ${exitConfig.priorityFeeLamports}`);
    console.log(`Slippage bps: ${exitConfig.slippageBps}`);
    console.log(
      `Cached TokenRadar price fallback: ${exitConfig.allowCachedRadarPrice ? "enabled" : "disabled"}`,
    );
    console.log(`Providers enabled: ${registry.listProviderNames().join(", ") || "none"}`);
    console.log("Wallet loaded: no");
    console.log("Transaction signing: disabled");
    console.log("Transaction submission: disabled");
    console.log("");

    const result = await runner.run();

    console.log(
      `ExitManager summary: session=${result.sessionId} terminationReason=${result.terminationReason} trigger=${result.trigger} action=${result.action} positionsOpenBefore=${result.positionsOpenBefore} positionsOpenAfter=${result.positionsOpenAfter} positionsSelected=${result.positionsSelected} positionsClosed=${result.positionsClosed} sellRejected=${result.sellRejected} sellFailures=${result.sellFailures} orders=${result.orderCreatedCount} fills=${result.fillCreatedCount} cashUpdated=${result.cashUpdatedCount} radarStatusUpdated=${result.radarStatusUpdatedCount} net=${result.totalNetProceedsLamports} realizedPnl=${result.totalRealizedPnlLamports} sessionCompleted=${result.sessionCompleted ? "yes" : "no"} dryRun=${result.dryRun ? "yes" : "no"}`,
    );
  } finally {
    database.close();
  }
}

runExitManager().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown ExitManager failure.";
  console.error(message);
  process.exitCode = 1;
});
