import { afterEach, describe, expect, it } from "vitest";

import type { TestDatabaseContext } from "../db/testing/createTestDatabase.js";
import { createTestDatabase } from "../db/testing/createTestDatabase.js";
import { createRepositories, type Repositories } from "../db/repositories/index.js";
import { positionSnapshots } from "../db/schema/index.js";
import type { TokenRadarRecord } from "../db/schema/index.js";
import { stringifyJson } from "../db/utils/json.js";
import { defaultStrategyConfig, type StrategyRuntimeConfig } from "./StrategyConfig.js";
import { StrategyRunner } from "./StrategyRunner.js";

const now = new Date();
let testDb: TestDatabaseContext | undefined;

describe("StrategyRunner", () => {
  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("writes BUY StrategyDecision records, updates TokenRadar to APPROVED, and creates no execution records", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createRadar(repositories, session.id, "BUY");

    createRisk(repositories, session.id, radar);

    const result = await createRunner(repositories).runOnce();
    const decisions = repositories.strategyDecisions.listStrategyDecisions(session.id);
    const updatedRadar = repositories.tokenRadar.getRadarEntryById(radar.id);

    expect(result).toMatchObject({
      selectedCount: 1,
      evaluatedCount: 1,
      writtenCount: 1,
      statusUpdatedCount: 1,
      buyCount: 1,
      errorCount: 0,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe("BUY");
    expect(updatedRadar?.status).toBe("APPROVED");
    expect(updatedRadar?.notes).toContain("Strategy BUY");
    expect(repositories.systemLogs.listLogs({ scope: "STRATEGY" }).length).toBeGreaterThan(0);
    assertStrategySafetyBoundaries(repositories, session.id);
  });

  it("writes WATCH and SKIP decisions without unsafe TokenRadar updates", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const watchRadar = createRadar(repositories, session.id, "WATCH");
    const skipRadar = createRadar(repositories, session.id, "SKIP");

    createRisk(repositories, session.id, watchRadar, {
      result: "WARN",
      score: 70,
      passed: false,
      riskFlagsJson: stringifyJson(["MISSING_AUTHORITY_EVIDENCE", "MISSING_QUOTE"]),
      rawProviderDataJson: stringifyJson({
        scoring: {
          facts: {
            pairAgeSeconds: 48 * 60 * 60,
          },
        },
      }),
    });
    createRisk(repositories, session.id, skipRadar, {
      result: "FAIL",
      score: 20,
      passed: false,
      riskFlagsJson: stringifyJson(["LOW_LIQUIDITY"]),
      liquidityUsd: "100",
    });

    const result = await createRunner(repositories).runOnce();
    const decisions = repositories.strategyDecisions.listStrategyDecisions(session.id);

    expect(result.watchCount).toBe(1);
    expect(result.skipCount).toBe(1);
    expect(decisions.map((decision) => decision.decision).sort()).toEqual(["SKIP", "WATCH"]);
    expect(repositories.tokenRadar.getRadarEntryById(watchRadar.id)?.status).toBe("WATCHING");
    expect(repositories.tokenRadar.getRadarEntryById(skipRadar.id)?.status).toBe("WATCHING");
    assertStrategySafetyBoundaries(repositories, session.id);
  });

  it("skips StrategyDecision and TokenRadar writes in dry-run mode", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createRadar(repositories, session.id, "DRY");

    createRisk(repositories, session.id, radar);

    const result = await createRunner(repositories, { dryRun: true }).runOnce();

    expect(result.buyCount).toBe(1);
    expect(result.writtenCount).toBe(0);
    expect(result.statusUpdatedCount).toBe(0);
    expect(repositories.strategyDecisions.listStrategyDecisions(session.id)).toHaveLength(0);
    expect(repositories.tokenRadar.getRadarEntryById(radar.id)?.status).toBe("WATCHING");
    assertStrategySafetyBoundaries(repositories, session.id);
  });

  it("prevents duplicate BUY decisions per session and mint", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createRadar(repositories, session.id, "DUP");

    createRisk(repositories, session.id, radar);
    repositories.strategyDecisions.createStrategyDecision({
      sessionId: session.id,
      mintAddress: radar.mintAddress,
      decidedAtMs: now.getTime() - 1,
      decision: "BUY",
      strategyName: "phase6_first_pass",
      score: 100,
      reason: "previous buy",
      inputSnapshotJson: "{}",
    });

    const result = await createRunner(repositories).runOnce();
    const decisions = repositories.strategyDecisions.listDecisionsForMint(
      session.id,
      radar.mintAddress,
    );

    expect(result).toMatchObject({
      buyCount: 0,
      watchCount: 1,
      duplicateBuyBlockedCount: 1,
    });
    expect(decisions.filter((decision) => decision.decision === "BUY")).toHaveLength(1);
    expect(decisions[0]?.decision).toBe("WATCH");
    expect(repositories.tokenRadar.getRadarEntryById(radar.id)?.status).toBe("WATCHING");
  });

  it("enforces max BUY decisions per run", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const first = createRadar(repositories, session.id, "CAP1");
    const second = createRadar(repositories, session.id, "CAP2");

    createRisk(repositories, session.id, first);
    createRisk(repositories, session.id, second);

    const result = await createRunner(repositories, { maxBuyDecisions: 1 }).runOnce();
    const decisions = repositories.strategyDecisions.listStrategyDecisions(session.id);

    expect(result).toMatchObject({
      buyCount: 1,
      watchCount: 1,
      maxBuyCapBlockedCount: 1,
    });
    expect(decisions.map((decision) => decision.decision).sort()).toEqual(["BUY", "WATCH"]);
    expect(
      repositories.tokenRadar.listRadarEntries(session.id, { status: "APPROVED" }),
    ).toHaveLength(1);
  });
});

