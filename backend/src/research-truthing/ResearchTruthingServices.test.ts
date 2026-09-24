import { describe, expect, it } from "vitest";

import type { ProviderHealthRecord, SystemLogRecord } from "../db/schema/index.js";
import { stringifyJson } from "../db/utils/json.js";
import type { ResearchArchiveMetadata } from "../research/ResearchAggregateTypes.js";
import { buildTargetStopOutcomes } from "../research-interpretation/ResearchInterpretationStats.js";
import type { ResearchInterpretationCandidate } from "../research-interpretation/ResearchInterpretationTypes.js";
import type { ShadowCalibrationRawRun } from "../shadow-calibration/ShadowCalibrationTypes.js";
import {
  createEmptyProviderPressureSummary,
  type ProviderPressureProviderSummary,
} from "../terminal-runner/TerminalRunSummary.js";
import { BirdeyeTruthService } from "./BirdeyeTruthService.js";
import { BlockerAuditService } from "./BlockerAuditService.js";
import { classifyProviderHealthForTruthing } from "./ProviderReclassificationService.js";
import { QuoteEvidenceTruthService } from "./QuoteEvidenceTruthService.js";
import { ReportLimitTruthService } from "./ReportLimitTruthService.js";
import { ScenarioPortfolioAuditService } from "./ScenarioPortfolioAuditService.js";

const now = 1_800_000_000_000;

