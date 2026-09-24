import { afterEach, describe, expect, it } from "vitest";

import { parseTokenMintAddress, providerSuccess, type DexPairSnapshot } from "@nexustrade/shared";

import type { TestDatabaseContext } from "../db/testing/createTestDatabase.js";
import { createTestDatabase } from "../db/testing/createTestDatabase.js";
import { createRepositories, type Repositories } from "../db/repositories/index.js";
import { MarketDataService } from "../providers/MarketDataService.js";
import { ProviderRegistry } from "../providers/ProviderRegistry.js";
import type { LiquidityProvider, TokenDiscoveryProvider } from "../providers/interfaces/index.js";
import { defaultScannerConfig, type ScannerRuntimeConfig } from "./ScannerConfig.js";
import { ScannerRunner } from "./ScannerRunner.js";

const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const USDC_MINT = parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const fetchedAt = new Date("2026-06-20T12:00:00.000Z");
let testDb: TestDatabaseContext | undefined;

describe("ScannerRunner", () => {
  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("auto-creates a PAPER session and stores discovered candidates", async () => {
    const { repositories, runner } = setupRunner();
    const result = await runner.runOnce();
    const session = repositories.sessions.getSessionById(result.sessionId);

    expect(session?.mode).toBe("PAPER");
    expect(session?.status).toBe("RUNNING");
    expect(session?.startingBalanceLamports).toBe(0);
    expect(session?.currentCashLamports).toBe(0);
    expect(result.storedCount).toBe(1);
    expect(repositories.tokenRadar.listRadarEntries(result.sessionId)).toHaveLength(1);
    expect(repositories.systemLogs.listLogs({ scope: "SCANNER" }).length).toBeGreaterThan(0);
    assertScannerSafetyBoundaries(repositories, result.sessionId);
  });

  it("does not write TokenRadar in dry-run mode", async () => {
    const { repositories, runner } = setupRunner({
      dryRun: true,
    });
    const result = await runner.runOnce();

    expect(result.dryRun).toBe(true);
    expect(result.storedCount).toBe(0);
    expect(repositories.tokenRadar.listRadarEntries(result.sessionId)).toHaveLength(0);
    assertScannerSafetyBoundaries(repositories, result.sessionId);
  });

  it("reuses CREATED PAPER sessions by marking them RUNNING", async () => {
    const context = createTestDatabase();
    testDb = context;
    const repositories = createRepositories(context.context.db);
    const session = repositories.sessions.createSession({
      mode: "PAPER",
      status: "CREATED",
      startedAtMs: fetchedAt.getTime(),
      startingBalanceLamports: 0,
      currentCashLamports: 0,
      configSnapshotJson: "{}",
    });
    const runner = createRunner(repositories, {
      sessionId: session.id,
    });
    const result = await runner.runOnce();

    expect(result.sessionId).toBe(session.id);
    expect(repositories.sessions.getSessionById(session.id)?.status).toBe("RUNNING");
  });

  it("rejects non-reusable scanner sessions", async () => {
    const context = createTestDatabase();
    testDb = context;
    const repositories = createRepositories(context.context.db);
    const session = repositories.sessions.createSession({
      mode: "PAPER",
      status: "COMPLETED",
      startedAtMs: fetchedAt.getTime(),
      startingBalanceLamports: 0,
      currentCashLamports: 0,
      configSnapshotJson: "{}",
    });
    const runner = createRunner(repositories, {
      sessionId: session.id,
    });

    await expect(runner.runOnce()).rejects.toThrow(/not reusable/);
  });
});

function setupRunner(config: Partial<ScannerRuntimeConfig> = {}): {
  readonly repositories: Repositories;
  readonly runner: ScannerRunner;
} {
  testDb = createTestDatabase();
  const repositories = createRepositories(testDb.context.db);

  return {
    repositories,
    runner: createRunner(repositories, config),
  };
}

function createRunner(
  repositories: Repositories,
  config: Partial<ScannerRuntimeConfig> = {},
): ScannerRunner {
  const registry = createMockRegistry();

  return new ScannerRunner({
    config: {
      ...defaultScannerConfig(),
      once: true,
      ...config,
    },
    repositories,
    registry,
    marketDataService: new MarketDataService(registry),
    clock: () => fetchedAt.getTime(),
  });
}

function createMockRegistry(): ProviderRegistry {
  const discoveryProvider: TokenDiscoveryProvider = {
    name: "MOCK",
    capabilities: ["TOKEN_DISCOVERY"],
    discoverTokens: async () =>
      providerSuccess({
        provider: "MOCK",
        data: [
          {
            chainId: "solana",
            mintAddress: SOL_MINT,
            symbol: "SOL",
          },
        ],
        fetchedAt,
      }),
  };
  const pair: DexPairSnapshot = {
    chainId: "solana",
    dexId: "mockdex",
    pairAddress: "pair_1",
    baseMint: SOL_MINT,
    quoteMint: USDC_MINT,
    source: "MOCK",
    fetchedAt,
    baseSymbol: "SOL",
    liquidityUsd: 10_000,
    volume5m: 500,
    volume1h: 2_500,
    pairCreatedAt: new Date(fetchedAt.getTime() - 60_000),
  };
  const liquidityProvider: LiquidityProvider = {
    name: "MOCK",
    capabilities: ["LIQUIDITY"],
    getPairsForToken: async () =>
      providerSuccess({
        provider: "MOCK",
        data: [pair],
        fetchedAt,
      }),
    getBestPairForToken: async () =>
      providerSuccess({
        provider: "MOCK",
        data: pair,
        fetchedAt,
      }),
  };

  return new ProviderRegistry([discoveryProvider, liquidityProvider]);
}

function assertScannerSafetyBoundaries(repositories: Repositories, sessionId: string): void {
  expect(repositories.riskAssessments.listRiskAssessments(sessionId)).toHaveLength(0);
  expect(repositories.strategyDecisions.listStrategyDecisions(sessionId)).toHaveLength(0);
  expect(repositories.orders.listOrders(sessionId)).toHaveLength(0);
  expect(repositories.fills.listFillsForSession(sessionId)).toHaveLength(0);
  expect(repositories.positions.listOpenPositions(sessionId)).toHaveLength(0);
  expect(repositories.positions.listClosedPositions(sessionId)).toHaveLength(0);
}
