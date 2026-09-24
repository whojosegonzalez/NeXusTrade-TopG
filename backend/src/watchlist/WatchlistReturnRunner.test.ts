import { afterEach, describe, expect, it } from "vitest";
import {
  parseTokenMintAddress,
  providerSuccess,
  type TokenEnrichmentSnapshot,
} from "@nexustrade/shared";

import type { Repositories } from "../db/repositories/index.js";
import { createRepositories } from "../db/repositories/index.js";
import type { TestDatabaseContext } from "../db/testing/createTestDatabase.js";
import { createTestDatabase } from "../db/testing/createTestDatabase.js";
import { stringifyJson } from "../db/utils/json.js";
import type { WatchlistReturnRuntimeConfig } from "./WatchlistReturnConfig.js";
import { defaultWatchlistReturnConfig } from "./WatchlistReturnConfig.js";
import { WatchlistReturnRunner } from "./WatchlistReturnRunner.js";

const mintAddress = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const now = 1_800_000_000_000;
let testDb: TestDatabaseContext | undefined;

describe("WatchlistReturnRunner", () => {
  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("schedules and observes due forward-return horizons", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createRadar(repositories, session.id);
    const decision = createDecision(repositories, session.id, radar.id, {
      decision: "WATCH",
      decidedAtMs: now - 10 * 60_000,
      score: 80,
      priceSol: "0.00001",
      priceUsd: "0.001",
    });

    const result = await createRunner(repositories, {
      horizonsMinutes: [3, 5],
    }).runOnce();
    const observations = repositories.watchlistReturns.listObservations(session.id);

    expect(result).toMatchObject({
      selectedStrategyDecisions: 1,
      scheduledCount: 2,
      dueCount: 2,
      observedCount: 2,
      failedCount: 0,
    });
    expect(observations).toHaveLength(2);
    expect(observations.every((observation) => observation.status === "OBSERVED")).toBe(true);
    expect(
      Number(
        observations.find((observation) => observation.strategyDecisionId === decision.id)
          ?.returnPctSol,
      ),
    ).toBeCloseTo(20);
  });

  it("does not write observations in dry-run mode", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createRadar(repositories, session.id);

    createDecision(repositories, session.id, radar.id, {
      decision: "SKIP",
      decidedAtMs: now - 10 * 60_000,
      score: 75,
      priceSol: "0.00001",
    });

    const result = await createRunner(repositories, {
      dryRun: true,
      horizonsMinutes: [3, 5],
    }).runOnce();

    expect(result.scheduledCount).toBe(2);
    expect(repositories.watchlistReturns.listObservations(session.id)).toHaveLength(0);
  });

  it("records missing baseline price as a failed scheduled observation", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);

    createDecision(repositories, session.id, undefined, {
      decision: "WATCH",
      decidedAtMs: now - 10 * 60_000,
      score: 80,
    });

    const result = await createRunner(repositories, {
      horizonsMinutes: [3],
    }).runOnce();
    const observation = repositories.watchlistReturns.listObservations(session.id)[0];

    expect(result).toMatchObject({
      scheduledCount: 1,
      failedCount: 1,
    });
    expect(observation?.status).toBe("FAILED");
    expect(observation?.errorCode).toBe("MISSING_BASELINE_PRICE");
  });
});

function setupRepositories(): Repositories {
  testDb = createTestDatabase();
  return createRepositories(testDb.context.db);
}

function createSession(repositories: Repositories) {
  return repositories.sessions.createSession({
    id: "session_watchlist",
    mode: "PAPER",
    status: "RUNNING",
    startedAtMs: now - 60 * 60_000,
    startingBalanceLamports: 0,
    currentCashLamports: 0,
    configSnapshotJson: "{}",
  });
}

function createRadar(repositories: Repositories, sessionId: string) {
  return repositories.tokenRadar.createRadarEntry({
    id: "radar_watchlist",
    sessionId,
    mintAddress,
    symbol: "SOL",
    name: "Wrapped SOL",
    pairAddress: "pair_watchlist",
    source: "DEXSCREENER",
    firstSeenAtMs: now - 60 * 60_000,
    discoveredAtMs: now - 30 * 60_000,
    priceSol: "0.00001",
    priceUsd: "0.001",
    liquidityUsd: "100000",
    volume5mUsd: "1000",
    volume1hUsd: "10000",
    ageSeconds: 60 * 60,
    status: "WATCHING",
  });
}

function createDecision(
  repositories: Repositories,
  sessionId: string,
  tokenRadarId: string | undefined,
  input: {
    readonly decision: "WATCH" | "SKIP";
    readonly decidedAtMs: number;
    readonly score: number;
    readonly priceSol?: string;
    readonly priceUsd?: string;
  },
) {
  return repositories.strategyDecisions.createStrategyDecision({
    sessionId,
    mintAddress,
    decidedAtMs: input.decidedAtMs,
    decision: input.decision,
    strategyName: "phase8_7_test",
    score: input.score,
    reason: "test decision",
    inputSnapshotJson: stringifyJson({
      tokenRadar: {
        id: tokenRadarId,
        mintAddress,
        symbol: "SOL",
        priceSol: input.priceSol,
        priceUsd: input.priceUsd,
        liquidityUsd: "100000",
        volume5mUsd: "1000",
        volume1hUsd: "10000",
        updatedAtMs: input.decidedAtMs,
      },
      riskAssessment: {
        result: "WARN",
        riskFlags: ["MISSING_QUOTE"],
      },
      strategyScore: {
        facts: {
          maxPriceImpactPct: 1,
        },
        factors: [{ ruleName: "risk_eligibility", passed: false }],
      },
    }),
  });
}

function createRunner(
  repositories: Repositories,
  config: Partial<WatchlistReturnRuntimeConfig> = {},
): WatchlistReturnRunner {
  return new WatchlistReturnRunner({
    repositories,
    config: {
      ...defaultWatchlistReturnConfig(),
      once: true,
      limit: 10,
      sourceDecisions: ["WATCH", "SKIP"],
      minScore: 50,
      ...config,
    },
    marketDataService: {
      enrichToken: async () =>
        providerSuccess<TokenEnrichmentSnapshot>({
          provider: "DEXSCREENER",
          data: {
            identity: {
              chainId: "solana",
              mintAddress,
            },
            price: {
              mintAddress,
              source: "DEXSCREENER",
              fetchedAt: new Date(now),
              priceSol: 0.000012,
              priceUsd: 0.0012,
            },
            bestPair: {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "pair_watchlist",
              baseMint: mintAddress,
              quoteMint: mintAddress,
              source: "DEXSCREENER",
              fetchedAt: new Date(now),
              priceNative: 0.000012,
              priceUsd: 0.0012,
              liquidityUsd: 100000,
              volume5m: 1000,
              volume1h: 10000,
            },
            sourcesUsed: ["DEXSCREENER"],
            warnings: [],
            fetchedAt: new Date(now),
          },
        }),
    },
    clock: () => now,
  });
}
