import { existsSync, rmSync } from "node:fs";
import path from "node:path";

import { getDefaultDataDir, resolveDatabasePath } from "./DatabaseMode.js";
import { createPaperDatabaseContext } from "./DatabaseFactory.js";
import { runMigrations } from "./migrations.js";

function removePaperDatabaseFiles(): void {
  const dataDir = getDefaultDataDir();
  const paperPath = resolveDatabasePath("PAPER", { dataDir });
  const allowedFiles = [paperPath, `${paperPath}-wal`, `${paperPath}-shm`];

  for (const filePath of allowedFiles) {
    const relative = path.relative(dataDir, filePath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing to delete path outside data directory: ${filePath}`);
    }

    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
  }
}

removePaperDatabaseFiles();

const context = createPaperDatabaseContext();

try {
  runMigrations(context);
  console.log(`DB RESET: recreated PAPER database at ${context.path}`);
} finally {
  context.close();
}
