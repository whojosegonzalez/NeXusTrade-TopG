import { describe, expect, it } from "vitest";

import type { ShadowEntryReport } from "../shadow-entry/ShadowEntryTypes.js";
import { defaultResearchAggregateConfig } from "./ResearchAggregateConfig.js";
import { PromotionGateService } from "./PromotionGateService.js";
import type { ResearchCrossRunSummary, ResearchRunValidation } from "./ResearchAggregateTypes.js";

describe("PromotionGateService", () => {
  it("returns NOT_READY when the sample is too small", () => {
    const result = new PromotionGateService().evaluate({
      config: {
        ...defaultResearchAggregateConfig(),
        runSources: [{ label: "RunA", path: "data/archive/run-a" }],
      },
      crossRun: crossRun({
        runCount: 1,
        validRunCount: 1,
        observedDecisionCount: 25,
        uniqueMintCount: 3,
      }),
      runValidations: [runValidation("RunA", true)],
      shadowEntries: shadowEntryReport([]),
    });

    expect(result.readiness).toBe("NOT_READY");
    expect(result.confidence).toBe("LOW");
    expect(result.controlledPaperPilotRecommended).toBe(false);
    expect(result.paperBuyAutomationEnabled).toBe(false);
  });

  it("returns PROMISING_RESEARCH when sample bars pass but no profile clears promotion", () => {
    const result = new PromotionGateService().evaluate({
      config: {
        ...defaultResearchAggregateConfig(),
        runSources: [
          { label: "RunA", path: "data/archive/run-a" },
          { label: "RunB", path: "data/archive/run-b" },
          { label: "RunC", path: "data/archive/run-c" },
        ],
      },
      crossRun: crossRun({
        runCount: 3,
        validRunCount: 3,
        observedDecisionCount: 150,
        uniqueMintCount: 12,
      }),
      runValidations: [
        runValidation("RunA", true),
        runValidation("RunB", true),
        runValidation("RunC", true),
      ],
      shadowEntries: shadowEntryReport([
        {
          label: "ALL",
          profileKey: "P002@v1",
          status: "PROMISING_RESEARCH",
          confidence: "MEDIUM",
        },
      ]),
    });

    expect(result.readiness).toBe("PROMISING_RESEARCH");
    expect(result.confidence).toBe("MEDIUM");
    expect(result.blockingReasons.join(" ")).toMatch(/No shadow-entry profile/i);
  });

  it("returns CANDIDATE_FOR_CONTROLLED_PAPER_PILOT when all bars pass", () => {
    const result = new PromotionGateService().evaluate({
      config: {
        ...defaultResearchAggregateConfig(),
        runSources: [
          { label: "RunA", path: "data/archive/run-a" },
          { label: "RunB", path: "data/archive/run-b" },
          { label: "RunC", path: "data/archive/run-c" },
          { label: "RunD", path: "data/archive/run-d" },
        ],
      },
      crossRun: crossRun({
        runCount: 4,
        validRunCount: 4,
        observedDecisionCount: 300,
        uniqueMintCount: 30,
        concentration: {
          targetPct: 10,
          stopPct: 10,
          targetFirstWinCount: 40,
          maxSingleRunWinSharePct: 25,
          maxSingleMintWinSharePct: 20,
          dominantRunLabel: "RunA",
          dominantMintAddress: "mint_a",
        },
      }),
      runValidations: [
        runValidation("RunA", true),
        runValidation("RunB", true),
        runValidation("RunC", true),
        runValidation("RunD", true),
      ],
      shadowEntries: shadowEntryReport([
        {
          label: "ALL",
          profileKey: "P009@v1",
          status: "CANDIDATE_FOR_PROMOTION",
          confidence: "HIGH",
        },
      ]),
    });

    expect(result.readiness).toBe("CANDIDATE_FOR_CONTROLLED_PAPER_PILOT");
    expect(result.confidence).toBe("HIGH");
    expect(result.candidateProfileId).toBe("P009@v1");
    expect(result.controlledPaperPilotRecommended).toBe(true);
    expect(result.paperBuyAutomationEnabled).toBe(false);
  });
});

