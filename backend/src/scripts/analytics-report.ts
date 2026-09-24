import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { parseAnalyticsArgs } from "../analytics/AnalyticsConfig.js";
import {
  formatAnalyticsJson,
  formatAnalyticsReport,
} from "../analytics/AnalyticsReportFormatter.js";
import { AnalyticsReportService } from "../analytics/AnalyticsReportService.js";

async function runAnalyticsReport(): Promise<void> {
  const analyticsConfig = parseAnalyticsArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`Analytics report only runs in PAPER mode. Current mode: ${appConfig.mode}.`);
  }

  const database = createPaperDatabaseContext();

  try {
    assertMigrationsApplied(database);

    const repositories = createRepositories(database.db);
    const service = new AnalyticsReportService({
      config: analyticsConfig,
      repositories,
    });
    const report = service.generate();

    if (!analyticsConfig.json) {
      console.log(`MODE: ${appConfig.mode}`);
      console.log(`Analytics once: ${analyticsConfig.once ? "yes" : "default one-shot"}`);
      console.log(`Session: ${analyticsConfig.sessionId ?? "latest PAPER session with rows"}`);
      console.log(`Since hours: ${analyticsConfig.sinceHours}`);
      console.log(`Limit: ${analyticsConfig.limit}`);
      console.log(`Score bucket size: ${analyticsConfig.scoreBucketSize}`);
      console.log(`Near miss min score: ${analyticsConfig.nearMissMinScore}`);
      console.log(`Provider since hours: ${analyticsConfig.providerSinceHours}`);
      console.log(`Missed opportunity limit: ${analyticsConfig.missedOpportunityLimit}`);
      console.log("Wallet loaded: no");
      console.log("Transaction signing: disabled");
      console.log("Transaction submission: disabled");
      console.log("");
    }

    console.log(analyticsConfig.json ? formatAnalyticsJson(report) : formatAnalyticsReport(report));
  } finally {
    database.close();
  }
}

runAnalyticsReport().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown analytics report failure.";
  console.error(message);
  process.exitCode = 1;
});
