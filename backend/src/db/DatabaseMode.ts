import path from "node:path";

import type { ExecutionMode } from "@nexustrade/shared";

import { getRepoRoot } from "./utils/paths.js";

export const DATABASE_FILE_BY_MODE: Readonly<Record<ExecutionMode, string>> = {
  PAPER: "nexus_paper.db",
  LIVE: "nexus_live.db",
  BACKTEST: "nexus_backtest.db",
};

export interface DatabasePathOptions {
  readonly dataDir?: string;
  readonly allowLiveMode?: boolean;
  readonly allowLiveDatabase?: boolean;
  readonly allowBacktestDatabase?: boolean;
}

export const LIVE_DATABASE_DISABLED_MESSAGE =
  "LIVE database access is disabled in Phase 2. Use PAPER mode while the local persistence layer is under development.";

export const BACKTEST_DATABASE_DISABLED_MESSAGE =
  "BACKTEST database access is reserved for a later phase. Use PAPER mode for Phase 2 database work.";

export function getDefaultDataDir(): string {
  return path.resolve(getRepoRoot(), "data");
}

export function resolveDataDir(dataDir: string | undefined): string {
  return dataDir ? path.resolve(dataDir) : getDefaultDataDir();
}

export function resolveDatabasePath(
  mode: ExecutionMode,
  options: DatabasePathOptions = {},
): string {
  assertDatabaseModeAllowed(mode, options);

  return path.join(resolveDataDir(options.dataDir), DATABASE_FILE_BY_MODE[mode]);
}

export function assertDatabaseModeAllowed(
  mode: ExecutionMode,
  options: DatabasePathOptions = {},
): void {
  if (mode === "LIVE" && !(options.allowLiveMode === true && options.allowLiveDatabase === true)) {
    throw new Error(LIVE_DATABASE_DISABLED_MESSAGE);
  }

  if (mode === "BACKTEST" && options.allowBacktestDatabase !== true) {
    throw new Error(BACKTEST_DATABASE_DISABLED_MESSAGE);
  }
}

export function assertPathInsideDirectory(childPath: string, parentDirectory: string): void {
  const resolvedChild = path.resolve(childPath);
  const resolvedParent = path.resolve(parentDirectory);
  const relative = path.relative(resolvedParent, resolvedChild);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to use database path outside data directory: ${resolvedChild}`);
  }
}
