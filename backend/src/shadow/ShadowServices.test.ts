import { afterEach, describe, expect, it } from "vitest";
import { parseTokenMintAddress } from "@nexustrade/shared";

import type { Repositories } from "../db/repositories/index.js";
import type { WatchlistReturnObservationRecord } from "../db/schema/index.js";
import { createRepositories } from "../db/repositories/index.js";
import type { TestDatabaseContext } from "../db/testing/createTestDatabase.js";
import { createTestDatabase } from "../db/testing/createTestDatabase.js";
import { stringifyJson } from "../db/utils/json.js";
import { defaultShadowConfig } from "./ShadowConfig.js";
import { ShadowCandidateSelector } from "./ShadowCandidateSelector.js";
import { ShadowExitReportService } from "./ShadowExitReportService.js";
import { ShadowExitSimulator } from "./ShadowExitSimulator.js";
import { ShadowPortfolioSimulator } from "./ShadowPortfolioSimulator.js";
import { toWatchlistConfig } from "./ShadowObservationRunner.js";
import type { ShadowCandidate, ShadowCandidateResult } from "./ShadowTypes.js";

const mintAddress = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const now = 1_800_000_000_000;
let testDb: TestDatabaseContext | undefined;

describe("ShadowCandidateSelector", () => {
  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("selects BUY decisions by default", () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createRadar(repositories, session.id);

    createDecision(repositories, session.id, radar.id, { decision: "BUY", score: 65 });
    createDecision(repositories, session.id, radar.id, { decision: "SKIP", score: 55 });

    const selection = new ShadowCandidateSelector({
      config: {
        ...defaultShadowConfig(),
        sessionId: session.id,
      },
      repositories,
      clock: () => now,
    }).select();

    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0]?.decision.decision).toBe("BUY");
  });

  it("selects score-qualified SKIP decisions when shadow scores are enabled", () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createRadar(repositories, session.id);

    createDecision(repositories, session.id, radar.id, { decision: "BUY", score: 65 });
    createDecision(repositories, session.id, radar.id, { decision: "SKIP", score: 55 });
    createDecision(repositories, session.id, radar.id, { decision: "SKIP", score: 45 });

    const selection = new ShadowCandidateSelector({
      config: {
        ...defaultShadowConfig(),
        sessionId: session.id,
        includeShadowScores: true,
        shadowScoreMin: 55,
      },
      repositories,
      clock: () => now,
    }).select();

    expect(selection.candidates.map((candidate) => candidate.decision.score).sort()).toEqual([
      55, 65,
    ]);
  });
});

describe("ShadowObservationRunner adapter", () => {
  it("maps shadow score mode to watchlist source decisions and min score", () => {
    const config = toWatchlistConfig({
      ...defaultShadowConfig(),
      includeShadowScores: true,
      shadowScoreMin: 50,
      horizonsMinutes: [1, 2, 3],
    });

    expect(config.sourceDecisions).toEqual(["BUY", "WATCH", "SKIP"]);
    expect(config.minScore).toBe(50);
    expect(config.horizonsMinutes).toEqual([1, 2, 3]);
  });
});

describe("ShadowExitSimulator", () => {
  it("detects fast target exits before later drawdown", () => {
    const candidate = shadowCandidate("BUY", 65);
    const result = new ShadowExitSimulator().simulate({
      config: {
        ...defaultShadowConfig(),
        targetPcts: [10],
        stopPcts: [10],
        maxHoldMinutes: 60,
        maxHoldScenariosMinutes: [60],
      },
      candidates: [candidate],
      observationsByDecisionId: new Map([
        [candidate.decision.id, [observation(3, 21), observation(15, -6), observation(30, -20)]],
      ]),
    });

    expect(result.candidates[0]?.outcomes[0]).toMatchObject({
      exitReason: "TARGET_HIT",
      exitReturnPct: 10,
      exitHorizonMinutes: 3,
    });
  });

  it("detects stop exits before later recovery", () => {
    const candidate = shadowCandidate("BUY", 65);
    const result = new ShadowExitSimulator().simulate({
      config: {
        ...defaultShadowConfig(),
        targetPcts: [10],
        stopPcts: [10],
        maxHoldMinutes: 60,
        maxHoldScenariosMinutes: [60],
      },
      candidates: [candidate],
      observationsByDecisionId: new Map([
        [candidate.decision.id, [observation(3, -44), observation(60, 20)]],
      ]),
    });

    expect(result.candidates[0]?.outcomes[0]).toMatchObject({
      exitReason: "STOP_HIT",
      exitReturnPct: -10,
      exitHorizonMinutes: 3,
    });
  });
});