describe("research truthing services", () => {
  it("reports truncation and omitted rows explicitly", () => {
    const limit = new ReportLimitTruthService().create({
      sectionName: "decisionTruthTable.rows",
      rowsAvailable: 100,
      rowsEvaluated: 100,
      rowsDisplayed: 25,
      displayLimit: 25,
      dedupeMode: "decision",
    });

    expect(limit).toMatchObject({
      displayTruncated: true,
      omittedDisplayRows: 75,
    });
  });

  it("classifies provider rows by policy, router, diagnostic, and live failure semantics", () => {
    expect(
      classifyProviderHealthForTruthing(
        providerHealth("BIRDEYE", "ERROR", {
          birdeyeFailureCategory: "BIRDEYE_CU_BUDGET_EXHAUSTED",
          birdeyeBudgetReason: "CU_BUDGET_EXHAUSTED",
        }),
      ),
    ).toBe("POLICY_BUDGET_SKIP");
    expect(
      classifyProviderHealthForTruthing(
        providerHealth("JUPITER", "DEGRADED", { quoteSource: "CACHE" }),
      ),
    ).toBe("ROUTER_CACHE_HIT");
    expect(
      classifyProviderHealthForTruthing(
        providerHealth("JUPITER", "RATE_LIMITED", { quoteSource: "SKIPPED_COOLDOWN" }),
      ),
    ).toBe("ROUTER_COOLDOWN_SKIP");
    expect(
      classifyProviderHealthForTruthing(
        providerHealth("RAYDIUM", "ERROR", { operation: "pool-preflight" }),
      ),
    ).toBe("DIAGNOSTIC_ONLY");
    expect(classifyProviderHealthForTruthing(providerHealth("RAYDIUM", "ERROR"))).toBe(
      "LIVE_PROVIDER_FAILURE",
    );
  });

  it("explains missing quote rows without inventing candidate-level quote attempts", () => {
    const summary = new QuoteEvidenceTruthService().summarize({
      archives: [archive()],
      candidates: [
        candidate({
          decisionId: "missing",
          decision: "SKIP",
          score: 65,
          missingQuote: true,
        }),
        candidate({
          decisionId: "impact",
          decision: "WATCH",
          score: 70,
          missingQuote: false,
          missingPriceImpact: true,
        }),
      ],
      limit: 10,
    });

    expect(summary.missingQuoteCount).toBe(1);
    expect(summary.insufficientArchiveEvidenceMissingQuoteCount).toBe(1);
    expect(summary.unclassifiedMissingQuoteCount).toBe(0);
    expect(summary.categoryCounts.INSUFFICIENT_ARCHIVE_EVIDENCE).toBe(1);
    expect(summary.categoryCounts.PRICE_IMPACT_MISSING).toBe(1);
    expect(summary.exampleRows.map((row) => row.missingQuoteCategory)).toEqual([
      "PRICE_IMPACT_MISSING",
      "INSUFFICIENT_ARCHIVE_EVIDENCE",
    ]);
  });

  it("uses run-level provider pressure only when it can classify the missing quote cause", () => {
    const summary = new QuoteEvidenceTruthService().summarize({
      archives: [
        archive({
          providers: [
            providerPressureProvider("JUPITER", {
              liveRateLimitedCount: 2,
              liveRateLimitedPercent: 100,
            }),
          ],
        }),
      ],
      candidates: [
        candidate({
          decisionId: "missing",
          decision: "SKIP",
          score: 65,
          missingQuote: true,
        }),
      ],
      limit: 10,
    });

    expect(summary.categoryCounts.PROVIDER_RATE_LIMITED).toBe(1);
    expect(summary.failureReasonCounts.PROVIDER_RATE_LIMITED).toBe(1);
    expect(summary.correlatedMissingQuoteCount).toBe(1);
  });

  it("classifies SKIP with blockers=none into score-only and unresolved strategy gates", () => {
    const audit = new BlockerAuditService().summarize({
      candidates: [
        candidate({ decisionId: "low", decision: "SKIP", score: 55 }),
        candidate({ decisionId: "high", decision: "SKIP", score: 75 }),
        candidate({ decisionId: "insufficient", decision: "SKIP", score: null, scoreFactors: [] }),
        candidate({
          decisionId: "blocked",
          decision: "SKIP",
          score: 70,
          blockingFactors: ["MISSING_QUOTE"],
        }),
      ],
      limit: 10,
    });

    expect(audit.skipWithNoBlockers).toBe(3);
    expect(audit.scoreThresholdOnly).toBe(1);
    expect(audit.unresolvedStrategyGate).toBe(1);
    expect(audit.insufficientArchiveEvidence).toBe(1);
    expect(audit.thresholdSourceCounts.CURRENT_DEFAULT).toBe(3);
  });

  it("uses archived strategy thresholds when a run provides them", () => {
    const audit = new BlockerAuditService().summarize({
      candidates: [candidate({ decisionId: "archived", decision: "SKIP", score: 68 })],
      limit: 10,
      thresholdsByRun: new Map([
        [
          "T1",
          {
            watchScoreThreshold: 60,
            buyScoreThreshold: 65,
            source: "ARCHIVED_SESSION",
          },
        ],
      ]),
    });

    expect(audit.scoreThresholdOnly).toBe(0);
    expect(audit.unresolvedStrategyGate).toBe(1);
    expect(audit.examples[0]).toMatchObject({
      thresholdSource: "ARCHIVED_SESSION",
      watchScoreThreshold: 60,
      buyScoreThreshold: 65,
    });
  });

  it("audits target and stop ordering separately per max-hold window", () => {
    const audit = new ScenarioPortfolioAuditService().summarize({
      candidates: [
        candidate({
          decisionId: "late_recovery",
          decision: "WATCH",
          score: 70,
          observedPoints: [
            { horizonMinutes: 3, returnPct: -12 },
            { horizonMinutes: 20, returnPct: 12 },
          ],
        }),
        candidate({
          decisionId: "late_target",
          decision: "WATCH",
          score: 70,
          observedPoints: [
            { horizonMinutes: 3, returnPct: 5 },
            { horizonMinutes: 20, returnPct: 12 },
          ],
        }),
      ],
      config: {
        targetPcts: [10],
        stopPcts: [10],
        maxHoldMinutes: [15, 30],
        topLimit: 10,
      },
    });

    expect(audit.rows).toEqual([
      expect.objectContaining({
        maxHoldMinutes: 15,
        targetFirstCount: 0,
        drawdownFirstCount: 1,
        neitherCount: 1,
      }),
      expect.objectContaining({
        maxHoldMinutes: 30,
        targetFirstCount: 1,
        drawdownFirstCount: 1,
        neitherCount: 0,
      }),
    ]);
  });

  it("attributes Birdeye budget skips separately from provider failures and recovers enriched mints", () => {
    const service = new BirdeyeTruthService();
    const summary = service.summarize({
      runs: [
        rawRun({
          providerHealth: [
            providerHealth("BIRDEYE", "OK", {
              birdeyeEndpoint: "/defi/price",
              birdeyeCacheStatus: "MISS",
              birdeyeFailureCategory: "NONE",
              birdeyeCuCost: 1,
              birdeyeCuUsed: 1,
              birdeyeSelectionReason: "WATCH_RISK_PASS",
            }),
            providerHealth("BIRDEYE", "DEGRADED", {
              birdeyeEndpoint: "/defi/token_overview",
              birdeyeCacheStatus: "HIT",
              birdeyeFailureCategory: "NONE",
              birdeyeCuCost: 30,
              birdeyeSelectionReason: "WATCH_RISK_PASS",
            }),
            providerHealth("BIRDEYE", "ERROR", {
              birdeyeEndpoint: "/defi/token_overview",
              birdeyeCacheStatus: "MISS",
              birdeyeFailureCategory: "BIRDEYE_CU_BUDGET_EXHAUSTED",
              birdeyeBudgetReason: "CU_BUDGET_EXHAUSTED",
              birdeyeSelectionReason: "HIGH_SCORE_SKIP",
            }),
          ],
          systemLogs: [
            systemLog("Birdeye selective candidate enriched.", {
              mintAddress: "mint_enriched",
              priceOk: true,
              overviewOk: false,
            }),
          ],
        }),
      ],
      candidates: [
        candidate({
          decisionId: "enriched",
          mintAddress: "mint_enriched",
          decision: "WATCH",
          score: 70,
          observedPoints: [{ horizonMinutes: 5, returnPct: 11 }],
        }),
        candidate({
          decisionId: "control",
          mintAddress: "mint_control",
          decision: "WATCH",
          score: 70,
        }),
      ],
    });

    expect(summary.totalRows).toBe(3);
    expect(summary.liveCalls).toBe(1);
    expect(summary.livePriceCalls).toBe(1);
    expect(summary.liveOverviewCalls).toBe(0);
    expect(summary.cacheHits).toBe(1);
    expect(summary.cachedOverviewRows).toBe(1);
    expect(summary.budgetSkipCount).toBe(1);
    expect(summary.budgetSkippedOverviewRows).toBe(1);
    expect(summary.estimatedCuTotal).toBe(1);
    expect(summary.reportedCumulativeCuByRun.T1).toBe(1);
    expect(summary.providerFailureCount).toBe(0);
    expect(summary.uniqueEnrichedMints).toBe(1);
    expect(summary.enrichedCohort.count).toBe(1);
    expect(summary.eligibleControlCohort.count).toBe(1);
    expect(summary.eligibleControlCohort.outcomeComparisonStatus).toBe("NOT_COMPARABLE");
    expect(summary.notes.join(" ")).toMatch(/guardrail skips/i);
  });
});

