import { describe, expect, it } from "vitest";

import { createEmptyProviderPressureSummary } from "../terminal-runner/TerminalRunSummary.js";
import type { ResearchArchiveMetadata } from "../research/ResearchAggregateTypes.js";
import { BlockerAnalysisService } from "./BlockerAnalysisService.js";
import { DecisionAttributionService } from "./DecisionAttributionService.js";
import { MarketWindowAnalysisService } from "./MarketWindowAnalysisService.js";
import { OpportunityAnalysisService } from "./OpportunityAnalysisService.js";
import { ProviderInterpretationService } from "./ProviderInterpretationService.js";
import { buildTargetStopOutcomes } from "./ResearchInterpretationStats.js";
import type { ResearchInterpretationCandidate } from "./ResearchInterpretationTypes.js";

const now = 1_800_000_000_000;

describe("DecisionAttributionService", () => {
  it("classifies missing quote and unresolved SKIP blockers explicitly", () => {
    const service = new DecisionAttributionService();

    const missingQuote = service.explain({
      candidate: candidate({
        decisionId: "missing_quote",
        decision: "SKIP",
        score: 65,
        missingQuote: true,
        riskResult: "WARN",
      }),
      buyScoreThreshold: 65,
      watchScoreThreshold: 60,
    });
    const unresolved = service.explain({
      candidate: candidate({
        decisionId: "unresolved",
        decision: "SKIP",
        score: 70,
      }),
      buyScoreThreshold: 65,
      watchScoreThreshold: 60,
    });
    const scoreOnly = service.explain({
      candidate: candidate({
        decisionId: "score_only",
        decision: "SKIP",
        score: 55,
      }),
      buyScoreThreshold: 65,
      watchScoreThreshold: 60,
    });

    expect(missingQuote.firstBlockingFactor).toBe("RISK_NOT_PASS");
    expect(missingQuote.blockerCategories).toContain("MISSING_QUOTE");
    expect(unresolved.firstBlockingFactor).toBe("UNRESOLVED_STRATEGY_GATE");
    expect(scoreOnly.firstBlockingFactor).toBe("SCORE_BELOW_WATCH");
  });
});

describe("research interpretation services", () => {
  it("summarizes blockers, high-scoring SKIPs, market windows, and quote groups", () => {
    const candidates = [
      candidate({
        decisionId: "skip_1",
        decision: "SKIP",
        score: 70,
        missingQuote: true,
        riskResult: "WARN",
        observedReturns: [
          { horizonMinutes: 3, returnPct: 12 },
          { horizonMinutes: 10, returnPct: -4 },
        ],
      }),
      candidate({
        decisionId: "skip_2",
        mintAddress: "mint_b",
        symbol: "BETA",
        decision: "SKIP",
        score: 66,
        observedReturns: [
          { horizonMinutes: 3, returnPct: -11 },
          { horizonMinutes: 10, returnPct: 20 },
        ],
      }),
      candidate({
        decisionId: "buy_1",
        mintAddress: "mint_c",
        symbol: "GAMMA",
        decision: "BUY",
        score: 75,
        observedReturns: [{ horizonMinutes: 5, returnPct: 15 }],
      }),
    ];
    const attributionService = new DecisionAttributionService();
    const attributions = candidates.map((item) =>
      attributionService.explain({
        candidate: item,
        buyScoreThreshold: 65,
        watchScoreThreshold: 60,
      }),
    );

    const blockers = new BlockerAnalysisService().summarize({
      candidates,
      attributions,
      targetPcts: [10],
      stopPcts: [10],
      limit: 10,
    });
    const opportunities = new OpportunityAnalysisService().highScoringSkips({
      candidates,
      attributions,
      minScore: 65,
      limit: 10,
    });
    const windows = new MarketWindowAnalysisService().summarize({
      candidates,
      marketWindowMinutes: 60,
      limit: 10,
    });
    const provider = new ProviderInterpretationService().summarize({
      archives: [archive()],
      candidates,
      targetPcts: [10],
      stopPcts: [10],
    });

    expect(blockers.map((row) => row.blocker)).toContain("RISK_NOT_PASS");
    expect(opportunities.map((row) => row.decisionId)).toEqual(["skip_2", "skip_1"]);
    expect(windows[0]).toMatchObject({
      decisionCount: 3,
      uniqueMints: 3,
      targetFirstWins: 2,
    });
    expect(provider.missingQuote.count).toBe(1);
    expect(provider.quoteAvailable.count).toBe(2);
  });
});

