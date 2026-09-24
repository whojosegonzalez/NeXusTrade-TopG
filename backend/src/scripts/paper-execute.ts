import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { formatLamportsAsSol } from "../paper/PaperMath.js";
import { parsePaperExchangeArgs } from "../paper/PaperExchangeConfig.js";
import { PaperRunner } from "../paper/PaperRunner.js";

async function runPaperExecute(): Promise<void> {
  const paperConfig = parsePaperExchangeArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`Paper execution only runs in PAPER mode. Current mode: ${appConfig.mode}.`);
  }

  const database = createPaperDatabaseContext();

  try {
    assertMigrationsApplied(database);

    const repositories = createRepositories(database.db);
    const runner = new PaperRunner({
      config: paperConfig,
      repositories,
    });

    console.log(`MODE: ${appConfig.mode}`);
    console.log(`Paper execution once: ${paperConfig.once ? "yes" : "default one-shot"}`);
    console.log(`Paper execution dry-run: ${paperConfig.dryRun ? "yes" : "no"}`);
    console.log(
      `Session: ${paperConfig.sessionId ?? "latest RUNNING PAPER session with approved BUY candidates"}`,
    );
    console.log(`Buy size SOL: ${formatLamportsAsSol(paperConfig.buySolLamports)}`);
    console.log(`Candidate limit: ${paperConfig.limit}`);
    console.log(`Base fee lamports: ${paperConfig.baseFeeLamports}`);
    console.log(`Priority fee lamports: ${paperConfig.priorityFeeLamports}`);
    console.log(`Slippage bps: ${paperConfig.slippageBps}`);
    console.log("Wallet loaded: no");
    console.log("Transaction signing: disabled");
    console.log("Transaction submission: disabled");
    console.log("");

    const result = await runner.run();

    console.log(
      `Paper execution summary: session=${result.sessionId} selected=${result.selectedCount} evaluated=${result.evaluatedCount} executed=${result.executedCount} rejected=${result.rejectedCount} failed=${result.failedCount} orders=${result.orderCreatedCount} fills=${result.fillCreatedCount} openedPositions=${result.openedPositionCount} cashUpdated=${result.cashUpdatedCount} radarStatusUpdated=${result.radarStatusUpdatedCount} duplicateRejected=${result.duplicatePositionRejectedCount} insufficientCashRejected=${result.insufficientCashRejectedCount} missingPriceRejected=${result.missingPriceRejectedCount} missingRisk=${result.missingRiskAssessmentCount}`,
    );
  } finally {
    database.close();
  }
}

runPaperExecute().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown paper execution failure.";
  console.error(message);
  process.exitCode = 1;
});
