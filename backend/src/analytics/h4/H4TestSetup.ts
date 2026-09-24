import type * as NodeFs from "node:fs";
import type NativeSqlite from "better-sqlite3";
import path from "node:path";
import { vi } from "vitest";

vi.mock("../../db/testing/createTestDatabase.js", async () => {
  const { createH2TestDatabase } = await import("../../db/h2/H2TestDatabase.js");
  return { createTestDatabase: createH2TestDatabase };
});

vi.mock("better-sqlite3", async (original) => {
  const { default: Database } = await original<{ default: typeof NativeSqlite }>();
  const { assertH2FixturePath } = await import("../../db/h2/H2FixturePaths.js");
  return {
    default: class GuardedH2Database extends Database {
      constructor(file: string, options?: NativeSqlite.Options) {
        if (file !== ":memory:") assertH2FixturePath(file);
        super(file, options);
      }
    },
  };
});

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof NodeFs>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (
        path.basename(String(args[0])).startsWith(".env") ||
        String(args[0]).replaceAll("\\", "/").includes("/data/")
      )
        throw new Error("H4_ENV_OR_ARCHIVE_READ_FORBIDDEN");
      return fs.readFileSync(...args);
    },
  };
});

vi.stubGlobal("fetch", () => {
  throw new Error("H4_REAL_NETWORK_FORBIDDEN");
});

vi.mock("node:http", () => ({ request: forbidden, get: forbidden }));
vi.mock("node:https", () => ({ request: forbidden, get: forbidden }));
vi.mock("node:net", () => ({ connect: forbidden, createConnection: forbidden }));
vi.mock("node:child_process", () => ({
  spawn: forbidden,
  spawnSync: forbidden,
  exec: forbidden,
  execFile: forbidden,
  execSync: forbidden,
  execFileSync: forbidden,
}));
function forbidden(): never {
  throw new Error("H4_EXTERNAL_IO_FORBIDDEN");
}
