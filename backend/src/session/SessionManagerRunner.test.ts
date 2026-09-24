import {
  parseTokenMintAddress,
  providerSuccess,
  type ProviderResult,
  type QuoteRequest,
  type TokenEnrichmentSnapshot,
  type TokenMintAddress,
} from "@nexustrade/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { TestDatabaseContext } from "../db/testing/createTestDatabase.js";
import { createTestDatabase } from "../db/testing/createTestDatabase.js";
import { createRepositories, type Repositories } from "../db/repositories/index.js";
import { stringifyJson } from "../db/utils/json.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import {
  defaultSessionManagerConfig,
  type SessionManagerRuntimeConfig,
} from "./SessionManagerConfig.js";
import { SessionManagerRunner } from "./SessionManagerRunner.js";

const now = new Date("2026-06-21T14:00:00.000Z");
const NOW_MS = now.getTime();
const TOKEN_MINT = parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SECOND_TOKEN_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const STARTING_BALANCE_LAMPORTS = 1_000_000_000;
let testDb: TestDatabaseContext | undefined;

describe("SessionManagerRunner", () => {
  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("creates equity and position snapshots, updates unrealized P/L, and gates target reached", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, {
      currentCashLamports: 900_000_000,
      targetProfitLamports: 50_000_000,
    });

    createOpenPosition(repositories, session.id, TOKEN_MINT);
    createBoughtRadar(repositories, session.id, TOKEN_MINT);

    const result = await createRunner(repositories, {
      marketDataService: createMarketDataService({ priceSol: 0.02 }),
    }).runOnce();
    const updatedSession = repositories.sessions.getSessionById(session.id);
    const equitySnapshots = repositories.snapshots.listEquitySnapshots(session.id);
    const positionSnapshots = repositories.snapshots.listPositionSnapshots(
      repositories.positions.listOpenPositions(session.id)[0]?.id ?? "",
    );

    expect(result).toMatchObject({
      openPositionCount: 1,
      positionSnapshotCount: 1,
      equitySnapshotCreated: true,
      cashLamports: 900_000_000,
      openPositionValueLamports: 200_000_000,
      totalEquityLamports: 1_100_000_000,
      unrealizedPnlLamports: 99_995_000,
      terminationReasonBefore: "NOT_TERMINATED",
      terminationReasonAfter: "TARGET_REACHED",
      buyGated: true,
      targetReached: true,
      drawdownReached: false,
      valuationUnavailableCount: 0,
    });
    expect(updatedSession).toMatchObject({
      status: "RUNNING",
      terminationReason: "TARGET_REACHED",
      unrealizedPnlLamports: 99_995_000,
    });
    expect(equitySnapshots).toHaveLength(1);
    expect(equitySnapshots[0]).toMatchObject({
      cashLamports: 900_000_000,
      openPositionValueLamports: 200_000_000,
      totalEquityLamports: 1_100_000_000,
      unrealizedPnlLamports: 99_995_000,
      drawdownLamports: 0,
    });
    expect(positionSnapshots).toHaveLength(1);
    expect(positionSnapshots[0]).toMatchObject({
      markPriceSol: "0.02",
      sellQuoteLamports: 200_000_000,
      unrealizedPnlLamports: 99_995_000,
    });
    expect(positionSnapshots[0]?.rawQuoteJson).toContain("REFRESHED_PRICE");
    expect(repositories.systemLogs.listLogs({ scope: "SESSION" }).length).toBeGreaterThan(0);
    assertSessionManagerSafetyBoundaries(repositories, session.id);
  });

  it("calculates in dry-run without writing snapshots or session updates", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, {
      currentCashLamports: 900_000_000,
      targetProfitLamports: 50_000_000,
    });

    createOpenPosition(repositories, session.id, TOKEN_MINT);
    createBoughtRadar(repositories, session.id, TOKEN_MINT);

    const result = await createRunner(repositories, {
      config: { dryRun: true },
      marketDataService: createMarketDataService({ priceSol: 0.02 }),
    }).runOnce();

    expect(result).toMatchObject({
      equitySnapshotCreated: false,
      positionSnapshotCount: 0,
      terminationReasonAfter: "TARGET_REACHED",
      buyGated: true,
      dryRun: true,
    });
    expect(repositories.snapshots.listEquitySnapshots(session.id)).toHaveLength(0);
    expect(repositories.sessions.getSessionById(session.id)).toMatchObject({
      terminationReason: "NOT_TERMINATED",
      unrealizedPnlLamports: 0,
    });
  });

  it("sets MAX_DRAWDOWN when drawdown is reached and gives drawdown priority", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, {
      currentCashLamports: 1_150_000_000,
      targetProfitLamports: 50_000_000,
      maxDrawdownLamports: 100_000_000,
    });

    repositories.snapshots.createEquitySnapshot({
      sessionId: session.id,
      timestampMs: NOW_MS - 60_000,
      cashLamports: 1_500_000_000,
      openPositionValueLamports: 0,
      totalEquityLamports: 1_500_000_000,
      realizedPnlLamports: 0,
      unrealizedPnlLamports: 0,
      drawdownLamports: 0,
    });

    const result = await createRunner(repositories).runOnce();

    expect(result).toMatchObject({
      totalEquityLamports: 1_150_000_000,
      targetReached: true,
      drawdownReached: true,
      peakEquityLamports: 1_500_000_000,
      drawdownLamports: 350_000_000,
      terminationReasonAfter: "MAX_DRAWDOWN",
    });
    expect(repositories.sessions.getSessionById(session.id)?.terminationReason).toBe(
      "MAX_DRAWDOWN",
    );
  });

  it("does not overwrite an existing gate reason and continues snapshotting", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, {
      currentCashLamports: 800_000_000,
      maxDrawdownLamports: 100_000_000,
      terminationReason: "TARGET_REACHED",
    });

    const result = await createRunner(repositories).runOnce();

    expect(result).toMatchObject({
      drawdownReached: true,
      terminationReasonBefore: "TARGET_REACHED",
      terminationReasonAfter: "TARGET_REACHED",
      equitySnapshotCreated: true,
    });
    expect(repositories.sessions.getSessionById(session.id)?.terminationReason).toBe(
      "TARGET_REACHED",
    );
    expect(repositories.snapshots.listEquitySnapshots(session.id)).toHaveLength(1);
  });

  it("uses cached radar or entry-price fallback for positions without provider pricing", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, { currentCashLamports: 900_000_000 });
    const position = createOpenPosition(repositories, session.id, TOKEN_MINT);

    createBoughtRadar(repositories, session.id, TOKEN_MINT, { priceSol: "0.015" });

    const cachedResult = await createRunner(repositories, {
      marketDataService: createMarketDataService({}),
    }).runOnce();
    const cachedSnapshot = repositories.snapshots.listPositionSnapshots(position.id)[0];

    expect(cachedResult.openPositionValueLamports).toBe(150_000_000);
    expect(cachedSnapshot?.rawQuoteJson).toContain("CACHED_RADAR_PRICE");

    const secondSession = createSession(repositories, {
      id: "session_entry_fallback",
      currentCashLamports: 900_000_000,
    });
    const secondPosition = createOpenPosition(repositories, secondSession.id, SECOND_TOKEN_MINT);

    const entryResult = await createRunner(repositories, {
      config: { sessionId: secondSession.id },
      marketDataService: createMarketDataService({}),
    }).runOnce();
    const entrySnapshot = repositories.snapshots.listPositionSnapshots(secondPosition.id)[0];

    expect(entryResult.openPositionValueLamports).toBe(100_000_000);
    expect(entrySnapshot?.rawQuoteJson).toContain("ENTRY_PRICE");
  });
});