function candidate(
  overrides: Partial<ResearchInterpretationCandidate> & {
    readonly decisionId: string;
    readonly decision: ResearchInterpretationCandidate["decision"];
    readonly score: number;
    readonly observedReturns?: ResearchInterpretationCandidate["observedPoints"];
  },
): ResearchInterpretationCandidate {
  const observedPoints = overrides.observedReturns ?? [];
  const bestReturnPct =
    observedPoints.length > 0
      ? Math.max(...observedPoints.map((point) => point.returnPct))
      : undefined;
  const worstReturnPct =
    observedPoints.length > 0
      ? Math.min(...observedPoints.map((point) => point.returnPct))
      : undefined;

  return {
    runLabel: "T1",
    decisionId: overrides.decisionId,
    mintAddress: overrides.mintAddress ?? "mint_a",
    symbol: overrides.symbol ?? "ALPHA",
    decidedAtMs: now,
    decision: overrides.decision,
    score: overrides.score,
    buyEligible: true,
    duplicateBuyBlocked: overrides.duplicateBuyBlocked ?? false,
    maxBuyCapBlocked: overrides.maxBuyCapBlocked ?? false,
    ...(overrides.riskResult ? { riskResult: overrides.riskResult } : {}),
    riskFlags: overrides.riskFlags ?? (overrides.missingQuote ? ["MISSING_QUOTE"] : []),
    missingQuote: overrides.missingQuote ?? false,
    missingAuthorityEvidence: overrides.missingAuthorityEvidence ?? false,
    missingPriceImpact: overrides.missingPriceImpact ?? false,
    liquidityUsd: 10_000,
    volume1hUsd: 25_000,
    ageSeconds: 3_600,
    scoreFactors: overrides.scoreFactors ?? [
      {
        ruleName: "test_factor",
        points: overrides.score,
        passed: true,
        warnings: [],
      },
    ],
    blockingFactors: overrides.blockingFactors ?? [],
    observedPoints,
    ...(bestReturnPct !== undefined ? { bestReturnPct } : {}),
    ...(worstReturnPct !== undefined ? { worstReturnPct } : {}),
    targetStopOutcomes: buildTargetStopOutcomes({
      observedPoints,
      targetPcts: [10],
      stopPcts: [10],
      maxHoldMinutes: [60],
    }),
    repeatedAttentionStrength: "NONE",
    repeatedAttentionReasons: [],
    repeatedAttentionSourceCount: 1,
    attribution: {
      storedScore: overrides.score,
      factorTotal: overrides.score,
      factors: overrides.scoreFactors ?? [
        {
          ruleName: "test_factor",
          points: overrides.score,
          passed: true,
          warnings: [],
        },
      ],
      buyEligible: true,
      duplicateBuyBlocked: overrides.duplicateBuyBlocked ?? false,
      maxBuyCapBlocked: overrides.maxBuyCapBlocked ?? false,
      ...(overrides.riskResult ? { riskResult: overrides.riskResult } : {}),
      riskFlags: overrides.riskFlags ?? (overrides.missingQuote ? ["MISSING_QUOTE"] : []),
      symbol: overrides.symbol ?? "ALPHA",
      liquidityUsd: 10_000,
      volume1hUsd: 25_000,
      ageSeconds: 3_600,
      missingQuote: overrides.missingQuote ?? false,
      missingAuthorityEvidence: overrides.missingAuthorityEvidence ?? false,
      missingPriceImpact: overrides.missingPriceImpact ?? false,
      blockingFactors: overrides.blockingFactors ?? [],
    },
  };
}

function archive(): ResearchArchiveMetadata {
  return {
    label: "T1",
    inputPath: "data/archive/test",
    resolvedPath: "data/archive/test",
    databasePath: "data/archive/test/nexus_paper.db",
    runnerJsonPath: "data/archive/test/runner.json",
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
      providerPressure: createEmptyProviderPressureSummary(),
      stopped: false,
    },
    warnings: [],
  };
}
