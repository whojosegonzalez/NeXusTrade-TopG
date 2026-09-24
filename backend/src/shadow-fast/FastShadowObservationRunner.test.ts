import { afterEach, describe, expect, it } from "vitest";
import {
  parseTokenMintAddress,
  providerSuccess,
  type TokenEnrichmentSnapshot,
} from "@nexustrade/shared";

import { createRepositories, type Repositories } from "../db/repositories/index.js";
import { createTestDatabase, type TestDatabaseContext } from "../db/testing/createTestDatabase.js";
import { stringifyJson } from "../db/utils/json.js";
import type { FastShadowRuntimeConfig } from "./FastShadowTypes.js";
import { FastShadowObservationRunner } from "./FastShadowObservationRunner.js";

const mint = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const now = 1_800_000_000_000;
let testDb: TestDatabaseContext | undefined;

describe("FastShadowObservationRunner", () => {
  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("writes only 3/5/15-minute watchlist rows and observes due on-time rows", async () => {
    const repositories = setup();
    repositories.sessions.createSession({
      id: "session",
      mode: "PAPER",
      status: "RUNNING",
      startedAtMs: now - 10 * 60_000,
      startingBalanceLamports: 0,
      currentCashLamports: 0,
      configSnapshotJson: "{}",
    });
    repositories.strategyDecisions.createStrategyDecision({
      id: "decision",
      sessionId: "session",
      mintAddress: mint,
      decidedAtMs: now - 5 * 60_000,
      decision: "SKIP",
      strategyName: "test",
      score: 65,
      reason: "stored facts",
      inputSnapshotJson: snapshot(),
    });

    const result = await runner(repositories).runOnce();
    const observations = repositories.watchlistReturns.listObservations("session", { limit: 10 });

    expect(result).toMatchObject({
      selectedCount: 1,
      scheduledCount: 3,
      dueCount: 2,
      observedCount: 2,
    });
    expect(
      observations.map((row) => row.horizonMinutes).sort((left, right) => left - right),
    ).toEqual([3, 5, 15]);
    expect(observations.filter((row) => row.status === "OBSERVED")).toHaveLength(2);
    expect(repositories.orders.listOrders("session")).toHaveLength(0);
    expect(repositories.positions.listOpenPositions("session")).toHaveLength(0);
  });

  it("does not touch unrelated due observations when the F65E cohort is empty", async () => {
    const repositories = setup();
    repositories.sessions.createSession({
      id: "session",
      mode: "PAPER",
      status: "RUNNING",
      startedAtMs: now - 10 * 60_000,
      startingBalanceLamports: 0,
      currentCashLamports: 0,
      configSnapshotJson: "{}",
    });
    repositories.strategyDecisions.createStrategyDecision({
      id: "not-fast",
      sessionId: "session",
      mintAddress: mint,
      decidedAtMs: now - 5 * 60_000,
      decision: "SKIP",
      strategyName: "test",
      score: 70,
      reason: "outside fast profile",
      inputSnapshotJson: snapshot(),
    });
    repositories.watchlistReturns.createObservation({
      sessionId: "session",
      strategyDecisionId: "not-fast",
      mintAddress: mint,
      decision: "SKIP",
      strategyName: "test",
      strategyScore: 70,
      horizonMinutes: 3,
      baselineObservedAtMs: now - 5 * 60_000,
      baselinePriceSol: "0.0001",
      baselineSource: "TEST",
      dueAtMs: now - 2 * 60_000,
      status: "PENDING",
    });

    const result = await runner(repositories).runOnce();
    const existing = repositories.watchlistReturns.getObservationByDecisionHorizon("not-fast", 3);

    expect(result).toMatchObject({ selectedCount: 0, dueCount: 0, missedCount: 0 });
    expect(existing?.status).toBe("PENDING");
  });
});

function setup(): Repositories {
  testDb = createTestDatabase();
  return createRepositories(testDb.context.db);
}

function runner(repositories: Repositories): FastShadowObservationRunner {
  const config: FastShadowRuntimeConfig = {
    once: true,
    dryRun: false,
    json: false,
    sessionId: "session",
    intervalMs: 60_000,
  };
  return new FastShadowObservationRunner({
    config,
    repositories,
    clock: () => now,
    marketDataService: {
      enrichToken: async () =>
        providerSuccess<TokenEnrichmentSnapshot>({
          provider: "DEXSCREENER",
          data: {
            identity: { chainId: "solana", mintAddress: mint },
            price: {
              mintAddress: mint,
              source: "DEXSCREENER",
              fetchedAt: new Date(now),
              priceSol: 0.00011,
              priceUsd: 0.011,
            },
            sourcesUsed: ["DEXSCREENER"],
            warnings: [],
            fetchedAt: new Date(now),
          },
        }),
    },
  });
}

function snapshot(): string {
  return stringifyJson({
    tokenRadar: {
      mintAddress: mint,
      symbol: "SOL",
      priceSol: "0.0001",
      priceUsd: "0.01",
      updatedAtMs: now - 5 * 60_000,
    },
    riskAssessment: { result: "PASS", riskFlags: [] },
    strategyScore: {
      rawDecision: "SKIP",
      buyScoreThreshold: 90,
      watchScoreThreshold: 70,
      buyEligible: true,
      factors: [
        "risk_eligibility",
        "liquidity_attractiveness",
        "volume_1h_attractiveness",
        "pair_age_attractiveness",
        "price_impact_attractiveness",
      ].map((ruleName) => ({ ruleName, points: 1, passed: true, warnings: [] })),
    },
  });
}
