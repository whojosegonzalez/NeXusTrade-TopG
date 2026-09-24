import { afterEach, describe, expect, it } from "vitest";

import type { TestDatabaseContext } from "../db/testing/createTestDatabase.js";
import { createTestDatabase } from "../db/testing/createTestDatabase.js";
import { createRepositories, type Repositories } from "../db/repositories/index.js";
import type { SessionStatus, TokenRadarStatus } from "../db/schema/index.js";
import { stringifyJson } from "../db/utils/json.js";
import { defaultStrategyConfig } from "./StrategyConfig.js";
import { StrategyCandidateSelector } from "./StrategyCandidateSelector.js";

const nowMs = new Date("2026-06-21T12:00:00.000Z").getTime();
let testDb: TestDatabaseContext | undefined;

describe("StrategyCandidateSelector", () => {
  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("uses the latest RUNNING PAPER session with eligible strategy candidates", () => {
    const repositories = setupRepositories();
    const older = createSession(repositories, "older", nowMs - 10_000);
    const latest = createSession(repositories, "latest", nowMs);

    const olderRadar = createRadar(repositories, older.id, "WATCHING", nowMs, "OldMint");
    createRisk(repositories, older.id, olderRadar.id, olderRadar.mintAddress);
    const latestRadar = createRadar(repositories, latest.id, "WATCHING", nowMs, "NewMint");
    createRisk(repositories, latest.id, latestRadar.id, latestRadar.mintAddress);

    const selection = new StrategyCandidateSelector(repositories).selectCandidates(
      defaultStrategyConfig(),
      nowMs,
    );

    expect(selection.session.id).toBe(latest.id);
    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0]?.latestRiskAssessment.result).toBe("PASS");
  });

  it("requires explicit sessions to be PAPER and RUNNING", () => {
    const repositories = setupRepositories();
    const completed = createSession(repositories, "completed", nowMs, "COMPLETED");

    expect(() =>
      new StrategyCandidateSelector(repositories).selectCandidates(
        {
          ...defaultStrategyConfig(),
          sessionId: completed.id,
        },
        nowMs,
      ),
    ).toThrow(/RUNNING/);
  });

  it("does not auto-create a session when no eligible strategy candidates exist", () => {
    const repositories = setupRepositories();

    createSession(repositories, "empty", nowMs);

    expect(() =>
      new StrategyCandidateSelector(repositories).selectCandidates(defaultStrategyConfig(), nowMs),
    ).toThrow(/No RUNNING PAPER session/);
    expect(repositories.sessions.listSessions()).toHaveLength(1);
  });

  it("filters candidates by status, recency, limit, and latest risk availability", () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, "session", nowMs);
    const recent = createRadar(repositories, session.id, "WATCHING", nowMs, "RecentMint");
    const rejected = createRadar(repositories, session.id, "REJECTED", nowMs, "RejectMint");
    const old = createRadar(
      repositories,
      session.id,
      "WATCHING",
      nowMs - 48 * 60 * 60 * 1000,
      "OldMint",
    );

    createRadar(repositories, session.id, "WATCHING", nowMs, "MissingRiskMint");
    createRisk(repositories, session.id, recent.id, recent.mintAddress);
    createRisk(repositories, session.id, rejected.id, rejected.mintAddress);
    createRisk(repositories, session.id, old.id, old.mintAddress);

    const selection = new StrategyCandidateSelector(repositories).selectCandidates(
      {
        ...defaultStrategyConfig(),
        limit: 10,
      },
      nowMs,
    );

    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0]?.tokenRadar.id).toBe(recent.id);
    expect(selection.missingRiskAssessmentCount).toBe(1);
  });
});

function setupRepositories(): Repositories {
  testDb = createTestDatabase();
  return createRepositories(testDb.context.db);
}

function createSession(
  repositories: Repositories,
  suffix: string,
  startedAtMs: number,
  status: SessionStatus = "RUNNING",
) {
  return repositories.sessions.createSession({
    id: `session_${suffix}`,
    mode: "PAPER",
    status,
    startedAtMs,
    startingBalanceLamports: 0,
    currentCashLamports: 0,
    configSnapshotJson: "{}",
  });
}

function createRadar(
  repositories: Repositories,
  sessionId: string,
  status: TokenRadarStatus,
  discoveredAtMs: number,
  suffix: string,
) {
  return repositories.tokenRadar.createRadarEntry({
    sessionId,
    mintAddress: `${suffix}111111111111111111111111111111111111`.slice(0, 44),
    source: "DEXSCREENER",
    firstSeenAtMs: discoveredAtMs,
    discoveredAtMs,
    status,
  });
}

function createRisk(
  repositories: Repositories,
  sessionId: string,
  tokenRadarId: string,
  mintAddress: string,
) {
  return repositories.riskAssessments.createRiskAssessment({
    sessionId,
    tokenRadarId,
    mintAddress,
    checkedAtMs: nowMs,
    score: 95,
    result: "PASS",
    passed: true,
    liquidityUsd: "60000",
    riskFlagsJson: stringifyJson([]),
    rawProviderDataJson: stringifyJson({
      scoring: {
        facts: {
          maxPriceImpactPct: 1,
        },
      },
    }),
  });
}
