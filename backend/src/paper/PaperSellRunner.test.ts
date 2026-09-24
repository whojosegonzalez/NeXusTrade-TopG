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
import { positionSnapshots } from "../db/schema/index.js";
import type { PositionRecord } from "../db/schema/index.js";
import { stringifyJson } from "../db/utils/json.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import { parsePaperSellArgs, type PaperSellRuntimeConfig } from "./PaperSellConfig.js";
import { PaperSellRunner } from "./PaperSellRunner.js";

const now = new Date("2026-06-21T14:00:00.000Z");
const MINT_A = parseTokenMintAddress("DezXAZ8z7PnrnRJjz3s4c5t5j4NKNQwXn8N9n6RSLH5");
const MINT_B = parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const STARTING_CASH_LAMPORTS = 900_000_000;
const BUY_COST_BASIS_LAMPORTS = 10_100_000;
const BUY_FEES_LAMPORTS = 5_000;
const GROSS_SELL_PROCEEDS_LAMPORTS = 20_000_000;
const SELL_SLIPPAGE_LAMPORTS = 200_000;
const NET_SELL_PROCEEDS_LAMPORTS = 19_795_000;
const REALIZED_PNL_LAMPORTS = 9_690_000;
let testDb: TestDatabaseContext | undefined;

describe("PaperSellRunner", () => {
  it("uses refreshed provider pricing when the fake provider has no exact quote", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    createBoughtRadar(repositories, session.id, MINT_A);
    createOpenPosition(repositories, session.id, MINT_A);
    const result = await createRunner(repositories, {
      marketDataService: createMarketDataService({ priceSol: 0.002 }),
    }).runOnce();
    expect(result).toMatchObject({
      closedCount: 1,
      refreshedPriceCount: 1,
      cachedFallbackCount: 0,
      totalNetProceedsLamports: NET_SELL_PROCEEDS_LAMPORTS,
    });
  });
  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("creates a SELL order, SELL fill, closes the position, restores cash, stores P/L, and returns TokenRadar to WATCHING", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createBoughtRadar(repositories, session.id, MINT_A);
    const position = createOpenPosition(repositories, session.id, MINT_A);

    const result = await createRunner(repositories, {
      marketDataService: createMarketDataService({
        quoteOutputLamports: GROSS_SELL_PROCEEDS_LAMPORTS,
      }),
    }).runOnce();
    const orders = repositories.orders.listOrders(session.id);
    const fills = repositories.fills.listFillsForSession(session.id);
    const closedPositions = repositories.positions.listClosedPositions(session.id);
    const updatedSession = repositories.sessions.getSessionById(session.id);
    const updatedRadar = repositories.tokenRadar.getRadarEntryById(radar.id);

    expect(result).toMatchObject({
      selectedCount: 1,
      evaluatedCount: 1,
      quotedCount: 1,
      closedCount: 1,
      rejectedCount: 0,
      failedCount: 0,
      orderCreatedCount: 1,
      fillCreatedCount: 1,
      cashUpdatedCount: 1,
      radarStatusUpdatedCount: 1,
      totalGrossProceedsLamports: GROSS_SELL_PROCEEDS_LAMPORTS,
      totalNetProceedsLamports: NET_SELL_PROCEEDS_LAMPORTS,
      totalRealizedPnlLamports: REALIZED_PNL_LAMPORTS,
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      side: "SELL",
      status: "FILLED",
      mintAddress: MINT_A,
      requestedTokenAmount: "10",
    });
    expect(orders[0]?.rawOrderJson).toContain(position.id);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      orderId: orders[0]?.id,
      fillPriceSol: "0.002",
      tokensFilled: "10",
      solReceivedLamports: NET_SELL_PROCEEDS_LAMPORTS,
      estimatedBaseFeeLamports: 5_000,
      estimatedPriorityFeeLamports: 0,
      estimatedSlippageLamports: SELL_SLIPPAGE_LAMPORTS,
      priceImpactBps: 120,
      quoteSource: "MOCK",
    });
    expect(fills[0]?.rawQuoteJson).toContain("grossProceedsLamports");
    expect(closedPositions).toHaveLength(1);
    expect(closedPositions[0]).toMatchObject({
      id: position.id,
      status: "CLOSED",
      tokensHeld: "0",
      proceedsLamports: NET_SELL_PROCEEDS_LAMPORTS,
      realizedPnlLamports: REALIZED_PNL_LAMPORTS,
      realizedPnlBps: 9589,
      feesPaidLamports: 10_000,
    });
    expect(updatedSession?.currentCashLamports).toBe(
      STARTING_CASH_LAMPORTS + NET_SELL_PROCEEDS_LAMPORTS,
    );
    expect(updatedSession?.realizedPnlLamports).toBe(REALIZED_PNL_LAMPORTS);
    expect(updatedRadar?.status).toBe("WATCHING");
    expect(updatedRadar?.notes).toContain("Paper SELL closed");
    expect(repositories.systemLogs.listLogs({ scope: "EXECUTION" }).length).toBeGreaterThan(0);
    assertSellSafetyBoundaries(repositories, session.id);
  });

  it("simulates SELL execution but skips writes in dry-run mode", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createBoughtRadar(repositories, session.id, MINT_A);
    const position = createOpenPosition(repositories, session.id, MINT_A);

    const result = await createRunner(repositories, {
      config: { dryRun: true },
      marketDataService: createMarketDataService({
        quoteOutputLamports: GROSS_SELL_PROCEEDS_LAMPORTS,
      }),
    }).runOnce();

    expect(result).toMatchObject({
      selectedCount: 1,
      quotedCount: 1,
      closedCount: 0,
      orderCreatedCount: 0,
      fillCreatedCount: 0,
      cashUpdatedCount: 0,
      radarStatusUpdatedCount: 0,
      totalNetProceedsLamports: NET_SELL_PROCEEDS_LAMPORTS,
    });
    expect(repositories.orders.listOrders(session.id)).toHaveLength(0);
    expect(repositories.fills.listFillsForSession(session.id)).toHaveLength(0);
    expect(repositories.positions.getPositionById(position.id)?.status).toBe("OPEN");
    expect(repositories.sessions.getSessionById(session.id)?.currentCashLamports).toBe(
      STARTING_CASH_LAMPORTS,
    );
    expect(repositories.tokenRadar.getRadarEntryById(radar.id)?.status).toBe("BOUGHT");
  });

  it("requires refreshed pricing unless cached TokenRadar price fallback is explicitly enabled", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createBoughtRadar(repositories, session.id, MINT_A);
    const position = createOpenPosition(repositories, session.id, MINT_A);

    const result = await createRunner(repositories, {
      marketDataService: createMarketDataService({ failRefresh: true }),
    }).runOnce();
    const orders = repositories.orders.listOrders(session.id);

    expect(result).toMatchObject({
      rejectedCount: 0,
      failedCount: 1,
      orderCreatedCount: 0,
      fillCreatedCount: 0,
      closedCount: 0,
      cashUpdatedCount: 0,
    });
    expect(orders).toHaveLength(0);
    expect(repositories.operations.listOperations(session.id)[0]?.state).toBe("PENDING");
    expect(repositories.positions.getPositionById(position.id)?.status).toBe("OPEN");
    expect(repositories.tokenRadar.getRadarEntryById(radar.id)?.status).toBe("BOUGHT");
  });

  it("uses allowed fresh cached TokenRadar pricing when refreshed pricing is unavailable", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);

    createBoughtRadar(repositories, session.id, MINT_A, { priceSol: "0.002" });
    createOpenPosition(repositories, session.id, MINT_A);

    const result = await createRunner(repositories, {
      config: {
        allowCachedRadarPrice: true,
      },
      marketDataService: createMarketDataService({ failRefresh: true }),
    }).runOnce();

    expect(result).toMatchObject({
      quotedCount: 1,
      cachedFallbackCount: 1,
      closedCount: 1,
      totalNetProceedsLamports: NET_SELL_PROCEEDS_LAMPORTS,
    });
  });

  it("rejects stale cached TokenRadar pricing", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);

    createBoughtRadar(repositories, session.id, MINT_A, {
      priceSol: "0.002",
      createdAtMs: now.getTime() - 120_000,
      updatedAtMs: now.getTime() - 120_000,
    });
    createOpenPosition(repositories, session.id, MINT_A);

    const result = await createRunner(repositories, {
      config: {
        allowCachedRadarPrice: true,
        maxCachedPriceAgeMs: 60_000,
      },
      marketDataService: createMarketDataService({ failRefresh: true }),
    }).runOnce();
    const orders = repositories.orders.listOrders(session.id);

    expect(result).toMatchObject({
      rejectedCount: 0,
      failedCount: 1,
      cachedFallbackCount: 0,
      closedCount: 0,
    });
    expect(orders).toHaveLength(0);
    expect(repositories.operations.listOperations(session.id)[0]?.state).toBe("PENDING");
  });

  it("supports mint-scoped SELL selection without closing other positions", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);

    createBoughtRadar(repositories, session.id, MINT_A);
    createBoughtRadar(repositories, session.id, MINT_B);
    const first = createOpenPosition(repositories, session.id, MINT_A);
    const second = createOpenPosition(repositories, session.id, MINT_B, { id: "pos_second" });

    const result = await createRunner(repositories, {
      config: parseConfig([`--mint=${MINT_B}`]),
      marketDataService: createMarketDataService({
        quoteOutputLamports: GROSS_SELL_PROCEEDS_LAMPORTS,
      }),
    }).runOnce();

    expect(result.selectedCount).toBe(1);
    expect(repositories.positions.getPositionById(first.id)?.status).toBe("OPEN");
    expect(repositories.positions.getPositionById(second.id)?.status).toBe("CLOSED");
  });

  it("does not sell already closed positions on repeated runs", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);

    createBoughtRadar(repositories, session.id, MINT_A);
    createOpenPosition(repositories, session.id, MINT_A);

    const runner = createRunner(repositories, {
      marketDataService: createMarketDataService({
        quoteOutputLamports: GROSS_SELL_PROCEEDS_LAMPORTS,
      }),
    });

    await runner.runOnce();

    await expect(runner.runOnce()).rejects.toThrow(/OPEN positions/);
    expect(repositories.positions.listClosedPositions(session.id)).toHaveLength(1);
    expect(repositories.fills.listFillsForSession(session.id)).toHaveLength(1);
  });
});

