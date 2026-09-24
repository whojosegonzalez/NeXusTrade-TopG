import { afterEach, describe, expect, it } from "vitest";

import type { TestDatabaseContext } from "./testing/createTestDatabase.js";
import { createTestDatabase } from "./testing/createTestDatabase.js";
import {
  expectForeignKeysEnabled,
  expectWalModeEnabled,
  listTableNames,
} from "./testing/databaseTestHelpers.js";

describe("sqlite connection", () => {
  let testDb: TestDatabaseContext | undefined;

  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("opens a migrated paper database with required pragmas", () => {
    testDb = createTestDatabase();

    expect(expectForeignKeysEnabled(testDb.context)).toBe(true);
    expect(expectWalModeEnabled(testDb.context)).toBe(true);
    expect(testDb.context.sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  it("creates all Phase 2 tables", () => {
    testDb = createTestDatabase();

    expect(listTableNames(testDb.context)).toEqual(
      expect.arrayContaining([
        "__drizzle_migrations",
        "equity_snapshots",
        "fills",
        "orders",
        "positions",
        "position_snapshots",
        "provider_health",
        "risk_assessments",
        "sessions",
        "strategy_decisions",
        "system_logs",
        "token_radar",
        "watchlist_return_observations",
      ]),
    );
  });

  it("enforces foreign key constraints", () => {
    testDb = createTestDatabase();

    expect(() => {
      testDb?.context.sqlite
        .prepare(
          "insert into token_radar (id, session_id, mint_address, source, first_seen_at_ms, discovered_at_ms, created_at_ms, updated_at_ms) values (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "radar_bad_fk",
          "missing_session",
          "Mint111111111111111111111111111111111111111",
          "test",
          1,
          1,
          1,
          1,
        );
    }).toThrow();
  });
});
