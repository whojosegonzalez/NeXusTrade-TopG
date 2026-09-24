import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { ProviderHealthService } from "../providers/ProviderHealthService.js";
import { createProviderRegistry } from "../providers/ProviderRegistry.js";
import { parseQuoteDiagnoseArgs } from "../quote-diagnostics/QuoteDiagnoseConfig.js";
import {
  formatQuoteDiagnoseJson,
  formatQuoteDiagnoseReport,
  writeQuoteDiagnoseArtifacts,
} from "../quote-diagnostics/QuoteDiagnoseReportFormatter.js";
import { QuoteDiagnoseRunner } from "../quote-diagnostics/QuoteDiagnoseRunner.js";

async function runQuoteDiagnose(): Promise<void> {
  const diagnoseConfig = parseQuoteDiagnoseArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`quote:diagnose only runs in PAPER mode. Current mode: ${appConfig.mode}.`);
  }

  const database = createPaperDatabaseContext();

  try {
    assertMigrationsApplied(database);

    const repositories = createRepositories(database.db);
    const startedAtMs = Date.now();
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
    const report = await new QuoteDiagnoseRunner({
      config: diagnoseConfig,
      providerConfig: appConfig.providers,
      registry,
      providerHealthRowsBefore: 0,
      readProviderHealthRowsAfter: () =>
        repositories.providerHealth.listProviderHealth({
          fromMs: startedAtMs,
          limit: 10_000,
        }).length,
    }).run();

    if (diagnoseConfig.outputDir) {
      writeQuoteDiagnoseArtifacts({
        report,
        outputDir: diagnoseConfig.outputDir,
      });
    }

    if (!diagnoseConfig.json) {
      console.log(`MODE: ${appConfig.mode}`);
      console.log("quote:diagnose once: yes");
      console.log(`mode: ${diagnoseConfig.mode}`);
      console.log(`Providers enabled: ${registry.listProviderNames().join(", ") || "none"}`);
      console.log(
        `Quote budget planner: ${appConfig.providers.quoteResilience.planner.enabled ? "enabled" : "disabled"} limit=${appConfig.providers.quoteResilience.planner.maxCandidatesPerCycle}`,
      );
      console.log("Session creation: disabled");
      console.log("Paper execution: disabled");
      console.log("Wallet loaded: no");
      console.log("Transaction signing: disabled");
      console.log("Transaction submission: disabled");
      console.log("");
    }

    console.log(
      diagnoseConfig.json ? formatQuoteDiagnoseJson(report) : formatQuoteDiagnoseReport(report),
    );
  } finally {
    database.close();
  }
}

runQuoteDiagnose().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown quote diagnose failure.";
  console.error(message);
  process.exitCode = 1;
});
