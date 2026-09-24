import type * as NodeFs from "node:fs";
import type NativeSqlite from "better-sqlite3";
import path from "node:path";
import { vi } from "vitest";

// Reuse H2's already audited, explicitly owned fixture boundary for health persistence tests.
vi.mock("../../db/testing/createTestDatabase.js", async () => {
  const { createH2TestDatabase } = await import("../../db/h2/H2TestDatabase.js");
  return { createTestDatabase: createH2TestDatabase };
});
vi.mock("better-sqlite3", async (original) => {
  const { default: Database } = await original<{ default: typeof NativeSqlite }>();
  const { assertH2FixturePath } = await import("../../db/h2/H2FixturePaths.js");
  return {
    default: class extends Database {
      constructor(file: string, options?: NativeSqlite.Options) {
        if (file !== ":memory:") assertH2FixturePath(file);
        super(file, options);
      }
    },
  };
});

vi.stubGlobal("fetch", () => {
  throw new Error("H3_REAL_NETWORK_FORBIDDEN");
});
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof NodeFs>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (path.basename(String(args[0])).startsWith(".env"))
        throw new Error("H3_ENVIRONMENT_READ_FORBIDDEN");
      return fs.readFileSync(...args);
    },
  };
});