function setupRepositories(): Repositories {
  testDb = createTestDatabase();
  return createRepositories(testDb.context.db);
}

function createSession(repositories: Repositories) {
  return repositories.sessions.createSession({
    id: "session_strategy",
    mode: "PAPER",
    status: "RUNNING",
    startedAtMs: now.getTime(),
    startingBalanceLamports: 0,
    currentCashLamports: 0,
    configSnapshotJson: "{}",
  });
}

function createRunner(
  repositories: Repositories,
  config: Partial<StrategyRuntimeConfig> = {},
): StrategyRunner {
  return new StrategyRunner({
    repositories,
    config: {
      ...defaultStrategyConfig(),
      once: true,
      ...config,
    },
  });
}

function createRadar(repositories: Repositories, sessionId: string, suffix: string) {
  return repositories.tokenRadar.createRadarEntry({
    sessionId,
    mintAddress: `Mint${suffix}111111111111111111111111111111111111`.slice(0, 44),
    symbol: suffix,
    source: "DEXSCREENER",
    firstSeenAtMs: now.getTime() - 48 * 60 * 60 * 1000,
    discoveredAtMs: now.getTime(),
    liquidityUsd: "60000",
    volume1hUsd: "80000",
    ageSeconds: 48 * 60 * 60,
    status: "WATCHING",
    notes: "scanner note",
  });
}

function createRisk(
  repositories: Repositories,
  sessionId: string,
  radar: TokenRadarRecord,
  overrides: Partial<Parameters<Repositories["riskAssessments"]["createRiskAssessment"]>[0]> = {},
) {
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
          pairAgeSeconds: 48 * 60 * 60,
          maxPriceImpactPct: 1,
        },
      },
    }),
    ...overrides,
  });
}

function assertStrategySafetyBoundaries(repositories: Repositories, sessionId: string): void {
  expect(repositories.orders.listOrders(sessionId)).toHaveLength(0);
  expect(repositories.fills.listFillsForSession(sessionId)).toHaveLength(0);
  expect(repositories.positions.listOpenPositions(sessionId)).toHaveLength(0);
  expect(repositories.positions.listClosedPositions(sessionId)).toHaveLength(0);
  expect(repositories.snapshots.listEquitySnapshots(sessionId)).toHaveLength(0);
  expect(testDb?.context.db.select().from(positionSnapshots).all()).toHaveLength(0);
}
