import { describe, expect, it } from "vitest";

import type {
  ProviderHealthRecord,
  SessionRecord,
  StrategyDecisionRecord,
  WatchlistReturnObservationRecord,
} from "../db/schema/index.js";
import { defaultShadowCalibrationConfig } from "./ShadowCalibrationConfig.js";
import { ShadowCalibrationReportService } from "./ShadowCalibrationReportService.js";
import type { ShadowCalibrationRawRun } from "./ShadowCalibrationTypes.js";

const now = 1_800_000_000_000;

describe("ShadowCalibrationReportService", () => {
  it("summarizes decision-level, unique-mint, scenario, and confirmation outcomes", () => {
    const decisions = [
      decision("decision_buy", "mint_a", "BUY", 65, 1, {
        duplicateBuyBlocked: false,
        missingQuote: false,
      }),
      decision("decision_watch", "mint_a", "WATCH", 60, 2, {
        duplicateBuyBlocked: false,
        missingQuote: true,
      }),
      decision("decision_skip", "mint_b", "SKIP", 55, 3, {
        duplicateBuyBlocked: true,
        missingQuote: false,
      }),
    ];
    const report = new ShadowCalibrationReportService({
      config: {
        ...defaultShadowCalibrationConfig(),
        targetPcts: [10],
        stopPcts: [10],
        maxHoldMinutes: [15],
        confirmationHorizonsMinutes: [1],
        confirmationMinReturnPcts: [0],
        confirmationMaxDrawdownPcts: [5],
        minScore: 50,
      },
      runs: [
        rawRun("RunA", {
          strategyDecisions: decisions,
          watchlistReturns: [
            observation("decision_buy", "mint_a", "BUY", 1, 5),
            observation("decision_buy", "mint_a", "BUY", 3, 12),
            observation("decision_buy", "mint_a", "BUY", 15, 20),
            observation("decision_watch", "mint_a", "WATCH", 1, -2),
            observation("decision_watch", "mint_a", "WATCH", 3, 25),
            observation("decision_skip", "mint_b", "SKIP", 1, -6),
            observation("decision_skip", "mint_b", "SKIP", 3, -12),
            observation("decision_skip", "mint_b", "SKIP", 15, 20),
          ],
          providerHealth: [
            providerHealth("JUPITER", "RATE_LIMITED"),
            providerHealth("JUPITER", "OK"),
          ],
        }),
      ],
      clock: () => now,
    }).generate();

    expect(report.aggregate).toMatchObject({
      databaseRunCount: 1,
      observedDecisionCount: 3,
      uniqueMintCount: 2,
      orderCount: 0,
      fillCount: 0,
      positionCount: 0,
    });

    expect(findOutcome(report.decisionOutcomes, "ALL", "ALL_DECISIONS")).toMatchObject({
      count: 3,
      uniqueMints: 2,
      targetHitRates: {
        "10": 100,
      },
    });
    expect(
      findOutcome(report.decisionOutcomes, "ALL", "ALL_DECISIONS")?.drawdownFirstRates["10"],
    ).toBeCloseTo(33.3333);

    expect(findOutcome(report.uniqueMintOutcomes, "ALL", "ALL_DECISIONS")).toMatchObject({
      count: 3,
      uniqueMints: 2,
      dedupeMode: "decision",
    });

    expect(report.scenarioPortfolioGrid[0]).toMatchObject({
      label: "RunA",
      targetPct: 10,
      stopPct: 10,
      maxHoldMinutes: 15,
      evaluatedCount: 3,
      targetHitCount: 2,
      stopHitCount: 1,
    });

    expect(report.confirmationResults[0]).toMatchObject({
      label: "RunA",
      horizonMinutes: 1,
      confirmedCount: 1,
      rejectedCount: 2,
      targetHitCount: 1,
      missedWinnersCausedByWaiting: 2,
    });

    expect(
      report.filterAnalysis.find(
        (row) =>
          row.label === "RunA" && row.filterName === "quote" && row.bucket === "missing_quote",
      ),
    ).toMatchObject({
      count: 1,
    });

    expect(report.recommendations.map((item) => item.category)).toContain("phase_boundary");
  });

  it("collapses duplicate mints when configured", () => {
    const report = new ShadowCalibrationReportService({
      config: {
        ...defaultShadowCalibrationConfig(),
        targetPcts: [10],
        stopPcts: [10],
        maxHoldMinutes: [15],
        dedupeMode: "mint_best_entry",
      },
      runs: [
        rawRun("RunA", {
          strategyDecisions: [
            decision("decision_low", "mint_a", "WATCH", 60, 1, {}),
            decision("decision_high", "mint_a", "WATCH", 60, 2, {}),
          ],
          watchlistReturns: [
            observation("decision_low", "mint_a", "WATCH", 3, 5),
            observation("decision_high", "mint_a", "WATCH", 3, 30),
          ],
        }),
      ],
      clock: () => now,
    }).generate();

    const unique = findOutcome(report.uniqueMintOutcomes, "ALL", "ALL_DECISIONS");

    expect(unique).toMatchObject({
      count: 1,
      uniqueMints: 1,
      dedupeMode: "mint_best_entry",
      targetHitRates: {
        "10": 100,
      },
    });
  });

  it("includes report-only archive sources without pretending full metrics exist", () => {
    const report = new ShadowCalibrationReportService({
      config: defaultShadowCalibrationConfig(),
      runs: [
        {
          label: "ReportOnly",
          path: "data/archive/phase8.9/test1",
          sourceKind: "report-only",
          warnings: ["No archived database was found for ReportOnly."],
          strategyDecisions: [],
          watchlistReturns: [],
          riskAssessments: [],
          tokenRadar: [],
          providerHealth: [],
          systemLogs: [],
          orderCount: 0,
          fillCount: 0,
          positionCount: 0,
          reportOnlySummary: {
            radarRows: 10,
            strategyRows: 5,
            observedReturnRows: 20,
            providerHealthRows: 3,
          },
        },
      ],
      clock: () => now,
    }).generate();

    expect(report.aggregate.reportOnlyRunCount).toBe(1);
    expect(report.runs[0]).toMatchObject({
      label: "ReportOnly",
      sourceKind: "report-only",
      tokenRadarRows: 10,
      strategyRows: 5,
      observedReturnRows: 20,
      providerHealthRows: 3,
    });
    expect(report.decisionOutcomes).toHaveLength(0);
  });
});

