import { afterEach, describe, expect, it } from "vitest";

import { createRepositories } from "./RepositoryFactory.js";
import type { TestDatabaseContext } from "../testing/createTestDatabase.js";
import { createTestDatabase } from "../testing/createTestDatabase.js";
import { seedPaperDatabase } from "../seeds/seedPaperDatabase.js";
import { parseJson } from "../utils/json.js";

describe("repositories", () => {
  let testDb: TestDatabaseContext | undefined;

  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("creates and reads a full seeded paper session", () => {
    testDb = createTestDatabase();
    const result = seedPaperDatabase(testDb.context);
    const repos = createRepositories(testDb.context.db);
    const session = repos.sessions.getSessionById(result.sessionId);

    expect(session?.mode).toBe("PAPER");
    expect(session?.status).toBe("RUNNING");
    expect(repos.tokenRadar.getRadarEntryById(result.radarTokenId)?.status).toBe("APPROVED");
    expect(
      repos.riskAssessments.getLatestRiskAssessment(
        result.sessionId,
        "Fake111111111111111111111111111111111111111",
      )?.result,
    ).toBe("PASS");
    expect(
      repos.strategyDecisions.listDecisionsForMint(
        result.sessionId,
        "Fake111111111111111111111111111111111111111",
      ),
    ).toHaveLength(1);
    expect(repos.fills.listFillsForOrder(result.buyOrderId)).toHaveLength(1);
    expect(repos.positions.listOpenPositions(result.sessionId)).toHaveLength(1);
    expect(repos.snapshots.getLatestEquitySnapshot(result.sessionId)?.id).toBe(
      result.equitySnapshotId,
    );
    expect(repos.systemLogs.listSessionLogs(result.sessionId, 10).length).toBeGreaterThanOrEqual(2);
    expect(repos.providerHealth.getLatestProviderStatus("seed-jupiter")?.id).toBe(
      result.providerHealthId,
    );
  });

  it("updates sessions, orders, positions, and radar status", () => {
    testDb = createTestDatabase();
    const result = seedPaperDatabase(testDb.context);
    const repos = createRepositories(testDb.context.db);

    expect(
      repos.sessions.updateSessionPnl(result.sessionId, { realizedPnlLamports: 123 })
        .realizedPnlLamports,
    ).toBe(123);
    expect(repos.orders.updateOrderStatus(result.buyOrderId, "QUOTED").status).toBe("QUOTED");
    expect(
      repos.positions.closePosition(result.positionId, {
        // The seed deliberately places its opening fill 3.5 seconds after seed creation.
        closedAtMs: repos.positions.getPositionById(result.positionId)!.openedAtMs + 1,
        proceedsLamports: 101_000_000,
        realizedPnlLamports: 500_000,
        realizedPnlBps: 50,
        tokensHeld: "0",
      }).status,
    ).toBe("CLOSED");
    expect(repos.tokenRadar.updateRadarStatus(result.rejectedRadarTokenId, "IGNORED").status).toBe(
      "IGNORED",
    );
  });

  it("deduplicates radar upserts by session, mint, source, and pair", () => {
    testDb = createTestDatabase();
    const result = seedPaperDatabase(testDb.context);
    const repos = createRepositories(testDb.context.db);

    const first = repos.tokenRadar.getRadarEntryById(result.radarTokenId);

    if (!first) {
      throw new Error("Expected seeded radar entry to exist.");
    }

    const upserted = repos.tokenRadar.upsertRadarEntry({
      sessionId: result.sessionId,
      mintAddress: first.mintAddress,
      symbol: "FAKE1",
      name: "Fake Momentum Token Updated",
      pairAddress: first.pairAddress,
      source: first.source,
      firstSeenAtMs: first.firstSeenAtMs + 10_000,
      discoveredAtMs: Date.now(),
      liquidityUsd: "13000",
      status: "WATCHING",
    });

    expect(upserted.id).toBe(result.radarTokenId);
    expect(upserted.firstSeenAtMs).toBe(first.firstSeenAtMs);
    expect(
      repos.tokenRadar.listRadarEntries(result.sessionId, { mintAddress: first.mintAddress }),
    ).toHaveLength(1);
  });

  it("round-trips JSON fields through repositories", () => {
    testDb = createTestDatabase();
    const result = seedPaperDatabase(testDb.context);
    const repos = createRepositories(testDb.context.db);
    const risk = repos.riskAssessments.getLatestRiskAssessment(
      result.sessionId,
      "Fake111111111111111111111111111111111111111",
    );

    expect(parseJson<string[]>(risk?.riskFlagsJson ?? "[]")).toContain("liquidity_ok");
  });

  it("creates and updates watchlist return observations", () => {
    testDb = createTestDatabase();
    const result = seedPaperDatabase(testDb.context);
    const repos = createRepositories(testDb.context.db);
    const decision = repos.strategyDecisions.listStrategyDecisions(result.sessionId, {
      decision: "BUY",
      limit: 1,
    })[0];

    if (!decision) {
      throw new Error("Expected seeded strategy decision to exist.");
    }

    const observation = repos.watchlistReturns.createObservation({
      sessionId: result.sessionId,
      strategyDecisionId: decision.id,
      tokenRadarId: result.radarTokenId,
      mintAddress: decision.mintAddress,
      pairAddress: "pair_1",
      symbol: "FAKE",
      decision: decision.decision,
      strategyName: decision.strategyName,
      strategyScore: decision.score,
      horizonMinutes: 60,
      baselineObservedAtMs: decision.decidedAtMs,
      baselinePriceSol: "0.001",
      baselinePriceUsd: "0.1",
      baselineSource: "STRATEGY_SNAPSHOT",
      dueAtMs: decision.decidedAtMs - 1,
    });

    expect(repos.watchlistReturns.getObservationById(observation.id)?.status).toBe("PENDING");
    expect(repos.watchlistReturns.listObservations(result.sessionId)).toHaveLength(1);
    expect(
      repos.watchlistReturns.listDueObservations(decision.decidedAtMs, {
        sessionId: result.sessionId,
      }),
    ).toHaveLength(1);
    expect(
      repos.watchlistReturns.upsertObservation({
        sessionId: result.sessionId,
        strategyDecisionId: decision.id,
        tokenRadarId: result.radarTokenId,
        mintAddress: decision.mintAddress,
        decision: decision.decision,
        strategyName: decision.strategyName,
        horizonMinutes: 60,
        baselineObservedAtMs: decision.decidedAtMs,
        baselineSource: "STRATEGY_SNAPSHOT",
        dueAtMs: decision.decidedAtMs - 1,
      }).id,
    ).toBe(observation.id);

    expect(
      repos.watchlistReturns.markObserved(observation.id, {
        observedAtMs: decision.decidedAtMs,
        observedPriceSol: "0.0012",
        returnPctSol: "20",
      }).status,
    ).toBe("OBSERVED");

    const failed = repos.watchlistReturns.createObservation({
      sessionId: result.sessionId,
      strategyDecisionId: decision.id,
      mintAddress: decision.mintAddress,
      decision: decision.decision,
      strategyName: decision.strategyName,
      horizonMinutes: 120,
      baselineObservedAtMs: decision.decidedAtMs,
      baselineSource: "MISSING_BASELINE_PRICE",
      dueAtMs: decision.decidedAtMs - 1,
    });
    const missed = repos.watchlistReturns.createObservation({
      sessionId: result.sessionId,
      strategyDecisionId: decision.id,
      mintAddress: decision.mintAddress,
      decision: decision.decision,
      strategyName: decision.strategyName,
      horizonMinutes: 240,
      baselineObservedAtMs: decision.decidedAtMs,
      baselineSource: "STRATEGY_SNAPSHOT",
      dueAtMs: decision.decidedAtMs - 1,
    });

    expect(
      repos.watchlistReturns.markFailed(failed.id, {
        errorCode: "PROVIDER_ERROR",
        errorMessage: "provider failed",
      }).status,
    ).toBe("FAILED");
    expect(
      repos.watchlistReturns.markMissed(missed.id, {
        errorCode: "OBSERVATION_WINDOW_EXPIRED",
        errorMessage: "too late",
      }).status,
    ).toBe("MISSED");
  });
});