function candidate(
  overrides: Partial<ResearchInterpretationCandidate> & {
    readonly decisionId: string;
    readonly decision: ResearchInterpretationCandidate["decision"];
    readonly score: number | null;
    readonly observedPoints?: ResearchInterpretationCandidate["observedPoints"];
  },
): ResearchInterpretationCandidate {
  const observedPoints = overrides.observedPoints ?? [];
  const bestReturnPct =
    observedPoints.length > 0
      ? Math.max(...observedPoints.map((point) => point.returnPct))
      : undefined;
  const worstReturnPct =
    observedPoints.length > 0
      ? Math.min(...observedPoints.map((point) => point.returnPct))
      : undefined;
  const scoreFactors =
    overrides.scoreFactors ??
    (overrides.score === null
      ? []
      : [
          {
            ruleName: "test_factor",
            points: overrides.score,
            passed: true,
            warnings: [],
          },
        ]);

  return {
    runLabel: overrides.runLabel ?? "T1",
    decisionId: overrides.decisionId,
    mintAddress: overrides.mintAddress ?? "mint_a",
    ...(overrides.symbol ? { symbol: overrides.symbol } : {}),
    decidedAtMs: overrides.decidedAtMs ?? now,
    decision: overrides.decision,
    score: overrides.score,
    buyEligible: overrides.buyEligible ?? true,
    duplicateBuyBlocked: overrides.duplicateBuyBlocked ?? false,
    maxBuyCapBlocked: overrides.maxBuyCapBlocked ?? false,
    ...(overrides.riskResult ? { riskResult: overrides.riskResult } : {}),
    riskFlags: overrides.riskFlags ?? [],
    missingQuote: overrides.missingQuote ?? false,
    missingAuthorityEvidence: overrides.missingAuthorityEvidence ?? false,
    missingPriceImpact: overrides.missingPriceImpact ?? false,
    liquidityUsd: overrides.liquidityUsd ?? 10_000,
    volume5mUsd: overrides.volume5mUsd ?? 5_000,
    volume1hUsd: overrides.volume1hUsd ?? 50_000,
    ageSeconds: overrides.ageSeconds ?? 3_600,
    scoreFactors,
    blockingFactors: overrides.blockingFactors ?? [],
    observedPoints,
    ...(bestReturnPct !== undefined ? { bestReturnPct } : {}),
    ...(worstReturnPct !== undefined ? { worstReturnPct } : {}),
    targetStopOutcomes: buildTargetStopOutcomes({
      observedPoints,
      targetPcts: [10],
      stopPcts: [10],
      maxHoldMinutes: [15, 30],
    }),
    repeatedAttentionStrength: overrides.repeatedAttentionStrength ?? "NONE",
    repeatedAttentionReasons: overrides.repeatedAttentionReasons ?? [],
    repeatedAttentionSourceCount: overrides.repeatedAttentionSourceCount ?? 1,
    attribution: {
      storedScore: overrides.score,
      factorTotal: overrides.score ?? 0,
      factors: scoreFactors,
      buyEligible: overrides.buyEligible ?? true,
      duplicateBuyBlocked: overrides.duplicateBuyBlocked ?? false,
      maxBuyCapBlocked: overrides.maxBuyCapBlocked ?? false,
      ...(overrides.riskResult ? { riskResult: overrides.riskResult } : {}),
      riskFlags: overrides.riskFlags ?? [],
      liquidityUsd: overrides.liquidityUsd ?? 10_000,
      volume5mUsd: overrides.volume5mUsd ?? 5_000,
      volume1hUsd: overrides.volume1hUsd ?? 50_000,
      ageSeconds: overrides.ageSeconds ?? 3_600,
      missingQuote: overrides.missingQuote ?? false,
      missingAuthorityEvidence: overrides.missingAuthorityEvidence ?? false,
      missingPriceImpact: overrides.missingPriceImpact ?? false,
      blockingFactors: overrides.blockingFactors ?? [],
    },
  };
}

