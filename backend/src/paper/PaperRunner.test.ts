import { afterEach, describe, expect, it } from "vitest";

import type { TestDatabaseContext } from "../db/testing/createTestDatabase.js";
import { createTestDatabase } from "../db/testing/createTestDatabase.js";
import { createRepositories, type Repositories } from "../db/repositories/index.js";
import { positionSnapshots } from "../db/schema/index.js";
import type { TokenRadarRecord } from "../db/schema/index.js";
import { stringifyJson } from "../db/utils/json.js";
import {
  defaultPaperExchangeConfig,
  type PaperExchangeRuntimeConfig,
} from "./PaperExchangeConfig.js";
import { PaperRunner } from "./PaperRunner.js";

const now = new Date("2026-06-21T13:00:00.000Z");
const STARTING_CASH_LAMPORTS = 1_000_000_000;
const DEFAULT_TOTAL_COST_LAMPORTS = 10_105_000;
let testDb: TestDatabaseContext | undefined;

describe("PaperRunner", () => {
  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("creates a paper order, fill, position, cash update, and TokenRadar BOUGHT transition", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createApprovedRadar(repositories, session.id, "BUY");
    const decision = createBuyDecision(repositories, session.id, radar);

    createRisk(repositories, session.id, radar);

    const result = await createRunner(repositories).runOnce();
    const orders = repositories.orders.listOrders(session.id);
    const fills = repositories.fills.listFillsForSession(session.id);
    const positions = repositories.positions.listOpenPositions(session.id);
    const updatedSession = repositories.sessions.getSessionById(session.id);
    const updatedRadar = repositories.tokenRadar.getRadarEntryById(radar.id);

    expect(result).toMatchObject({
      selectedCount: 1,
      evaluatedCount: 1,
      executedCount: 1,
      rejectedCount: 0,
      failedCount: 0,
      orderCreatedCount: 1,
      fillCreatedCount: 1,
      openedPositionCount: 1,
      cashUpdatedCount: 1,
      radarStatusUpdatedCount: 1,
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      side: "BUY",
      status: "FILLED",
      requestedSolLamports: 10_000_000,
      quoteSource: "TOKEN_RADAR_PRICE",
      strategyDecisionId: decision.id,
    });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      orderId: orders[0]?.id,
      fillPriceSol: "0.001",
      fillPriceUsd: "0.2",
      tokensFilled: "10",
      solSpentLamports: 10_000_000,
      estimatedBaseFeeLamports: 5_000,
      estimatedPriorityFeeLamports: 0,
      estimatedSlippageLamports: 100_000,
      priceImpactBps: 123,
      quoteSource: "TOKEN_RADAR_PRICE",
    });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      mintAddress: radar.mintAddress,
      status: "OPEN",
      avgEntryPriceSol: "0.001",
      tokensHeld: "10",
      costBasisLamports: 10_100_000,
      feesPaidLamports: 5_000,
    });
    expect(updatedSession?.currentCashLamports).toBe(
      STARTING_CASH_LAMPORTS - DEFAULT_TOTAL_COST_LAMPORTS,
    );
    expect(updatedRadar?.status).toBe("BOUGHT");
    expect(updatedRadar?.notes).toContain("Paper BUY filled.");
    expect(repositories.systemLogs.listLogs({ scope: "EXECUTION" }).length).toBeGreaterThan(0);
    assertPaperSafetyBoundaries(repositories, session.id);
  });

  it("simulates execution but skips writes in dry-run mode", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createApprovedRadar(repositories, session.id, "DRY");

    createBuyDecision(repositories, session.id, radar);
    createRisk(repositories, session.id, radar);

    const result = await createRunner(repositories, { dryRun: true }).runOnce();

    expect(result).toMatchObject({
      selectedCount: 1,
      executedCount: 1,
      orderCreatedCount: 0,
      fillCreatedCount: 0,
      openedPositionCount: 0,
      cashUpdatedCount: 0,
      radarStatusUpdatedCount: 0,
    });
    expect(repositories.orders.listOrders(session.id)).toHaveLength(0);
    expect(repositories.fills.listFillsForSession(session.id)).toHaveLength(0);
    expect(repositories.positions.listOpenPositions(session.id)).toHaveLength(0);
    expect(repositories.sessions.getSessionById(session.id)?.currentCashLamports).toBe(
      STARTING_CASH_LAMPORTS,
    );
    expect(repositories.tokenRadar.getRadarEntryById(radar.id)?.status).toBe("APPROVED");
  });

  it("leaves missing TokenRadar price retryable without accounting or radar writes", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createApprovedRadar(repositories, session.id, "NOPRICE", {
      priceSol: null,
    });

    createBuyDecision(repositories, session.id, radar);
    createRisk(repositories, session.id, radar);

    const result = await createRunner(repositories).runOnce();
    const orders = repositories.orders.listOrders(session.id);

    expect(result).toMatchObject({
      selectedCount: 1,
      rejectedCount: 0,
      failedCount: 1,
      orderCreatedCount: 0,
      fillCreatedCount: 0,
      openedPositionCount: 0,
      cashUpdatedCount: 0,
    });
    expect(orders).toHaveLength(0);
    expect(repositories.operations.listOperations(session.id)[0]?.state).toBe("PENDING");
    expectNoExecutionSideEffects(repositories, session.id, radar.id);
  });

  it("rejects insufficient cash without fill, position, cash, or radar status updates", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, { currentCashLamports: 1000 });
    const radar = createApprovedRadar(repositories, session.id, "CASH");

    createBuyDecision(repositories, session.id, radar);
    createRisk(repositories, session.id, radar);

    const result = await createRunner(repositories).runOnce();
    const orders = repositories.orders.listOrders(session.id);

    expect(result).toMatchObject({
      rejectedCount: 1,
      insufficientCashRejectedCount: 1,
      orderCreatedCount: 1,
      fillCreatedCount: 0,
      openedPositionCount: 0,
      cashUpdatedCount: 0,
    });
    expect(orders[0]).toMatchObject({
      status: "REJECTED",
      reason: "INSUFFICIENT_CASH",
    });
    expectNoExecutionSideEffects(repositories, session.id, radar.id, 1000);
  });

  it("rejects duplicate open positions without creating fills or cash updates", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createApprovedRadar(repositories, session.id, "DUP");

    createBuyDecision(repositories, session.id, radar);
    createRisk(repositories, session.id, radar);
    repositories.positions.openPosition({
      sessionId: session.id,
      mintAddress: radar.mintAddress,
      status: "OPEN",
      openedAtMs: now.getTime() - 1,
      avgEntryPriceSol: "0.001",
      tokensHeld: "1",
      costBasisLamports: 1000,
      feesPaidLamports: 0,
    });

    const result = await createRunner(repositories).runOnce();
    const orders = repositories.orders.listOrders(session.id);

    expect(result).toMatchObject({
      rejectedCount: 1,
      duplicatePositionRejectedCount: 1,
      orderCreatedCount: 1,
      fillCreatedCount: 0,
      openedPositionCount: 0,
      cashUpdatedCount: 0,
    });
    expect(orders[0]).toMatchObject({
      status: "REJECTED",
      reason: "OPEN_POSITION_EXISTS",
    });
    expect(repositories.positions.listOpenPositions(session.id)).toHaveLength(1);
    expect(repositories.sessions.getSessionById(session.id)?.currentCashLamports).toBe(
      STARTING_CASH_LAMPORTS,
    );
    expect(repositories.tokenRadar.getRadarEntryById(radar.id)?.status).toBe("APPROVED");
  });

  it("requires explicit sessions to be PAPER and RUNNING", async () => {
    const repositories = setupRepositories();
    const session = repositories.sessions.createSession({
      id: "session_created",
      mode: "PAPER",
      status: "CREATED",
      startedAtMs: now.getTime(),
      startingBalanceLamports: STARTING_CASH_LAMPORTS,
      currentCashLamports: STARTING_CASH_LAMPORTS,
      configSnapshotJson: "{}",
    });

    await expect(createRunner(repositories, { sessionId: session.id }).runOnce()).rejects.toThrow(
      /RUNNING/,
    );
  });

  it("rejects explicit sessions gated by SessionManager termination reason", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, { terminationReason: "TARGET_REACHED" });
    const radar = createApprovedRadar(repositories, session.id, "GATED");

    createBuyDecision(repositories, session.id, radar);
    createRisk(repositories, session.id, radar);

    await expect(createRunner(repositories, { sessionId: session.id }).runOnce()).rejects.toThrow(
      /SESSION_BUY_GATED/,
    );
    expect(repositories.orders.listOrders(session.id)).toHaveLength(0);
    expect(repositories.fills.listFillsForSession(session.id)).toHaveLength(0);
    expect(repositories.positions.listOpenPositions(session.id)).toHaveLength(0);
  });

  it("skips gated running sessions when selecting implicit paper BUY candidates", async () => {
    const repositories = setupRepositories();
    const gatedSession = createSession(repositories, {
      id: "session_gated_latest",
      startedAtMs: now.getTime() + 1_000,
      terminationReason: "MAX_DRAWDOWN",
    });
    const ungatedSession = createSession(repositories, {
      id: "session_ungated_older",
      startedAtMs: now.getTime(),
    });
    const gatedRadar = createApprovedRadar(repositories, gatedSession.id, "GATED2");
    const ungatedRadar = createApprovedRadar(repositories, ungatedSession.id, "OPEN");

    createBuyDecision(repositories, gatedSession.id, gatedRadar);
    createRisk(repositories, gatedSession.id, gatedRadar);
    createBuyDecision(repositories, ungatedSession.id, ungatedRadar);
    createRisk(repositories, ungatedSession.id, ungatedRadar);

    const result = await createRunner(repositories).runOnce();

    expect(result.sessionId).toBe(ungatedSession.id);
    expect(repositories.orders.listOrders(gatedSession.id)).toHaveLength(0);
    expect(repositories.orders.listOrders(ungatedSession.id)).toHaveLength(1);
  });
});

