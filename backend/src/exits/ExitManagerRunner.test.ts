import {
  parseTokenMintAddress,
  providerSuccess,
  type ProviderResult,
  type QuoteRequest,
  type TokenEnrichmentSnapshot,
  type TokenMintAddress,
} from "@nexustrade/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRepositories, type Repositories } from "../db/repositories/index.js";
import type { SessionRecord } from "../db/schema/index.js";
import type { TestDatabaseContext } from "../db/testing/createTestDatabase.js";
import { createTestDatabase } from "../db/testing/createTestDatabase.js";
import { stringifyJson } from "../db/utils/json.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import { defaultExitManagerConfig, type ExitManagerRuntimeConfig } from "./ExitManagerConfig.js";
import { ExitManagerRunner } from "./ExitManagerRunner.js";

const now = new Date("2026-06-22T10:00:00.000Z");
const MINT_A = parseTokenMintAddress("DezXAZ8z7PnrnRJjz3s4c5t5j4NKNQwXn8N9n6RSLH5");
const STARTING_CASH_LAMPORTS = 900_000_000;
const GROSS_SELL_PROCEEDS_LAMPORTS = 20_000_000;
const NET_SELL_PROCEEDS_LAMPORTS = 19_795_000;
const REALIZED_PNL_LAMPORTS = 9_690_000;
let testDb: TestDatabaseContext | undefined;

