import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import type { ExecutionMode } from "@nexustrade/shared";

import * as schema from "./schema/index.js";

export type AppDatabase = BetterSQLite3Database<typeof schema>;
export type SqliteDatabase = Database.Database;

export interface DatabaseContext {
  readonly mode: ExecutionMode;
  readonly path: string;
  readonly db: AppDatabase;
  readonly sqlite: SqliteDatabase;
  readonly close: () => void;
}

export function openDatabase(databasePath: string, mode: ExecutionMode): DatabaseContext {
  const sqlite = new Database(databasePath);
  applyPragmas(sqlite);

  return {
    mode,
    path: databasePath,
    db: drizzle(sqlite, { schema }),
    sqlite,
    close: () => sqlite.close(),
  };
}

export function applyPragmas(sqlite: SqliteDatabase): void {
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
}

export function getPragmaValue<T = unknown>(sqlite: SqliteDatabase, pragma: string): T {
  return sqlite.pragma(pragma, { simple: true }) as T;
}
