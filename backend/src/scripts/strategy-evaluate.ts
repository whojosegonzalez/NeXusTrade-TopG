import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { parseStrategyArgs } from "../strategy/StrategyConfig.js";
import { StrategyRunner } from "../strategy/StrategyRunner.js";

async function runStrategyEvaluate(): Promise<void> {
  const strategyConfig = parseStrategyArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(
      `Strategy evaluation only runs in PAPER mode. Current mode: ${appConfig.mode}.`,
    );
  }

  const database = createPaperDatabaseContext();

  try {
    assertMigrationsApplied(database);

    const repositories = createRepositories(database.db);
    const runner = new StrategyRunner({
      config: strategyConfig,
      repositories,
    });

    console.log(`MODE: ${appConfig.mode}`);
    console.log(`Strategy once: ${strategyConfig.once ? "yes" : "default one-shot"}`);
    console.log(`Strategy dry-run: ${strategyConfig.dryRun ? "yes" : "no"}`);
    console.log(
      `Session: ${strategyConfig.sessionId ?? "latest RUNNING PAPER session with candidates"}`,
    );
    console.log(`Candidate status: ${strategyConfig.status}`);
    console.log(`Risk policy: ${strategyConfig.riskPolicy}`);
    console.log(`Since hours: ${strategyConfig.sinceHours}`);
    console.log(`Candidate limit: ${strategyConfig.limit}`);
    console.log(`Max BUY decisions: ${strategyConfig.maxBuyDecisions}`);
    console.log(`Strategy name: ${strategyConfig.strategyName}`);
    console.log(`Min liquidity USD: ${strategyConfig.minLiquidityUsd}`);
    console.log(`Min volume 1h USD: ${strategyConfig.minVolume1hUsd}`);
    console.log(`Max price impact pct: ${strategyConfig.maxPriceImpactPct}`);
    console.log(`Min pair age minutes: ${strategyConfig.minPairAgeMinutes}`);
    console.log(`BUY score threshold: ${strategyConfig.buyScoreThreshold}`);
    console.log(`WATCH score threshold: ${strategyConfig.watchScoreThreshold}`);
    console.log("Wallet loaded: no");
    console.log("Transaction signing: disabled");
    console.log("Transaction submission: disabled");
    console.log("");

    const result = await runner.run();

    console.log(
      `Strategy summary: session=${result.sessionId} selected=${result.selectedCount} evaluated=${result.evaluatedCount} BUY=${result.buyCount} WATCH=${result.watchCount} SKIP=${result.skipCount} HOLD=${result.holdCount} SELL=${result.sellCount} written=${result.writtenCount} statusUpdated=${result.statusUpdatedCount} duplicateBuyBlocked=${result.duplicateBuyBlockedCount} maxBuyCapBlocked=${result.maxBuyCapBlockedCount} errors=${result.errorCount}`,
    );
  } finally {
    database.close();
  }
}

runStrategyEvaluate().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown strategy evaluation failure.";
  console.error(message);
  process.exitCode = 1;
});
