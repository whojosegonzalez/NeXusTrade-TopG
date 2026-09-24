import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { MarketDataService } from "../providers/MarketDataService.js";
import { ProviderHealthService } from "../providers/ProviderHealthService.js";
import { createProviderRegistry } from "../providers/ProviderRegistry.js";
import { parseRiskArgs } from "../risk/RiskConfig.js";
import { RiskRunner } from "../risk/RiskRunner.js";

async function runRiskEvaluate(): Promise<void> {
  const riskConfig = parseRiskArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`Risk evaluation only runs in PAPER mode. Current mode: ${appConfig.mode}.`);
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
    const quoteProviderNames = registry.getQuoteProviders().map((provider) => provider.name);
    const runner = new RiskRunner({
      config: riskConfig,
      repositories,
      marketDataService,
      quoteBudgetPlannerConfig: appConfig.providers.quoteResilience.planner,
    });

    console.log(`MODE: ${appConfig.mode}`);
    console.log(`Risk once: ${riskConfig.once ? "yes" : "default one-shot"}`);
    console.log(`Risk dry-run: ${riskConfig.dryRun ? "yes" : "no"}`);
    console.log(`Statuses: ${riskConfig.statuses.join(",")}`);
    console.log(`Since hours: ${riskConfig.sinceHours}`);
    console.log(`Candidate limit: ${riskConfig.limit}`);
    console.log(`Concurrency: ${riskConfig.concurrency}`);
    console.log(`Quote probe: ${riskConfig.probeAmountSol} SOL`);
    console.log(
      `Quote budget planner: ${appConfig.providers.quoteResilience.planner.enabled ? "enabled" : "disabled"} limit=${appConfig.providers.quoteResilience.planner.maxCandidatesPerCycle}`,
    );
    console.log(
      `Session: ${riskConfig.sessionId ?? "latest RUNNING PAPER session with candidates"}`,
    );
    console.log(`Providers enabled: ${providerNames.join(", ") || "none"}`);
    console.log(`Quote providers: ${quoteProviderNames.join(", ") || "none"}`);
    console.log("Wallet loaded: no");
    console.log("Transaction signing: disabled");
    console.log("Transaction submission: disabled");
    console.log("");

    const result = await runner.run();

    console.log(
      `Risk summary: session=${result.sessionId} selected=${result.selectedCount} evaluated=${result.evaluatedCount} quoteBudgetSelected=${result.quoteBudgetSelectedCount} quoteBudgetNotSelected=${result.quoteBudgetNotSelectedCount} PASS=${result.passCount} WARN=${result.warnCount} FAIL=${result.failCount} UNKNOWN=${result.unknownCount} written=${result.writtenCount} statusUpdated=${result.statusUpdatedCount} errors=${result.errorCount}`,
    );
  } finally {
    database.close();
  }
}

runRiskEvaluate().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown risk evaluation failure.";
  console.error(message);
  process.exitCode = 1;
});
