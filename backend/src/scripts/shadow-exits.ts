import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { parseShadowArgs, resolveShadowSourceDecisions } from "../shadow/ShadowConfig.js";
import { ShadowExitReportService } from "../shadow/ShadowExitReportService.js";
import { formatShadowExitJson, formatShadowExitReport } from "../shadow/ShadowReportFormatter.js";

async function runShadowExits(): Promise<void> {
  const shadowConfig = parseShadowArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`Shadow exits only run in PAPER mode. Current mode: ${appConfig.mode}.`);
  }

  const database = createPaperDatabaseContext();

  try {
    assertMigrationsApplied(database);

    const repositories = createRepositories(database.db);
    const report = new ShadowExitReportService({
      config: shadowConfig,
      repositories,
    }).generate();

    if (!shadowConfig.json) {
      console.log(`MODE: ${appConfig.mode}`);
      console.log(`Shadow exits once: ${shadowConfig.once ? "yes" : "default one-shot"}`);
      console.log(
        `Session: ${shadowConfig.sessionId ?? "latest RUNNING PAPER session with decisions"}`,
      );
      console.log(`Source decisions: ${resolveShadowSourceDecisions(shadowConfig).join(",")}`);
      console.log(`Include shadow scores: ${shadowConfig.includeShadowScores ? "yes" : "no"}`);
      console.log(`Shadow score min: ${shadowConfig.shadowScoreMin}`);
      console.log(`Targets pct: ${shadowConfig.targetPcts.join(",")}`);
      console.log(`Stops pct: ${shadowConfig.stopPcts.join(",")}`);
      console.log(`Max hold minutes: ${shadowConfig.maxHoldMinutes}`);
      console.log(`Starting balance SOL: ${shadowConfig.startingBalanceSol}`);
      console.log(`Position size SOL: ${shadowConfig.positionSizeSol}`);
      console.log(`Session goal pct: ${shadowConfig.sessionGoalPct}`);
      console.log("Wallet loaded: no");
      console.log("Transaction signing: disabled");
      console.log("Transaction submission: disabled");
      console.log("");
    }

    console.log(shadowConfig.json ? formatShadowExitJson(report) : formatShadowExitReport(report));
  } finally {
    database.close();
  }
}

runShadowExits().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown shadow exits failure.";
  console.error(message);
  process.exitCode = 1;
});
