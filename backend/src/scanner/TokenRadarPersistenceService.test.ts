import { afterEach, describe, expect, it } from "vitest";

import type { TestDatabaseContext } from "../db/testing/createTestDatabase.js";
import { createTestDatabase } from "../db/testing/createTestDatabase.js";
import { createRepositories } from "../db/repositories/index.js";
import { TokenRadarPersistenceService } from "./TokenRadarPersistenceService.js";

describe("TokenRadarPersistenceService", () => {
  let testDb: TestDatabaseContext | undefined;

  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("upserts TokenRadar records and preserves first seen time", () => {
    testDb = createTestDatabase();
    const repositories = createRepositories(testDb.context.db);
    const session = repositories.sessions.createSession({
      mode: "PAPER",
      status: "RUNNING",
      startedAtMs: 1,
      startingBalanceLamports: 0,
      currentCashLamports: 0,
      configSnapshotJson: "{}",
    });
    const service = new TokenRadarPersistenceService({
      repositories,
      sessionId: session.id,
      dryRun: false,
    });

    service.persist([
      {
        sessionId: session.id,
        mintAddress: "So11111111111111111111111111111111111111112",
        source: "DEXSCREENER",
        pairAddress: "pair_1",
        firstSeenAtMs: 100,
        discoveredAtMs: 200,
        status: "DISCOVERED",
      },
    ]);
    service.persist([
      {
        sessionId: session.id,
        mintAddress: "So11111111111111111111111111111111111111112",
        source: "DEXSCREENER",
        pairAddress: "pair_1",
        firstSeenAtMs: 300,
        discoveredAtMs: 400,
        status: "DISCOVERED",
      },
    ]);

    const entries = repositories.tokenRadar.listRadarEntries(session.id);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.firstSeenAtMs).toBe(100);
    expect(entries[0]?.discoveredAtMs).toBe(400);
  });

  it("skips TokenRadar writes in dry-run mode", () => {
    testDb = createTestDatabase();
    const repositories = createRepositories(testDb.context.db);
    const session = repositories.sessions.createSession({
      mode: "PAPER",
      status: "RUNNING",
      startedAtMs: 1,
      startingBalanceLamports: 0,
      currentCashLamports: 0,
      configSnapshotJson: "{}",
    });
    const result = new TokenRadarPersistenceService({
      repositories,
      sessionId: session.id,
      dryRun: true,
    }).persist([
      {
        sessionId: session.id,
        mintAddress: "So11111111111111111111111111111111111111112",
        source: "DEXSCREENER",
        firstSeenAtMs: 100,
        discoveredAtMs: 200,
        status: "DISCOVERED",
      },
    ]);

    expect(result.skippedCount).toBe(1);
    expect(repositories.tokenRadar.listRadarEntries(session.id)).toHaveLength(0);
  });
});