function crossRun(overrides: Partial<ResearchCrossRunSummary> = {}): ResearchCrossRunSummary {
  return {
    runCount: 3,
    validRunCount: 3,
    observedDecisionCount: 150,
    uniqueMintCount: 12,
    orderCount: 0,
    fillCount: 0,
    positionCount: 0,
    thresholdComparisons: [
      {
        profileId: "BUY65",
        profileVersion: "v1",
        label: "BUY >= 65",
        buyScoreThreshold: 65,
        watchScoreThreshold: 60,
        simulatedBuyCount: 10,
        observedBuyCount: 10,
        uniqueBuyMints: 6,
        averageBestReturnPct: 25,
        averageWorstReturnPct: -12,
        targetHitRates: { "10": 60 },
        drawdownFirstRates: { "10": 30 },
        byRun: [],
      },
    ],
    providerPressure: [
      {
        provider: "JUPITER",
        total: 100,
        okPercent: 50,
        degradedPercent: 10,
        rateLimitedPercent: 40,
        errorPercent: 0,
        liveRows: 80,
        routerRows: 20,
        liveRateLimitedPercent: 40,
        liveErrorPercent: 0,
        routerCacheHits: 5,
        routerCooldownSkips: 15,
        routerUnavailable: 0,
        routerCooldownSkipPercent: 75,
        combinedRateLimitedPercent: 40,
        quoteSourceTypeCounts: {},
        quoteFallbackReasonCounts: {},
        quoteDemandActionCounts: {},
        jupiterDemandActionCounts: {},
        jupiterDemandOperationCounts: {},
        jupiterDemandPriorityCounts: {},
        jupiterDemandDeferredCount: 0,
        jupiterLiveAllowedCount: 0,
        jupiterControllerRateLimitObservedCount: 0,
        jupiterEffectiveIntervalMsAverage: 0,
        jupiterAdaptiveLevelMax: 0,
        jupiterSharedWindowUsageMax: 0,
        quoteSchedulerWaitMsTotal: 0,
        quoteSingleFlightJoinCount: 0,
        quoteNegativeCacheHitCount: 0,
        quoteNegativeCacheReasonCounts: {},
        raydiumVenueGuardDecisionCounts: {},
        raydiumVenueGuardReasonCounts: {},
        liveQuoteCallsAvoidedEstimate: 0,
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
      },
    ],
    concentration: {
      targetPct: 10,
      stopPct: 10,
      targetFirstWinCount: 20,
      maxSingleRunWinSharePct: 30,
      maxSingleMintWinSharePct: 20,
      dominantRunLabel: "RunA",
      dominantMintAddress: "mint_a",
    },
    ...overrides,
  };
}

function runValidation(label: string, validForPromotion: boolean): ResearchRunValidation {
  return {
    label,
    runId: `terminal_${label}`,
    databasePath: `data/archive/${label}/nexus_paper.db`,
    terminalSessionId: `session_${label}`,
    databaseSessionId: `session_${label}`,
    safetyStatus: "PASS",
    cycleCount: 1,
    oneSession: true,
    uniqueStageSessionIds: [`session_${label}`],
    scannerStoredCount: 1,
    strategyWrittenCount: 1,
    validForPromotion,
    warnings: [],
  };
}

function shadowEntryReport(
  readinessRows: readonly Partial<ShadowEntryReport["readinessByProfile"][number]>[],
): ShadowEntryReport {
  return {
    generatedAtMs: 1_800_000_000_000,
    config: {} as ShadowEntryReport["config"],
    runs: [],
    aggregate: {
      runCount: 3,
      observedDecisionCount: 150,
      uniqueMintCount: 12,
      orderCount: 0,
      fillCount: 0,
      positionCount: 0,
    },
    normalizedProfiles: [],
    profiles: [],
    baselineReproduction: {} as ShadowEntryReport["baselineReproduction"],
    improvementVsBaseline: [],
    candidates: [],
    scenarioGrid: [],
    bestExitByProfile: [],
    portfolioSummaries: [],
    readinessByProfile: readinessRows.map((row) => ({
      label: row.label ?? "ALL",
      profileId: row.profileId ?? "P001",
      profileVersion: row.profileVersion ?? "v1",
      profileKey: row.profileKey ?? "P001@v1",
      profileName: row.profileName ?? "Profile",
      status: row.status ?? "NOT_READY",
      confidence: row.confidence ?? "LOW",
      signalStability: row.signalStability ?? "LOW",
      maxMarketWindowWinConcentrationPct: row.maxMarketWindowWinConcentrationPct ?? 0,
      evidence: row.evidence ?? [],
    })),
    recommendations: [],
    nextTestPlan: [],
  };
}
