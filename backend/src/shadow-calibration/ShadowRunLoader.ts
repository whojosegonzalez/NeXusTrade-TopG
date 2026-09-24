import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { createRepositories } from "../db/repositories/index.js";
import { resolveDatabasePath } from "../db/DatabaseMode.js";
import { assertMigrationsApplied } from "../db/migrations.js";
import type { DatabaseContext } from "../db/connection.js";
import type { Repositories } from "../db/repositories/index.js";
import type { SessionRecord } from "../db/schema/index.js";
import * as schema from "../db/schema/index.js";
import { getRepoRoot } from "../db/utils/paths.js";
import type {
  ShadowCalibrationDbSourceConfig,
  ShadowCalibrationRuntimeConfig,
} from "./ShadowCalibrationConfig.js";
import type {
  ShadowCalibrationRawRun,
  ShadowCalibrationReportOnlySummary,
} from "./ShadowCalibrationTypes.js";

const MAX_ROWS = 10_000;

export interface LoadedShadowCalibrationRuns {
  readonly runs: readonly ShadowCalibrationRawRun[];
  readonly close: () => void;
}

interface OpenedDatabaseRun {
  readonly label: string;
  readonly inputPath: string;
  readonly context: DatabaseContext;
}

export function loadShadowCalibrationRuns(
  config: ShadowCalibrationRuntimeConfig,
): LoadedShadowCalibrationRuns {
  const sources =
    config.dbSources.length > 0
      ? config.dbSources
      : [
          {
            label: "active",
            path: resolveDatabasePath("PAPER"),
          },
        ];
  const opened: OpenedDatabaseRun[] = [];
  const runs: ShadowCalibrationRawRun[] = [];

  try {
    for (const source of sources) {
      const resolved = resolveSource(source);

      if (resolved.kind === "database") {
        const context = openReadOnlyPaperDatabase(resolved.path);
        opened.push({
          label: source.label,
          inputPath: resolved.path,
          context,
        });
        runs.push(loadDatabaseRun(source.label, resolved.path, context, config));
      } else {
        runs.push(loadReportOnlyRun(source.label, resolved.path, resolved.reportPath));
      }
    }

    return {
      runs,
      close: () => {
        for (const item of opened) {
          item.context.close();
        }
      },
    };
  } catch (error) {
    for (const item of opened) {
      item.context.close();
    }

    throw error;
  }
}

type ResolvedShadowCalibrationSource =
  | {
      readonly kind: "database";
      readonly path: string;
    }
  | {
      readonly kind: "report-only";
      readonly path: string;
      readonly reportPath: string;
    };

function resolveSource(source: ShadowCalibrationDbSourceConfig): ResolvedShadowCalibrationSource {
  const resolvedPath = path.isAbsolute(source.path)
    ? path.resolve(source.path)
    : path.resolve(getRepoRoot(), source.path);

  if (!existsSync(resolvedPath)) {
    throw new Error(`Shadow calibration source not found: ${resolvedPath}`);
  }

  const stats = statSync(resolvedPath);

  if (stats.isDirectory()) {
    const databasePath = path.join(resolvedPath, "nexus_paper.db");

    if (existsSync(databasePath)) {
      return {
        kind: "database",
        path: databasePath,
      };
    }

    const reportPath = findCalibrationReport(resolvedPath);

    if (!reportPath) {
      throw new Error(
        `Shadow calibration directory has no nexus_paper.db or calibration report: ${resolvedPath}`,
      );
    }

    return {
      kind: "report-only",
      path: resolvedPath,
      reportPath,
    };
  }

  if (resolvedPath.toLowerCase().endsWith(".db")) {
    return {
      kind: "database",
      path: resolvedPath,
    };
  }

  if (resolvedPath.toLowerCase().endsWith(".txt")) {
    return {
      kind: "report-only",
      path: resolvedPath,
      reportPath: resolvedPath,
    };
  }

  throw new Error(`Unsupported shadow calibration source: ${resolvedPath}`);
}

function openReadOnlyPaperDatabase(databasePath: string): DatabaseContext {
  if (databasePath.toLowerCase().includes("live")) {
    throw new Error(
      `Shadow calibration refuses to open a live-looking database path: ${databasePath}`,
    );
  }

  const sqlite = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("query_only = ON");

  return {
    mode: "PAPER",
    path: databasePath,
    db: drizzle(sqlite, { schema }),
    sqlite,
    close: () => sqlite.close(),
  };
}

