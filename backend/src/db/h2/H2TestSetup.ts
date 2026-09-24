import type * as NodeFs from "node:fs";
import type NativeSqlite from "better-sqlite3";
import path from "node:path";
import { vi } from "vitest";

vi.mock("../testing/createTestDatabase.js", async () => {
  const { createH2TestDatabase } = await import("./H2TestDatabase.js");
  return { createTestDatabase: createH2TestDatabase };
});

vi.mock("better-sqlite3", async (original) => {
  const { default: Database } = await original<{ default: typeof NativeSqlite }>();
  const { assertH2FixturePath } = await import("./H2FixturePaths.js");
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
      if (path.basename(String(args[0])).startsWith(".env"))
        throw new Error("H2 cannot read environment files");
      return fs.readFileSync(...args);
    },
  };
});

vi.stubGlobal("fetch", () => {
  throw new Error("H2 cannot contact a real provider");
});
