import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "../connection.js";
import { runMigrations } from "../migrations.js";

import { assertH2FixturePath, h2FixtureRoot } from "./H2FixturePaths.js";

export function createH2TestDatabase() {
  mkdirSync(h2FixtureRoot, { recursive: true });
  if (realpathSync(h2FixtureRoot) !== path.resolve(h2FixtureRoot))
    throw new Error("H2 fixture root is redirected");
  const dataDir = mkdtempSync(path.join(h2FixtureRoot, "sqlite-"));
  const file = path.join(dataDir, "fixture.sqlite");
  assertH2FixturePath(file);
  const context = openDatabase(file, "PAPER");
  const cleanup = () => {
    context.close();
    assertH2FixturePath(path.join(dataDir, "cleanup-marker"));
    if (!path.basename(dataDir).startsWith("sqlite-")) throw new Error("Unowned H2 directory");
    rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    runMigrations(context);
    return { context, dataDir, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
