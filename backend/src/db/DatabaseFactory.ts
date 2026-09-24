import { mkdirSync } from "node:fs";
import path from "node:path";

import type { ExecutionMode } from "@nexustrade/shared";

import { openDatabase, type DatabaseContext } from "./connection.js";
import { resolveDatabasePath, type DatabasePathOptions } from "./DatabaseMode.js";

export interface DatabaseFactoryOptions extends DatabasePathOptions {
  readonly mode: ExecutionMode;
}

export function createDatabaseContext(options: DatabaseFactoryOptions): DatabaseContext {
  const databasePath = resolveDatabasePath(options.mode, options);
  mkdirSync(path.dirname(databasePath), { recursive: true });

  return openDatabase(databasePath, options.mode);
}

export function createPaperDatabaseContext(
  options: Omit<DatabaseFactoryOptions, "mode"> = {},
): DatabaseContext {
  return createDatabaseContext({
    ...options,
    mode: "PAPER",
  });
}