function setupRepositories(): Repositories {
  testDb = createTestDatabase();
  return createRepositories(testDb.context.db);
}

function createRunner(
  repositories: Repositories,
  options: {
    readonly config?: Partial<SessionManagerRuntimeConfig>;
    readonly marketDataService?: Pick<MarketDataService, "enrichToken">;
  } = {},
): SessionManagerRunner {
  return new SessionManagerRunner({
    repositories,
    config: {
      ...defaultSessionManagerConfig(),
      once: true,
      ...options.config,
    },
    marketDataService: options.marketDataService ?? createMarketDataService({}),
  });
}

function createSession(
  repositories: Repositories,
  overrides: Partial<Parameters<Repositories["sessions"]["createSession"]>[0]> = {},
) {
  return repositories.sessions.createSession({
    id: "session_manager",
    mode: "PAPER",
    status: "RUNNING",
    startedAtMs: NOW_MS,
    startingBalanceLamports: STARTING_BALANCE_LAMPORTS,
    currentCashLamports: STARTING_BALANCE_LAMPORTS,
    configSnapshotJson: stringifyJson({ test: true }),
    ...overrides,
  });
}

function createOpenPosition(
  repositories: Repositories,
  sessionId: string,
  mintAddress: TokenMintAddress,
) {
  return repositories.positions.openPosition({
    sessionId,
    mintAddress,
    status: "OPEN",
    openedAtMs: NOW_MS - 1_000,
    avgEntryPriceSol: "0.01",
    tokensHeld: "10",
    costBasisLamports: 100_000_000,
    feesPaidLamports: 5_000,
  });
}

