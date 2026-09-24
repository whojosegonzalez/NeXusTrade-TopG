import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BACKTEST_DATABASE_DISABLED_MESSAGE,
  LIVE_DATABASE_DISABLED_MESSAGE,
  resolveDatabasePath,
} from "./DatabaseMode.js";

describe("database mode path resolution", () => {
  it("resolves paper database path under the configured data directory", () => {
    const dataDir = path.resolve("tmp", "phase-2-test-data");

    expect(resolveDatabasePath("PAPER", { dataDir })).toBe(path.join(dataDir, "nexus_paper.db"));
  });

  it("blocks live database access by default", () => {
    expect(() => resolveDatabasePath("LIVE")).toThrow(LIVE_DATABASE_DISABLED_MESSAGE);
  });

  it("resolves live path only with explicit guard flags", () => {
    const dataDir = path.resolve("tmp", "phase-2-test-data");

    expect(
      resolveDatabasePath("LIVE", {
        dataDir,
        allowLiveMode: true,
        allowLiveDatabase: true,
      }),
    ).toBe(path.join(dataDir, "nexus_live.db"));
  });

  it("blocks backtest database access by default", () => {
    expect(() => resolveDatabasePath("BACKTEST")).toThrow(BACKTEST_DATABASE_DISABLED_MESSAGE);
  });

  it("resolves backtest path only with the explicit guard flag", () => {
    const dataDir = path.resolve("tmp", "phase-2-test-data");

    expect(
      resolveDatabasePath("BACKTEST", {
        dataDir,
        allowBacktestDatabase: true,
      }),
    ).toBe(path.join(dataDir, "nexus_backtest.db"));
  });
});