function setupRepositories(): Repositories {
  testDb = createTestDatabase();
  return createRepositories(testDb.context.db);
}

function createRunner(
  repositories: Repositories,
  config: Partial<PaperExchangeRuntimeConfig> = {},
): PaperRunner {
  return new PaperRunner({
    repositories,
    config: {
      ...defaultPaperExchangeConfig(),
      once: true,
      ...config,
    },
  });
}

function createSession(
  repositories: Repositories,
  overrides: Partial<Parameters<Repositories["sessions"]["createSession"]>[0]> = {},
) {
  return repositories.sessions.createSession({
    id: "session_paper",
    mode: "PAPER",
    status: "RUNNING",
    startedAtMs: now.getTime(),
    startingBalanceLamports: STARTING_CASH_LAMPORTS,
    currentCashLamports: STARTING_CASH_LAMPORTS,
    configSnapshotJson: "{}",
    ...overrides,
  });
}

function createApprovedRadar(
  repositories: Repositories,
  sessionId: string,
  suffix: string,
  overrides: Partial<Parameters<Repositories["tokenRadar"]["createRadarEntry"]>[0]> = {},
) {
  return repositories.tokenRadar.createRadarEntry({
    sessionId,
    mintAddress: `Mint${suffix}111111111111111111111111111111111111`.slice(0, 44),
    symbol: suffix,
    source: "DEXSCREENER",
    firstSeenAtMs: now.getTime() - 48 * 60 * 60 * 1000,
    discoveredAtMs: now.getTime(),
    priceSol: "0.001",
    priceUsd: "0.2",
    liquidityUsd: "60000",
    volume1hUsd: "80000",
    ageSeconds: 48 * 60 * 60,
    status: "APPROVED",
    notes: "strategy note",
    ...overrides,
  });
}