describe("ExitManagerRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    testDb?.cleanup();
    testDb = undefined;
  });

  it("keeps a completed SELL successful when ExitManager diagnostics fail", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, { terminationReason: "TARGET_REACHED" });
    createBoughtRadar(repositories, session.id, MINT_A);
    createOpenPosition(repositories, session.id, MINT_A);
    vi.spyOn(repositories.systemLogs, "createLog").mockImplementation(() => {
      throw new Error("diagnostic unavailable");
    });
    const result = await createRunner(repositories, {
      config: { sessionId: session.id, targetAction: "sell-all" },
    }).runOnce();
    expect(result).toMatchObject({ positionsClosed: 1, sellFailures: 0 });
    expect(result.diagnosticFailureCount).toBeGreaterThan(0);
    expect(repositories.orders.listOrders(session.id)[0]?.status).toBe("FILLED");
  });

  it("observes target-reached sessions by default without mutating execution records", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, { terminationReason: "TARGET_REACHED" });
    const position = createOpenPosition(repositories, session.id, MINT_A);

    createBoughtRadar(repositories, session.id, MINT_A);

    const result = await createRunner(repositories, {
      config: { sessionId: session.id },
    }).runOnce();

    expect(result).toMatchObject({
      sessionId: session.id,
      terminationReason: "TARGET_REACHED",
      trigger: "TARGET_REACHED",
      action: "observe",
      actionReason: "TARGET_ACTION_OBSERVE",
      positionsOpenBefore: 1,
      positionsOpenAfter: 1,
      positionsSelected: 0,
      positionsClosed: 0,
      sessionCompleted: false,
    });
    expect(repositories.positions.getPositionById(position.id)?.status).toBe("OPEN");
    assertNoSellWrites(repositories, session.id);
    expect(repositories.sessions.getSessionById(session.id)).toMatchObject({
      status: "RUNNING",
      terminationReason: "TARGET_REACHED",
    });
    expect(repositories.systemLogs.listLogs({ scope: "EXECUTION" }).length).toBeGreaterThan(0);
  });

  it("sells all target-reached positions when target action is sell-all", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, { terminationReason: "TARGET_REACHED" });
    const radar = createBoughtRadar(repositories, session.id, MINT_A);
    const position = createOpenPosition(repositories, session.id, MINT_A);

    const result = await createRunner(repositories, {
      config: {
        sessionId: session.id,
        targetAction: "sell-all",
      },
    }).runOnce();
    const orders = repositories.orders.listOrders(session.id);
    const fills = repositories.fills.listFillsForSession(session.id);
    const updatedSession = repositories.sessions.getSessionById(session.id);

    expect(result).toMatchObject({
      action: "sell-all",
      positionsOpenBefore: 1,
      positionsOpenAfter: 0,
      positionsSelected: 1,
      positionsClosed: 1,
      sellRejected: 0,
      sellFailures: 0,
      orderCreatedCount: 1,
      fillCreatedCount: 1,
      cashUpdatedCount: 1,
      radarStatusUpdatedCount: 1,
      totalNetProceedsLamports: NET_SELL_PROCEEDS_LAMPORTS,
      totalRealizedPnlLamports: REALIZED_PNL_LAMPORTS,
      sessionCompleted: false,
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]?.rawOrderJson).toContain("EXIT_MANAGER");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.rawQuoteJson).toContain("EXIT_MANAGER");
    expect(repositories.positions.getPositionById(position.id)?.status).toBe("CLOSED");
    expect(repositories.tokenRadar.getRadarEntryById(radar.id)?.status).toBe("WATCHING");
    expect(updatedSession).toMatchObject({
      status: "RUNNING",
      terminationReason: "TARGET_REACHED",
      currentCashLamports: STARTING_CASH_LAMPORTS + NET_SELL_PROCEEDS_LAMPORTS,
      realizedPnlLamports: REALIZED_PNL_LAMPORTS,
    });
  });

  it("dry-runs sell-all without orders, fills, position updates, session updates, TokenRadar updates, or DB logs", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, { terminationReason: "TARGET_REACHED" });
    const radar = createBoughtRadar(repositories, session.id, MINT_A);
    const position = createOpenPosition(repositories, session.id, MINT_A);

    const result = await createRunner(repositories, {
      config: {
        sessionId: session.id,
        targetAction: "sell-all",
        dryRun: true,
      },
    }).runOnce();

    expect(result).toMatchObject({
      action: "sell-all",
      positionsOpenBefore: 1,
      positionsOpenAfter: 1,
      positionsSelected: 1,
      positionsClosed: 0,
      orderCreatedCount: 0,
      fillCreatedCount: 0,
      cashUpdatedCount: 0,
      radarStatusUpdatedCount: 0,
      totalNetProceedsLamports: NET_SELL_PROCEEDS_LAMPORTS,
      dryRun: true,
      sessionCompleted: false,
      completionSkippedReason: "DRY_RUN",
    });
    expect(repositories.orders.listOrders(session.id)).toHaveLength(0);
    expect(repositories.fills.listFillsForSession(session.id)).toHaveLength(0);
    expect(repositories.positions.getPositionById(position.id)?.status).toBe("OPEN");
    expect(repositories.sessions.getSessionById(session.id)?.currentCashLamports).toBe(
      STARTING_CASH_LAMPORTS,
    );
    expect(repositories.tokenRadar.getRadarEntryById(radar.id)?.status).toBe("BOUGHT");
    expect(repositories.systemLogs.listLogs({ scope: "EXECUTION" })).toHaveLength(0);
  });

  it("sells all drawdown-gated positions and completes the session when enabled", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, { terminationReason: "MAX_DRAWDOWN" });

    createBoughtRadar(repositories, session.id, MINT_A);
    createOpenPosition(repositories, session.id, MINT_A);

    const result = await createRunner(repositories, {
      config: {
        sessionId: session.id,
        drawdownAction: "sell-all",
        completeSessionOnExit: true,
      },
    }).runOnce();
    const updatedSession = repositories.sessions.getSessionById(session.id);

    expect(result).toMatchObject({
      trigger: "MAX_DRAWDOWN",
      action: "sell-all",
      positionsClosed: 1,
      positionsOpenAfter: 0,
      sessionCompleted: true,
    });
    expect(updatedSession).toMatchObject({
      status: "COMPLETED",
      terminationReason: "MAX_DRAWDOWN",
    });
    expect(updatedSession?.endedAtMs).toBeTypeOf("number");
  });

  it("blocks completion when sell-all produces a rejection", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, { terminationReason: "MAX_DRAWDOWN" });

    createBoughtRadar(repositories, session.id, MINT_A);
    createOpenPosition(repositories, session.id, MINT_A);

    const result = await createRunner(repositories, {
      config: {
        sessionId: session.id,
        drawdownAction: "sell-all",
        completeSessionOnExit: true,
      },
      marketDataService: createMarketDataService({ failRefresh: true }),
    }).runOnce();

    expect(result).toMatchObject({
      sellRejected: 0,
      sellFailures: 1,
      positionsClosed: 0,
      positionsOpenAfter: 1,
      sessionCompleted: false,
      completionSkippedReason: "SELL_FAILURES_REMAIN",
    });
    expect(repositories.sessions.getSessionById(session.id)).toMatchObject({
      status: "RUNNING",
      terminationReason: "MAX_DRAWDOWN",
    });
  });

  it("completes a gated session with no open positions only when completion is enabled", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, { terminationReason: "TARGET_REACHED" });

    const result = await createRunner(repositories, {
      config: {
        sessionId: session.id,
        targetAction: "sell-all",
        completeSessionOnExit: true,
      },
    }).runOnce();

    expect(result).toMatchObject({
      positionsOpenBefore: 0,
      positionsSelected: 0,
      positionsClosed: 0,
      sessionCompleted: true,
    });
    expect(repositories.fills.listFillsForSession(session.id)).toHaveLength(0);
    expect(repositories.sessions.getSessionById(session.id)?.status).toBe("COMPLETED");
  });

  it("prefers the latest gated running paper session with open positions when session id is omitted", async () => {
    const repositories = setupRepositories();
    const older = createSession(repositories, {
      id: "session_exit_older",
      startedAtMs: now.getTime() - 60_000,
      terminationReason: "TARGET_REACHED",
    });
    const newer = createSession(repositories, {
      id: "session_exit_newer",
      startedAtMs: now.getTime(),
      terminationReason: "MAX_DRAWDOWN",
    });

    createBoughtRadar(repositories, older.id, MINT_A);
    createOpenPosition(repositories, older.id, MINT_A);

    const result = await createRunner(repositories, {
      config: {
        targetAction: "sell-all",
        drawdownAction: "sell-all",
      },
    }).runOnce();

    expect(result.sessionId).toBe(older.id);
    expect(repositories.sessions.getSessionById(newer.id)?.status).toBe("RUNNING");
  });

  it("rejects explicit ungated and completed sessions before writes", async () => {
    const repositories = setupRepositories();
    const ungated = createSession(repositories, {
      id: "session_ungated",
      terminationReason: "NOT_TERMINATED",
    });
    const completed = createSession(repositories, {
      id: "session_completed",
      status: "COMPLETED",
      terminationReason: "TARGET_REACHED",
    });

    await expect(
      createRunner(repositories, { config: { sessionId: ungated.id } }).runOnce(),
    ).rejects.toThrow(/SESSION_NOT_GATED/);
    await expect(
      createRunner(repositories, { config: { sessionId: completed.id } }).runOnce(),
    ).rejects.toThrow(/SESSION_NOT_RUNNING/);
    expect(repositories.systemLogs.listLogs({ scope: "EXECUTION" })).toHaveLength(0);
  });
});