function setupRepositories(): Repositories {
  testDb = createTestDatabase();
  return createRepositories(testDb.context.db);
}

function createRunner(
  repositories: Repositories,
  options: {
    readonly config?: Partial<PaperSellRuntimeConfig> | PaperSellRuntimeConfig;
    readonly marketDataService?: Pick<MarketDataService, "enrichToken">;
  } = {},
): PaperSellRunner {
  const baseConfig = isFullConfig(options.config)
    ? options.config
    : {
        ...parseConfig(["--sell-all"]),
        ...options.config,
      };

  return new PaperSellRunner({
    repositories,
    config: baseConfig,
    marketDataService:
      options.marketDataService ??
      createMarketDataService({ quoteOutputLamports: GROSS_SELL_PROCEEDS_LAMPORTS }),
  });
}

function isFullConfig(
  config: Partial<PaperSellRuntimeConfig> | PaperSellRuntimeConfig | undefined,
): config is PaperSellRuntimeConfig {
  return config !== undefined && "trigger" in config;
}

function parseConfig(argv: readonly string[]): PaperSellRuntimeConfig {
  return {
    ...parsePaperSellArgs(argv),
    once: true,
  };
}

function createSession(repositories: Repositories) {
  return repositories.sessions.createSession({
    id: "session_sell",
    mode: "PAPER",
    status: "RUNNING",
    startedAtMs: now.getTime(),
    startingBalanceLamports: 1_000_000_000,
    currentCashLamports: STARTING_CASH_LAMPORTS,
    configSnapshotJson: "{}",
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
    symbol: "SELL",
    source: "DEXSCREENER",
    firstSeenAtMs: now.getTime() - 60_000,
    discoveredAtMs: now.getTime() - 60_000,
    priceSol: "0.002",
    priceUsd: "0.4",
    status: "BOUGHT",
    notes: "paper buy",
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

function createOpenPosition(
  repositories: Repositories,
  sessionId: string,
  mintAddress: TokenMintAddress,
  overrides: Partial<Parameters<Repositories["positions"]["openPosition"]>[0]> = {},
): PositionRecord {
  return repositories.positions.openPosition({
    id: "pos_sell",
    sessionId,
    mintAddress,
    status: "OPEN",
    openedAtMs: now.getTime() - 30_000,
    avgEntryPriceSol: "0.001",
    tokensHeld: "10",
    costBasisLamports: BUY_COST_BASIS_LAMPORTS,
    feesPaidLamports: BUY_FEES_LAMPORTS,
    ...overrides,
  });
}

function createMarketDataService(options: {
  readonly quoteOutputLamports?: number;
  readonly failRefresh?: boolean;
  readonly priceSol?: number;
}): Pick<MarketDataService, "enrichToken"> {
  return {
    enrichToken: async (request): Promise<ProviderResult<TokenEnrichmentSnapshot>> => {
      if (options.failRefresh) {
        return providerSuccess({
          provider: "MOCK",
          data: createEnrichment(request.mintAddress),
          fetchedAt: now,
          warnings: ["No market data available."],
        });
      }

      return providerSuccess({
        provider: "MOCK",
        data: createEnrichment(
          request.mintAddress,
          options.priceSol ?? 0.002,
          request.sellQuoteRequest,
          options.quoteOutputLamports,
        ),
        fetchedAt: now,
      });
    },
  };
}

function createEnrichment(
  mintAddress: TokenMintAddress,
  priceSol?: number,
  sellQuoteRequest?: QuoteRequest,
  quoteOutputLamports?: number,
): TokenEnrichmentSnapshot {
  return {
    identity: {
      chainId: "solana",
      mintAddress,
      decimals: 6,
    },
    ...(priceSol !== undefined
      ? {
          price: {
            mintAddress,
            priceSol,
            priceUsd: priceSol * 200,
            source: "MOCK" as const,
            fetchedAt: now,
          },
        }
      : {}),
    ...(sellQuoteRequest && quoteOutputLamports
      ? {
          sellQuote: {
            inputMint: sellQuoteRequest.inputMint,
            outputMint: sellQuoteRequest.outputMint,
            inputAmountRaw: sellQuoteRequest.amountRaw,
            outputAmountRaw: String(quoteOutputLamports),
            estimatedPriceImpactPct: 1.2,
            source: "MOCK" as const,
            fetchedAt: now,
          },
        }
      : {}),
    sourcesUsed: ["MOCK"],
    warnings: [],
    fetchedAt: now,
  };
}

function assertSellSafetyBoundaries(repositories: Repositories, sessionId: string): void {
  expect(repositories.positions.listOpenPositions(sessionId)).toHaveLength(0);
  expect(repositories.snapshots.listEquitySnapshots(sessionId)).toHaveLength(0);
  expect(testDb?.context.db.select().from(positionSnapshots).all()).toHaveLength(0);
}