function createBuyDecision(repositories: Repositories, sessionId: string, radar: TokenRadarRecord) {
  return repositories.strategyDecisions.createStrategyDecision({
    sessionId,
    mintAddress: radar.mintAddress,
    decidedAtMs: now.getTime(),
    decision: "BUY",
    strategyName: "phase6_first_pass",
    score: 95,
    reason: "BUY: test candidate",
    inputSnapshotJson: "{}",
  });
}

function createRisk(repositories: Repositories, sessionId: string, radar: TokenRadarRecord) {
  return repositories.riskAssessments.createRiskAssessment({
    sessionId,
    tokenRadarId: radar.id,
    mintAddress: radar.mintAddress,
    checkedAtMs: now.getTime(),
    score: 95,
    result: "PASS",
    passed: true,
    liquidityUsd: "60000",
    riskFlagsJson: stringifyJson([]),
    rawProviderDataJson: stringifyJson({
      scoring: {
        facts: {
          maxPriceImpactPct: 1.23,
        },
      },
    }),
  });
}

function expectNoExecutionSideEffects(
  repositories: Repositories,
  sessionId: string,
  radarId: string,
  expectedCashLamports = STARTING_CASH_LAMPORTS,
): void {
  expect(repositories.fills.listFillsForSession(sessionId)).toHaveLength(0);
  expect(repositories.positions.listOpenPositions(sessionId)).toHaveLength(0);
  expect(repositories.sessions.getSessionById(sessionId)?.currentCashLamports).toBe(
    expectedCashLamports,
  );
  expect(repositories.tokenRadar.getRadarEntryById(radarId)?.status).toBe("APPROVED");
}

function assertPaperSafetyBoundaries(repositories: Repositories, sessionId: string): void {
  expect(repositories.positions.listClosedPositions(sessionId)).toHaveLength(0);
  expect(repositories.snapshots.listEquitySnapshots(sessionId)).toHaveLength(0);
  expect(testDb?.context.db.select().from(positionSnapshots).all()).toHaveLength(0);
}