function setupRepositories(): Repositories {
  testDb = createTestDatabase();
  return createRepositories(testDb.context.db);
}

function createRunner(
  repositories: Repositories,
  options: {
    readonly config?: Partial<ExitManagerRuntimeConfig>;
    readonly marketDataService?: Pick<MarketDataService, "enrichToken">;
  } = {},
): ExitManagerRunner {
  return new ExitManagerRunner({
    repositories,
    config: {
      ...defaultExitManagerConfig(),
      once: true,
      ...options.config,
    },
    marketDataService:
      options.marketDataService ??
      createMarketDataService({ quoteOutputLamports: GROSS_SELL_PROCEEDS_LAMPORTS }),
  });
}

function createSession(
  repositories: Repositories,
  overrides: Partial<Parameters<Repositories["sessions"]["createSession"]>[0]> = {},
): SessionRecord {
  return repositories.sessions.createSession({
    id: "session_exit",
    mode: "PAPER",
    status: "RUNNING",
    startedAtMs: now.getTime(),
    startingBalanceLamports: 1_000_000_000,
    currentCashLamports: STARTING_CASH_LAMPORTS,
    terminationReason: "TARGET_REACHED",
    configSnapshotJson: stringifyJson({ test: true }),
    ...overrides,
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
    symbol: "EXIT",
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
) {
  return repositories.positions.openPosition({
    id: `pos_${mintAddress.slice(0, 6)}`,
    sessionId,
    mintAddress,
    status: "OPEN",
    openedAtMs: now.getTime() - 30_000,
    avgEntryPriceSol: "0.001",
    tokensHeld: "10",
    costBasisLamports: 10_100_000,
    feesPaidLamports: 5_000,
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

function assertNoSellWrites(repositories: Repositories, sessionId: string): void {
  expect(repositories.orders.listOrders(sessionId)).toHaveLength(0);
  expect(repositories.fills.listFillsForSession(sessionId)).toHaveLength(0);
  expect(repositories.positions.listClosedPositions(sessionId)).toHaveLength(0);
}