describe("ShadowPortfolioSimulator", () => {
  it("applies simulated wins and losses against a SOL balance", () => {
    const portfolio = new ShadowPortfolioSimulator().simulate({
      config: {
        ...defaultShadowConfig(),
        targetPcts: [10],
        stopPcts: [10],
        maxHoldMinutes: 60,
        maxHoldScenariosMinutes: [60],
        startingBalanceSol: 1,
        positionSizeSol: 0.01,
      },
      candidates: [candidateResult("decision_win", 10), candidateResult("decision_loss", -10)],
    });

    expect(portfolio.trades).toHaveLength(2);
    expect(portfolio.pnlSol).toBeCloseTo(0);
    expect(portfolio.endingBalanceSol).toBeCloseTo(1);
  });
});

describe("ShadowExitReportService safety", () => {
  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("generates reports without creating orders, fills, or positions", () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createRadar(repositories, session.id);
    const decision = createDecision(repositories, session.id, radar.id, {
      decision: "BUY",
      score: 65,
    });

    repositories.watchlistReturns.createObservation({
      sessionId: session.id,
      strategyDecisionId: decision.id,
      tokenRadarId: radar.id,
      mintAddress,
      decision: "BUY",
      strategyName: decision.strategyName,
      strategyScore: decision.score,
      horizonMinutes: 3,
      baselineObservedAtMs: decision.decidedAtMs,
      baselinePriceSol: "0.00001",
      baselineSource: "TEST",
      dueAtMs: decision.decidedAtMs + 3 * 60_000,
      status: "OBSERVED",
      observedAtMs: decision.decidedAtMs + 3 * 60_000,
      observedPriceSol: "0.000012",
      observedSource: "TEST",
      returnPctSol: "20",
    });

    const report = new ShadowExitReportService({
      config: {
        ...defaultShadowConfig(),
        sessionId: session.id,
        targetPcts: [10],
        stopPcts: [10],
        maxHoldScenariosMinutes: [60],
      },
      repositories,
      clock: () => now,
    }).generate();

    expect(report.selectedCount).toBe(1);
    expect(repositories.orders.listOrders(session.id)).toHaveLength(0);
    expect(repositories.fills.listFillsForSession(session.id)).toHaveLength(0);
    expect(repositories.positions.listOpenPositions(session.id)).toHaveLength(0);
    expect(repositories.positions.listClosedPositions(session.id)).toHaveLength(0);
  });
});

function setupRepositories(): Repositories {
  testDb = createTestDatabase();
  return createRepositories(testDb.context.db);
}

function createSession(repositories: Repositories) {
  return repositories.sessions.createSession({
    id: "session_shadow",
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
    id: `radar_${Math.random().toString(36).slice(2)}`,
    sessionId,
    mintAddress,
    symbol: "SOL",
    name: "Wrapped SOL",
    pairAddress: "pair_shadow",
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
  tokenRadarId: string,
  input: {
    readonly decision: "BUY" | "SKIP";
    readonly score: number;
  },
) {
  return repositories.strategyDecisions.createStrategyDecision({
    id: `decision_${input.decision}_${input.score}_${Math.random().toString(36).slice(2)}`,
    sessionId,
    mintAddress,
    decidedAtMs: now - 10 * 60_000,
    decision: input.decision,
    strategyName: "phase8_9_test",
    score: input.score,
    reason: "test decision",
    inputSnapshotJson: stringifyJson({
      tokenRadar: {
        id: tokenRadarId,
        mintAddress,
        symbol: "SOL",
        priceSol: "0.00001",
        priceUsd: "0.001",
        liquidityUsd: "100000",
        volume1hUsd: "10000",
        updatedAtMs: now - 10 * 60_000,
      },
      riskAssessment: {
        result: "WARN",
        riskFlags: ["MISSING_AUTHORITY_EVIDENCE"],
      },
      strategyScore: {
        factors: [],
      },
    }),
  });
}

function shadowCandidate(decision: "BUY" | "SKIP", score: number): ShadowCandidate {
  return {
    decision: {
      id: `decision_${decision}_${score}`,
      sessionId: "session_shadow",
      mintAddress,
      decidedAtMs: now,
      decision,
      strategyName: "test",
      score,
      reason: "test",
      inputSnapshotJson: null,
      createdAtMs: now,
    },
    symbol: "SOL",
    baselinePriceSol: "0.00001",
    selectionMode: decision === "BUY" ? "BUY" : "SHADOW_SCORE",
  };
}

function observation(horizonMinutes: number, returnPctSol: number) {
  return {
    status: "OBSERVED",
    horizonMinutes,
    returnPctSol: returnPctSol.toString(),
    returnPctUsd: null,
  } as WatchlistReturnObservationRecord;
}

function candidateResult(id: string, exitReturnPct: number): ShadowCandidateResult {
  return {
    strategyDecisionId: id,
    mintAddress,
    symbol: "SOL",
    decision: "BUY",
    score: 65,
    selectionMode: "BUY",
    observedReturns: [],
    outcomes: [
      {
        scenario: {
          targetPct: 10,
          stopPct: 10,
          maxHoldMinutes: 60,
        },
        exitReason: exitReturnPct >= 0 ? "TARGET_HIT" : "STOP_HIT",
        exitReturnPct,
        exitHorizonMinutes: 3,
      },
    ],
  };
}