function rawRun(
  label: string,
  input: {
    readonly strategyDecisions?: readonly StrategyDecisionRecord[];
    readonly watchlistReturns?: readonly WatchlistReturnObservationRecord[];
    readonly providerHealth?: readonly ProviderHealthRecord[];
  },
): ShadowCalibrationRawRun {
  return {
    label,
    path: `data/${label}/nexus_paper.db`,
    sourceKind: "database",
    warnings: [],
    session: sessionRecord(`session_${label}`),
    strategyDecisions: input.strategyDecisions ?? [],
    watchlistReturns: input.watchlistReturns ?? [],
    riskAssessments: [],
    tokenRadar: [],
    providerHealth: input.providerHealth ?? [],
    systemLogs: [],
    orderCount: 0,
    fillCount: 0,
    positionCount: 0,
  };
}

function sessionRecord(id: string): SessionRecord {
  return {
    id,
    mode: "PAPER",
    status: "RUNNING",
    startedAtMs: now - 60 * 60_000,
    endedAtMs: null,
    startingBalanceLamports: 0,
    currentCashLamports: 0,
    targetProfitLamports: null,
    targetProfitBps: null,
    maxDrawdownLamports: null,
    realizedPnlLamports: 0,
    unrealizedPnlLamports: 0,
    terminationReason: "NOT_TERMINATED",
    configSnapshotJson: "{}",
    createdAtMs: now - 60 * 60_000,
    updatedAtMs: now - 60 * 60_000,
  };
}

function decision(
  id: string,
  mintAddress: string,
  decisionValue: StrategyDecisionRecord["decision"],
  score: number,
  order: number,
  options: {
    readonly duplicateBuyBlocked?: boolean;
    readonly missingQuote?: boolean;
  },
): StrategyDecisionRecord {
  return {
    id,
    sessionId: "session_test",
    mintAddress,
    decidedAtMs: now + order,
    decision: decisionValue,
    strategyName: "phase8_91_test",
    score,
    reason: "test decision",
    inputSnapshotJson: JSON.stringify({
      tokenRadar: {
        symbol: mintAddress.toUpperCase(),
        liquidityUsd: "10000",
        volume1hUsd: "50000",
        ageSeconds: 3600,
      },
      riskAssessment: {
        result: "PASS",
        riskFlags: options.missingQuote ? ["MISSING_QUOTE"] : [],
      },
      strategyScore: {
        buyEligible: true,
        duplicateBuyBlocked: options.duplicateBuyBlocked ?? false,
        maxBuyCapBlocked: false,
        factors: [
          {
            ruleName: "test_factor",
            points: score,
            passed: true,
            reason: "test",
            warnings: [],
          },
        ],
      },
    }),
    createdAtMs: now + order,
  };
}

function observation(
  strategyDecisionId: string,
  mintAddress: string,
  decisionValue: StrategyDecisionRecord["decision"],
  horizonMinutes: number,
  returnPct: number,
): WatchlistReturnObservationRecord {
  return {
    id: `${strategyDecisionId}_${horizonMinutes}`,
    sessionId: "session_test",
    strategyDecisionId,
    mintAddress,
    decision: decisionValue,
    strategyName: "phase8_91_test",
    horizonMinutes,
    baselineObservedAtMs: now,
    baselineSource: "TEST",
    dueAtMs: now + horizonMinutes * 60_000,
    status: "OBSERVED",
    returnPctSol: returnPct.toString(),
    returnPctUsd: null,
    createdAtMs: now,
    updatedAtMs: now,
  } as WatchlistReturnObservationRecord;
}

function providerHealth(
  provider: string,
  status: ProviderHealthRecord["status"],
): ProviderHealthRecord {
  return {
    provider,
    status,
  } as ProviderHealthRecord;
}

function findOutcome<
  T extends {
    readonly label: string;
    readonly group: string;
  },
>(rows: readonly T[], label: string, group: string): T | undefined {
  return rows.find((row) => row.label === label && row.group === group);
}
