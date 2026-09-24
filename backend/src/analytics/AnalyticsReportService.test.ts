import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Repositories } from "../db/repositories/index.js";
import { createRepositories } from "../db/repositories/index.js";
import type { TestDatabaseContext } from "../db/testing/createTestDatabase.js";
import { createTestDatabase } from "../db/testing/createTestDatabase.js";
import { stringifyJson } from "../db/utils/json.js";
import { defaultAnalyticsConfig } from "./AnalyticsConfig.js";
import { guardAnalyticsReads } from "./h4/H4ReadGuard.js";
import { formatAnalyticsReport } from "./AnalyticsReportFormatter.js";
import { AnalyticsReportService } from "./AnalyticsReportService.js";

const now = 1_800_000_000_000;
const mintAddress = "So11111111111111111111111111111111111111112";
let testDb: TestDatabaseContext | undefined;

describe("AnalyticsReportService", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    testDb?.cleanup();
    testDb = undefined;
  });

  it("reports funnel counts, score buckets, near misses, provider health, and missed opportunities", () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = createRadar(repositories, session.id);

    repositories.riskAssessments.createRiskAssessment({
      sessionId: session.id,
      tokenRadarId: radar.id,
      mintAddress,
      checkedAtMs: now,
      score: 80,
      result: "WARN",
      passed: false,
      liquidityUsd: "100000",
      riskFlagsJson: stringifyJson(["MISSING_QUOTE"]),
      rawProviderDataJson: stringifyJson({
        enrichment: { buyQuote: { source: "JUPITER" } },
        quoteBudget: {
          selected: true,
          selectionReason: "SELECTED",
          rank: 1,
          candidateSignals: ["recent_discovery", "liquidity_at_or_above_risk_floor"],
        },
      }),
    });
    const decision = repositories.strategyDecisions.createStrategyDecision({
      sessionId: session.id,
      mintAddress,
      decidedAtMs: now,
      decision: "WATCH",
      strategyName: "phase8_7_test",
      score: 80,
      reason: "WATCH: score=80 risk=WARN",
      inputSnapshotJson: stringifyJson({
        tokenRadar: {
          id: radar.id,
          mintAddress,
          symbol: "SOL",
          liquidityUsd: "100000",
          volume1hUsd: "50000",
          ageSeconds: 3600,
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

    repositories.providerHealth.createProviderHealth({
      provider: "JUPITER",
      status: "RATE_LIMITED",
      rateLimited: true,
      errorMessage: "rate limited",
      contextJson: stringifyJson({ operation: "quote" }),
      timestampMs: now,
    });
    repositories.watchlistReturns.createObservation({
      sessionId: session.id,
      strategyDecisionId: decision.id,
      tokenRadarId: radar.id,
      mintAddress,
      symbol: "SOL",
      decision: "WATCH",
      strategyName: "phase8_7_test",
      strategyScore: 80,
      horizonMinutes: 60,
      baselineObservedAtMs: now,
      baselinePriceSol: "0.00001",
      baselineSource: "STRATEGY_SNAPSHOT",
      dueAtMs: now + 60 * 60_000,
      observedAtMs: now + 60 * 60_000,
      observedPriceSol: "0.000012",
      observedSource: "DEXSCREENER",
      returnPctSol: "20",
      status: "OBSERVED",
    });

    const beforeCounts = countRows(repositories, session.id);
    const reads = guardAnalyticsReads(repositories);
    const report = new AnalyticsReportService({
      repositories: reads.repositories,
      config: {
        ...defaultAnalyticsConfig(),
        sessionId: session.id,
        nearMissMinScore: 50,
      },
      clock: () => now,
    }).generate();
    const afterCounts = countRows(repositories, session.id);

    expect(report.funnel.tokenRadarTotal).toBe(1);
    expect(report.funnel.riskByResult.WARN).toBe(1);
    expect(report.quoteBudget).toMatchObject({
      assessmentsWithPlan: 1,
      selectedCount: 1,
      notSelectedCount: 0,
      quoteSuccessCount: 1,
    });
    expect(report.funnel.strategyByDecision.WATCH).toBe(1);
    expect(report.scoreBuckets).toEqual([
      {
        bucket: "80-84",
        total: 1,
        buyCount: 0,
        watchCount: 1,
        skipCount: 0,
      },
    ]);
    expect(report.nearMisses).toHaveLength(1);
    expect(report.providerHealth.some((provider) => provider.provider === "JUPITER")).toBe(true);
    expect(report.jupiterRateLimitSummary?.statusCounts.RATE_LIMITED).toBe(1);
    expect(report.missedOpportunities).toHaveLength(1);
    expect(report.missedOpportunities[0]?.bestReturnPct).toBe("20");
    expect(afterCounts).toEqual(beforeCounts);
    expect(reads.calls.map((call) => call.method)).toEqual([
      "getSessionById",
      "listRadarEntries",
      "listRiskAssessments",
      "listStrategyDecisions",
      "listOrders",
      "listFillsForSession",
      "listOpenPositions",
      "listClosedPositions",
      "listEquitySnapshots",
      "listObservations",
      "listProviderHealth",
    ]);
    expect(reads.calls[1]?.args).toEqual([session.id, { limit: 10_000 }]);
    expect(reads.calls.at(-1)?.args).toEqual([
      { fromMs: now - 24 * 60 * 60 * 1000, limit: 10_000 },
    ]);
    expect(report).toMatchSnapshot();
    expect(formatAnalyticsReport(report)).toMatchSnapshot();
  });

  it("selects the latest populated PAPER session and preserves empty aggregates", () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    createRadar(repositories, session.id);
    repositories.sessions.createSession({
      id: "newer_empty",
      mode: "PAPER",
      status: "RUNNING",
      startedAtMs: now,
      startingBalanceLamports: 0,
      currentCashLamports: 0,
      configSnapshotJson: "{}",
    });
    const reads = guardAnalyticsReads(repositories);
    const report = new AnalyticsReportService({
      repositories: reads.repositories,
      config: defaultAnalyticsConfig(),
      clock: () => now,
    }).generate();
    expect(report.session.id).toBe(session.id);
    expect(report.generatedAtMs).toBe(now);
    expect(report.scoreBuckets).toEqual([]);
    expect(report.nearMisses).toEqual([]);
    expect(report.quoteBudget.assessmentsWithPlan).toBe(0);
    expect(reads.calls.slice(0, 5).map(({ method, args }) => ({ method, args }))).toEqual([
      { method: "listSessions", args: [{ mode: "PAPER", limit: 100 }] },
      { method: "listRadarEntries", args: ["newer_empty", { limit: 1 }] },
      { method: "listStrategyDecisions", args: ["newer_empty", { limit: 1 }] },
      { method: "listRadarEntries", args: [session.id, { limit: 1 }] },
      { method: "listStrategyDecisions", args: [session.id, { limit: 1 }] },
    ]);
  });

  it("fails clearly when no paper session has rows", () => {
    const repositories = setupRepositories();

    expect(() =>
      new AnalyticsReportService({
        repositories: guardAnalyticsReads(repositories).repositories,
        config: defaultAnalyticsConfig(),
        clock: () => now,
      }).generate(),
    ).toThrow(/No PAPER session/);
  });
});

function setupRepositories(): Repositories {
  testDb = createTestDatabase();
  return createRepositories(testDb.context.db);
}

function createSession(repositories: Repositories) {
  return repositories.sessions.createSession({
    id: "session_analytics",
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
    id: "radar_analytics",
    sessionId,
    mintAddress,
    symbol: "SOL",
    source: "DEXSCREENER",
    firstSeenAtMs: now - 60 * 60_000,
    discoveredAtMs: now - 30 * 60_000,
    priceSol: "0.00001",
    priceUsd: "0.001",
    liquidityUsd: "100000",
    volume1hUsd: "50000",
    ageSeconds: 3600,
    status: "WATCHING",
  });
}

function countRows(repositories: Repositories, sessionId: string) {
  return {
    tokenRadar: repositories.tokenRadar.listRadarEntries(sessionId).length,
    risk: repositories.riskAssessments.listRiskAssessments(sessionId).length,
    strategy: repositories.strategyDecisions.listStrategyDecisions(sessionId).length,
    returns: repositories.watchlistReturns.listObservations(sessionId).length,
    providerHealth: repositories.providerHealth.listProviderHealth({ limit: 1000 }).length,
  };
}
