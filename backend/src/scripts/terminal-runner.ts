import { loadAppConfig } from "../config/env.js";
import { createPaperDatabaseContext } from "../db/DatabaseFactory.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import { createRepositories } from "../db/repositories/index.js";
import { stringifyJson } from "../db/utils/json.js";
import { MarketDataService } from "../providers/MarketDataService.js";
import { ProviderHealthService } from "../providers/ProviderHealthService.js";
import { createProviderRegistry } from "../providers/ProviderRegistry.js";
import {
  formatTerminalRunJson,
  formatTerminalRunText,
  writeTerminalRunArtifacts,
  type TerminalRunSummary,
} from "../terminal-runner/TerminalRunSummary.js";
import { parseTerminalRunnerArgs } from "../terminal-runner/TerminalRunnerConfig.js";
import { TerminalRunner } from "../terminal-runner/TerminalRunner.js";
import { TerminalStageRunner } from "../terminal-runner/TerminalStageRunner.js";

async function runTerminalRunner(): Promise<void> {
  const terminalConfig = parseTerminalRunnerArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`TerminalRunner only runs in PAPER mode. Current mode: ${appConfig.mode}.`);
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
    const terminalSession = repositories.sessions.createSession({
      mode: "PAPER",
      status: "RUNNING",
      startedAtMs: Date.now(),
      startingBalanceLamports: 0,
      currentCashLamports: 0,
      configSnapshotJson: stringifyJson({
        phase: "PHASE_9_TERMINAL_RUNNER",
        terminalConfig,
        shadowOnly: true,
        paperExecution: false,
      }),
    });
    const stageRunner = new TerminalStageRunner({
      repositories,
      registry,
      providerConfig: appConfig.providers,
      marketDataService,
      databasePath: database.path,
      sessionId: terminalSession.id,
    });
    const runner = new TerminalRunner({
      config: terminalConfig,
      stageExecutor: stageRunner,
      sessionId: terminalSession.id,
      ...(terminalConfig.json ? {} : { progress: (message) => console.log(message) }),
    });

    process.once("SIGINT", () => {
      console.log("TerminalRunner stop requested. Finishing current stage...");
      runner.stop();
    });

    if (!terminalConfig.json) {
      console.log(`MODE: ${appConfig.mode}`);
      console.log("TerminalRunner shadow-only: yes");
      console.log(`TerminalRunner once: ${terminalConfig.once ? "yes" : "no"}`);
      console.log(`Cycles: ${terminalConfig.cycles ?? "until stopped/runtime"}`);
      console.log(`Max runtime minutes: ${terminalConfig.maxRuntimeMinutes ?? "not set"}`);
      console.log(`Interval ms: ${terminalConfig.intervalMs}`);
      console.log(`Output dir: ${terminalConfig.outputDir ?? "console only"}`);
      console.log(`Terminal session id: ${terminalSession.id}`);
      console.log(`Providers enabled: ${registry.listProviderNames().join(", ") || "none"}`);
      console.log("Paper execution: disabled");
      console.log("Wallet loaded: no");
      console.log("Transaction signing: disabled");
      console.log("Transaction submission: disabled");
      console.log("");
    }

    let summary = await runner.run();

    if (terminalConfig.outputDir) {
      const outputFiles = writeTerminalRunArtifacts({
        summary,
        outputDir: terminalConfig.outputDir,
      });
      summary = withOutputFiles(summary, outputFiles);
    }

    console.log(
      terminalConfig.json ? formatTerminalRunJson(summary) : formatTerminalRunText(summary),
    );
  } finally {
    database.close();
  }
}

function withOutputFiles(
  summary: TerminalRunSummary,
  outputFiles: readonly string[],
): TerminalRunSummary {
  return {
    ...summary,
    outputFiles,
  };
}

runTerminalRunner().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown TerminalRunner failure.";
  console.error(message);
  process.exitCode = 1;
});
