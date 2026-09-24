import { existsSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { parseCalibrationArgs } from "../calibration/CalibrationConfig.js";
import {
  formatCalibrationJson,
  formatCalibrationReport,
} from "../calibration/CalibrationReportFormatter.js";
import { CalibrationReportService } from "../calibration/CalibrationReportService.js";
import { CalibrationRepository } from "../calibration/CalibrationRepository.js";
import { loadAppConfig } from "../config/env.js";
import { createRepositories } from "../db/repositories/index.js";
import { resolveDatabasePath } from "../db/DatabaseMode.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import type { DatabaseContext } from "../db/connection.js";
import * as schema from "../db/schema/index.js";
import { getRepoRoot } from "../db/utils/paths.js";

async function runCalibrationReport(): Promise<void> {
  const calibrationConfig = parseCalibrationArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`Calibration report only runs in PAPER mode. Current mode: ${appConfig.mode}.`);
  }

  const contexts = buildDatabaseContexts(calibrationConfig.dbSources);

  try {
    const repositories = contexts.map(
      (context) =>
        new CalibrationRepository({
          label: context.label,
          path: context.context.path,
          repositories: createRepositories(context.context.db),
        }),
    );

    for (const context of contexts) {
      assertMigrationsApplied(context.context);
    }

    const report = new CalibrationReportService({
      config: calibrationConfig,
      repositories,
    }).generate();

    if (!calibrationConfig.json) {
      console.log(`MODE: ${appConfig.mode}`);
      console.log(`Calibration once: ${calibrationConfig.once ? "yes" : "default one-shot"}`);
      console.log(`Session: ${calibrationConfig.sessionId ?? "latest PAPER session with rows"}`);
      console.log(`Since hours: ${calibrationConfig.sinceHours}`);
      console.log(`Limit: ${calibrationConfig.limit}`);
      console.log(`Targets pct: ${calibrationConfig.targetPcts.join(",")}`);
      console.log(`Drawdowns pct: ${calibrationConfig.drawdownPcts.join(",")}`);
      console.log(`Max hold minutes: ${calibrationConfig.maxHoldMinutes}`);
      console.log(`Datasets: ${contexts.map((context) => context.label).join(", ")}`);
      console.log("Wallet loaded: no");
      console.log("Transaction signing: disabled");
      console.log("Transaction submission: disabled");
      console.log("");
    }

    console.log(
      calibrationConfig.json ? formatCalibrationJson(report) : formatCalibrationReport(report),
    );
  } finally {
    for (const context of contexts) {
      context.context.close();
    }
  }
}

interface LabeledDatabaseContext {
  readonly label: string;
  readonly context: DatabaseContext;
}

function buildDatabaseContexts(
  sources: readonly { readonly label: string; readonly path: string }[],
): readonly LabeledDatabaseContext[] {
  if (sources.length === 0) {
    return [
      {
        label: "active",
        context: openReadOnlyPaperDatabase(resolveDatabasePath("PAPER")),
      },
    ];
  }

  return sources.map((source) => ({
    label: source.label,
    context: openReadOnlyPaperDatabase(source.path),
  }));
}

function openReadOnlyPaperDatabase(databasePath: string): DatabaseContext {
  const resolvedPath = path.isAbsolute(databasePath)
    ? path.resolve(databasePath)
    : path.resolve(getRepoRoot(), databasePath);

  if (!existsSync(resolvedPath)) {
    throw new Error(`Calibration database not found: ${resolvedPath}`);
  }

  const sqlite = new Database(resolvedPath, {
    readonly: true,
    fileMustExist: true,
  });
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("query_only = ON");

  return {
    mode: "PAPER",
    path: resolvedPath,
    db: drizzle(sqlite, { schema }),
    sqlite,
    close: () => sqlite.close(),
  };
}

runCalibrationReport().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown calibration report failure.";
  console.error(message);
  process.exitCode = 1;
});
