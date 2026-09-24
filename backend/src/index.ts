import { loadAppConfig } from "./config/env.js";
import { assertLiveModeAllowed } from "./config/liveModeGuard.js";
import { assertMigrationsApplied, createPaperDatabaseContext } from "./db/index.js";
import { createRepositories } from "./db/repositories/index.js";
import { stringifyJson } from "./db/utils/json.js";
import { getHealthCheck } from "./health/healthCheck.js";
import { createLogger } from "./logging/logger.js";

const logger = createLogger("backend");

export function runStartupCheck(): void {
  const config = loadAppConfig();
  assertLiveModeAllowed(config.mode);

  const health = getHealthCheck(config);

  logger.info("NeXusTrade backend starting...");
  logger.info(`Mode: ${health.mode}`);

  if (health.mode === "PAPER") {
    const database = createPaperDatabaseContext();

    try {
      assertMigrationsApplied(database);
      createRepositories(database.db).systemLogs.createLog({
        level: "INFO",
        scope: "SYSTEM",
        message: "Backend startup database check passed.",
        contextJson: stringifyJson({
          mode: health.mode,
          databasePath: database.path,
        }),
      });
      logger.info(`Database: ${database.path}`);
    } finally {
      database.close();
    }
  }

  logger.info("Status: foundation boot check passed");
}

try {
  runStartupCheck();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown startup failure";

  logger.error(message);
  process.exitCode = 1;
}