function archive(
  overrides: Partial<ResearchArchiveMetadata["terminalSummary"]["providerPressure"]> = {},
): ResearchArchiveMetadata {
  return {
    label: "T1",
    inputPath: "data/archive/test",
    resolvedPath: "data/archive/test",
    databasePath: "data/archive/test/nexus_paper.db",
    runnerJsonPath: "data/archive/test/terminal.json",
    terminalSummary: {
      runId: "run_test",
      sessionId: "session_test",
      mode: "PAPER",
      shadowOnly: true,
      safetyStatus: "PASS",
      startedAtMs: now,
      endedAtMs: now + 1,
      durationMs: 1,
      intervalMs: 60_000,
      cycleCount: 1,
      cycles: [],
      providerPressure: {
        ...createEmptyProviderPressureSummary(),
        ...overrides,
      },
      stopped: false,
    },
    warnings: [],
  };
}

function providerPressureProvider(
  provider: string,
  overrides: Partial<ProviderPressureProviderSummary> = {},
): ProviderPressureProviderSummary {
  return {
    provider,
    total: 0,
    statusCounts: {
      OK: 0,
      DEGRADED: 0,
      RATE_LIMITED: 0,
      ERROR: 0,
      DISABLED: 0,
    },
    rateLimitedCount: 0,
    degradedCount: 0,
    errorCount: 0,
    liveRows: 0,
    routerRows: 0,
    liveRateLimitedCount: 0,
    liveErrorCount: 0,
    liveRateLimitedPercent: 0,
    liveErrorPercent: 0,
    routerCacheHits: 0,
    routerCooldownSkips: 0,
    routerUnavailable: 0,
    routerCooldownSkipPercent: 0,
    combinedRateLimitedPercent: 0,
    quoteSourceTypeCounts: {},
    quoteFallbackReasonCounts: {},
    authorityEvidenceSourceCounts: {},
    mintAuthorityStateCounts: {},
    freezeAuthorityStateCounts: {},
    rpcCacheStatusCounts: {},
    rpcFailureCategoryCounts: {},
    dasProviderCounts: {},
    dasFailureCategoryCounts: {},
    raydiumFailureCategoryCounts: {},
    raydiumPreflightStatusCounts: {},
    heliusEvidenceSourceCounts: {},
    heliusCacheStatusCounts: {},
    birdeyeEndpointCounts: {},
    birdeyeCacheStatusCounts: {},
    birdeyeFailureCategoryCounts: {},
    birdeyeSelectionReasonCounts: {},
    birdeyeBudgetReasonCounts: {},
    ...overrides,
  };
}

function rawRun(overrides: Partial<ShadowCalibrationRawRun> = {}): ShadowCalibrationRawRun {
  return {
    label: "T1",
    path: "data/archive/test",
    sourceKind: "database",
    warnings: [],
    strategyDecisions: [],
    watchlistReturns: [],
    riskAssessments: [],
    tokenRadar: [],
    providerHealth: [],
    systemLogs: [],
    orderCount: 0,
    fillCount: 0,
    positionCount: 0,
    ...overrides,
  };
}

function providerHealth(
  provider: string,
  status: ProviderHealthRecord["status"],
  context?: Readonly<Record<string, unknown>>,
): ProviderHealthRecord {
  return {
    id: `${provider}_${status}_${context?.quoteSource ?? context?.operation ?? "row"}`,
    sessionId: null,
    provider,
    timestampMs: now,
    status,
    latencyMs: 10,
    rateLimited: status === "RATE_LIMITED",
    errorMessage: null,
    creditsUsed: null,
    contextJson: context ? stringifyJson(context) : null,
  };
}

function systemLog(message: string, context: Readonly<Record<string, unknown>>): SystemLogRecord {
  return {
    id: `log_${message}`,
    sessionId: null,
    timestampMs: now,
    level: "INFO",
    scope: "PROVIDER",
    message,
    contextJson: stringifyJson(context),
  };
}