function createBoughtRadar(
  repositories: Repositories,
  sessionId: string,
  mintAddress: TokenMintAddress,
  overrides: Partial<Parameters<Repositories["tokenRadar"]["createRadarEntry"]>[0]> = {},
) {
  return repositories.tokenRadar.createRadarEntry({
    sessionId,
    mintAddress,
    symbol: "TOK",
    source: "DEXSCREENER",
    firstSeenAtMs: NOW_MS - 60_000,
    discoveredAtMs: NOW_MS - 30_000,
    priceSol: "0.01",
    priceUsd: "2",
    liquidityUsd: "25000",
    status: "BOUGHT",
    rawDataJson: stringifyJson({
      enrichment: {
        metadata: {
          decimals: 6,
        },
      },
    }),
    ...overrides,
  });
}

function createMarketDataService(options: {
  readonly priceSol?: number;
  readonly quoteLamports?: number;
}): Pick<MarketDataService, "enrichToken"> {
  return {
    enrichToken: async (request): Promise<ProviderResult<TokenEnrichmentSnapshot>> => {
      const sellQuote = request.sellQuoteRequest
        ? createQuote(request.sellQuoteRequest, options.quoteLamports)
        : undefined;
      const data: TokenEnrichmentSnapshot = {
        identity: {
          chainId: "solana",
          mintAddress: request.mintAddress,
          decimals: 6,
        },
        ...(options.priceSol !== undefined
          ? {
              price: {
                mintAddress: request.mintAddress,
                priceSol: options.priceSol,
                priceUsd: options.priceSol * 100,
                source: "MOCK",
                fetchedAt: now,
              },
            }
          : {}),
        ...(options.priceSol !== undefined
          ? {
              bestPair: {
                chainId: "solana",
                dexId: "mock",
                pairAddress: "pair_mock",
                baseMint: request.mintAddress,
                quoteMint: parseTokenMintAddress("So11111111111111111111111111111111111111112"),
                priceNative: options.priceSol,
                priceUsd: options.priceSol * 100,
                liquidityUsd: 25_000,
                source: "MOCK",
                fetchedAt: now,
              },
            }
          : {}),
        ...(sellQuote ? { sellQuote } : {}),
        sourcesUsed: options.priceSol !== undefined || sellQuote ? ["MOCK"] : [],
        warnings: options.priceSol !== undefined || sellQuote ? [] : ["mock provider no price"],
        fetchedAt: now,
      };

      return providerSuccess({
        provider: "MOCK",
        data,
        warnings: data.warnings,
        fetchedAt: now,
      });
    },
  };
}

function createQuote(
  request: QuoteRequest,
  quoteLamports: number | undefined,
): TokenEnrichmentSnapshot["sellQuote"] {
  if (quoteLamports === undefined) {
    return undefined;
  }

  return {
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmountRaw: request.amountRaw,
    outputAmountRaw: String(quoteLamports),
    estimatedPriceImpactPct: 0.5,
    source: "MOCK",
    fetchedAt: now,
  };
}

function assertSessionManagerSafetyBoundaries(repositories: Repositories, sessionId: string): void {
  expect(repositories.orders.listOrders(sessionId)).toHaveLength(0);
  expect(repositories.fills.listFillsForSession(sessionId)).toHaveLength(0);
  expect(repositories.positions.listClosedPositions(sessionId)).toHaveLength(0);
}
