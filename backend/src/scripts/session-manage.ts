import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { formatLamportsAsSol } from "../paper/PaperMath.js";
import { MarketDataService } from "../providers/MarketDataService.js";
import { ProviderHealthService } from "../providers/ProviderHealthService.js";
import { createProviderRegistry } from "../providers/ProviderRegistry.js";
import { parseSessionManagerArgs } from "../session/SessionManagerConfig.js";
import { SessionManagerRunner } from "../session/SessionManagerRunner.js";

async function runSessionManager(): Promise<void> {
  const sessionManagerConfig = parseSessionManagerArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`SessionManager only runs in PAPER mode. Current mode: ${appConfig.mode}.`);
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
    const runner = new SessionManagerRunner({
      config: sessionManagerConfig,
      repositories,
      marketDataService,
    });

    console.log(`MODE: ${appConfig.mode}`);
    console.log(`SessionManager once: ${sessionManagerConfig.once ? "yes" : "no"}`);
    console.log(`SessionManager dry-run: ${sessionManagerConfig.dryRun ? "yes" : "no"}`);
    console.log(`Session: ${sessionManagerConfig.sessionId ?? "latest RUNNING PAPER session"}`);
    console.log(
      `Target SOL override: ${formatOptionalLamports(sessionManagerConfig.targetProfitLamports)}`,
    );
    console.log(
      `Target percent override: ${formatOptionalPercent(sessionManagerConfig.targetProfitPct)}`,
    );
    console.log(
      `Max drawdown SOL override: ${formatOptionalLamports(sessionManagerConfig.maxDrawdownLamports)}`,
    );
    console.log(
      `Max drawdown percent override: ${formatOptionalPercent(sessionManagerConfig.maxDrawdownPct)}`,
    );
    console.log(`Providers enabled: ${registry.listProviderNames().join(", ") || "none"}`);
    console.log("Wallet loaded: no");
    console.log("Transaction signing: disabled");
    console.log("Transaction submission: disabled");
    console.log("");

    const result = await runner.run();

    console.log(
      `SessionManager summary: session=${result.sessionId} openPositions=${result.openPositionCount} positionSnapshots=${result.positionSnapshotCount} equitySnapshot=${result.equitySnapshotCreated ? "created" : "skipped"} cash=${result.cashLamports} openPositionValue=${result.openPositionValueLamports} equity=${result.totalEquityLamports} realized=${result.realizedPnlLamports} unrealized=${result.unrealizedPnlLamports} drawdown=${result.drawdownLamports} peakEquity=${result.peakEquityLamports} terminationReason=${result.terminationReasonAfter} buyGated=${result.buyGated ? "yes" : "no"} targetReached=${result.targetReached ? "yes" : "no"} drawdownReached=${result.drawdownReached ? "yes" : "no"} valuationUnavailable=${result.valuationUnavailableCount} dryRun=${result.dryRun ? "yes" : "no"}`,
    );
  } finally {
    database.close();
  }
}

function formatOptionalLamports(lamports: number | undefined): string {
  return lamports === undefined ? "none" : formatLamportsAsSol(lamports);
}

function formatOptionalPercent(percent: number | undefined): string {
  return percent === undefined ? "none" : `${percent}`;
}

runSessionManager().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown SessionManager failure.";
  console.error(message);
  process.exitCode = 1;
});