function loadDatabaseRun(
  label: string,
  databasePath: string,
  context: DatabaseContext,
  config: ShadowCalibrationRuntimeConfig,
): ShadowCalibrationRawRun {
  assertMigrationsApplied(context);

  const repositories = createRepositories(context.db);
  const session = resolveSession(repositories, config.sessionId);
  const sessionProviderHealth = repositories.providerHealth.listProviderHealth({
    sessionId: session.id,
    limit: MAX_ROWS,
  });
  const systemLogs = repositories.systemLogs.listLogs({
    sessionId: session.id,
    limit: MAX_ROWS,
  });
  const globalSystemLogs =
    systemLogs.length > 0 ? systemLogs : repositories.systemLogs.listLogs({ limit: MAX_ROWS });

  return {
    label,
    path: databasePath,
    sourceKind: "database",
    warnings: [],
    session,
    strategyDecisions: repositories.strategyDecisions.listStrategyDecisions(session.id, {
      limit: MAX_ROWS,
    }),
    watchlistReturns: repositories.watchlistReturns.listObservations(session.id, {
      limit: MAX_ROWS,
    }),
    riskAssessments: repositories.riskAssessments.listRiskAssessments(session.id, {
      limit: MAX_ROWS,
    }),
    tokenRadar: repositories.tokenRadar.listRadarEntries(session.id, {
      limit: MAX_ROWS,
    }),
    providerHealth:
      sessionProviderHealth.length > 0
        ? sessionProviderHealth
        : repositories.providerHealth.listProviderHealth({
            limit: MAX_ROWS,
          }),
    systemLogs: globalSystemLogs,
    orderCount: repositories.orders.listOrders(session.id, { limit: MAX_ROWS }).length,
    fillCount: repositories.fills.listFillsForSession(session.id).length,
    positionCount:
      repositories.positions.listOpenPositions(session.id).length +
      repositories.positions.listClosedPositions(session.id).length,
  };
}

function resolveSession(repositories: Repositories, sessionId: string | undefined): SessionRecord {
  if (sessionId) {
    const session = repositories.sessions.getSessionById(sessionId);

    if (!session) {
      throw new Error(`Shadow calibration session not found: ${sessionId}`);
    }

    if (session.mode !== "PAPER") {
      throw new Error(
        `Shadow calibration requires a PAPER session. Session ${session.id} is ${session.mode}.`,
      );
    }

    return session;
  }

  for (const session of repositories.sessions.listSessions({ mode: "PAPER", limit: 100 })) {
    const hasDecisions =
      repositories.strategyDecisions.listStrategyDecisions(session.id, { limit: 1 }).length > 0;
    const hasReturns =
      repositories.watchlistReturns.listObservations(session.id, { limit: 1 }).length > 0;

    if (hasDecisions || hasReturns) {
      return session;
    }
  }

  throw new Error(
    "No PAPER session with StrategyDecision or watchlist return rows was found. Run strategy/watchlist first or pass --session-id.",
  );
}

function loadReportOnlyRun(
  label: string,
  inputPath: string,
  reportPath: string,
): ShadowCalibrationRawRun {
  const text = readFileSync(reportPath, "utf8");

  return {
    label,
    path: inputPath,
    sourceKind: "report-only",
    warnings: [
      `No archived database was found for ${label}; using limited metrics parsed from ${path.basename(
        reportPath,
      )}.`,
    ],
    strategyDecisions: [],
    watchlistReturns: [],
    riskAssessments: [],
    tokenRadar: [],
    providerHealth: [],
    systemLogs: [],
    orderCount: 0,
    fillCount: 0,
    positionCount: 0,
    reportOnlySummary: parseReportOnlySummary(text),
  };
}

function findCalibrationReport(directoryPath: string): string | undefined {
  const files = readdirSync(directoryPath)
    .filter((name) => name.toLowerCase().endsWith(".txt"))
    .filter((name) => name.toLowerCase().includes("calibration"))
    .sort();
  const preferred =
    files.find((name) => name.toLowerCase().includes("120m")) ?? files[files.length - 1];

  return preferred ? path.join(directoryPath, preferred) : undefined;
}

function parseReportOnlySummary(text: string): ShadowCalibrationReportOnlySummary {
  const counts = matchNumbers(
    text,
    /counts:\s*radar=(\d+)\s+strategy=(\d+)\s+observedReturns=(\d+)\s+providerHealth=(\d+)/,
  );
  const buyLine = matchNumbers(
    text,
    /BUY:\s+n=\d+\s+avgBest=([-+\d.]+)\s+avgWorst=([-+\d.]+)\s+hits=\+10%:([-+\d.]+)%/,
  );
  const targetLine = matchNumbers(
    text,
    /target=10%\s+drawdown=10%\s+evaluated=(\d+)\s+targetFirst=(\d+)\s+drawdownFirst=(\d+)/,
  );
  const providerLine = matchNumbers(
    text,
    /strategyRows=(\d+)\s+missingQuote=(\d+)\s+missingAuthority=(\d+)\s+missingImpact=(\d+)/,
  );

  return {
    ...(counts
      ? {
          radarRows: counts[0],
          strategyRows: counts[1],
          observedReturnRows: counts[2],
          providerHealthRows: counts[3],
        }
      : {}),
    ...(buyLine
      ? {
          buyAverageBestReturnPct: buyLine[0],
          buyAverageWorstReturnPct: buyLine[1],
          buyHit10Pct: buyLine[2],
        }
      : {}),
    ...(targetLine
      ? {
          target10Drawdown10Evaluated: targetLine[0],
          target10Drawdown10TargetFirst: targetLine[1],
          target10Drawdown10DrawdownFirst: targetLine[2],
        }
      : {}),
    ...(providerLine
      ? {
          strategyRowsForProviderImpact: providerLine[0],
          missingQuoteCount: providerLine[1],
          missingAuthorityCount: providerLine[2],
          missingImpactCount: providerLine[3],
        }
      : {}),
  };
}

function matchNumbers(text: string, pattern: RegExp): readonly number[] | undefined {
  const match = text.match(pattern);

  if (!match) {
    return undefined;
  }

  return match.slice(1).map((value) => Number(value));
}
