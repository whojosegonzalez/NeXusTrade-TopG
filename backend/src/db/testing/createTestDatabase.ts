import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDatabaseContext } from "../DatabaseFactory.js";
import { runMigrations } from "../migrations.js";
import type { DatabaseContext } from "../connection.js";

export interface TestDatabaseContext {
  readonly context: DatabaseContext;
  readonly dataDir: string;
  readonly cleanup: () => void;
}

export function createTestDatabase(): TestDatabaseContext {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "nexustrade-db-test-"));
  const context = createDatabaseContext({
    mode: "PAPER",
    dataDir,
  });

  runMigrations(context);

  return {
    context,
    dataDir,
    cleanup: () => {
      context.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
