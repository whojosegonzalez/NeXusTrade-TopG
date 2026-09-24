import Database from "better-sqlite3";

import type { ResearchArchiveMetadata } from "../research/ResearchAggregateTypes.js";
import type { ResearchTruthingArchiveCounts } from "./ResearchTruthingTypes.js";

const CORE_TABLES = [
  "sessions",
  "token_radar",
  "risk_assessments",
  "strategy_decisions",
  "watchlist_return_observations",
  "orders",
  "fills",
  "positions",
  "equity_snapshots",
  "position_snapshots",
  "provider_health",
  "system_logs",
] as const;

export class ArchiveDatabaseTruthService {
  summarize(
    archives: readonly ResearchArchiveMetadata[],
  ): readonly ResearchTruthingArchiveCounts[] {
    return archives.map((archive) => this.summarizeArchive(archive));
  }

  private summarizeArchive(archive: ResearchArchiveMetadata): ResearchTruthingArchiveCounts {
    const sqlite = new Database(archive.databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    sqlite.pragma("query_only = ON");

    try {
      const tableCounts = Object.fromEntries(
        CORE_TABLES.map((tableName) => [tableName, countRows(sqlite, tableName)]),
      );
      const databaseSessionIds = readSessionIds(sqlite);
      const terminalSessionId = archive.terminalSummary.sessionId;
      const stageSessionIds = collectStageSessionIds(archive);
      const warnings = [...archive.warnings];

      if (databaseSessionIds.length !== 1) {
        warnings.push(`Archived database has ${databaseSessionIds.length} sessions.`);
      }

      if (!terminalSessionId) {
        warnings.push("TerminalRunner JSON did not include a session id.");
      }

      if (terminalSessionId && !databaseSessionIds.includes(terminalSessionId)) {
        warnings.push(
          `Terminal session ${terminalSessionId} is not present in archived database sessions.`,
        );
      }

      if (stageSessionIds.length > 0 && stageSessionIds.some((id) => id !== terminalSessionId)) {
        warnings.push("TerminalRunner stages were not all tied to the terminal session id.");
      }

      const oneSession =
        databaseSessionIds.length === 1 &&
        terminalSessionId !== undefined &&
        databaseSessionIds[0] === terminalSessionId &&
        (stageSessionIds.length === 0 || stageSessionIds.every((id) => id === terminalSessionId));

      return {
        label: archive.label,
        databasePath: archive.databasePath,
        ...(databaseSessionIds[0] ? { sessionId: databaseSessionIds[0] } : {}),
        tableCounts,
        oneSession,
        ...(terminalSessionId ? { terminalSessionId } : {}),
        databaseSessionIds,
        warnings,
      };
    } finally {
      sqlite.close();
    }
  }
}

function countRows(sqlite: Database.Database, tableName: string): number {
  if (!tableExists(sqlite, tableName)) {
    return 0;
  }

  return readCount(sqlite.prepare(`select count(*) as count from ${tableName}`).get());
}

function tableExists(sqlite: Database.Database, tableName: string): boolean {
  const row = sqlite
    .prepare("select name from sqlite_master where type = 'table' and name = ?")
    .get(tableName);

  return row !== undefined;
}

function readSessionIds(sqlite: Database.Database): readonly string[] {
  if (!tableExists(sqlite, "sessions")) {
    return [];
  }

  return sqlite
    .prepare("select id from sessions order by started_at_ms asc")
    .all()
    .map((row) => readString((row as { readonly id?: unknown }).id))
    .filter((id): id is string => id !== undefined);
}

function collectStageSessionIds(archive: ResearchArchiveMetadata): readonly string[] {
  const sessionIds = new Set<string>();

  for (const cycle of archive.terminalSummary.cycles) {
    for (const stage of cycle.stages) {
      const sessionId = stage.counts.sessionId;

      if (typeof sessionId === "string" && sessionId.trim() !== "") {
        sessionIds.add(sessionId);
      }
    }
  }

  return [...sessionIds].sort();
}

function readCount(row: unknown): number {
  if (!row || typeof row !== "object") {
    return 0;
  }

  const value = (row as { readonly count?: unknown }).count;

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
