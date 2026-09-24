import type { ReturnPoint } from "../calibration/CalibrationTypes.js";
import type { ShadowCalibrationRawRun } from "../shadow-calibration/ShadowCalibrationTypes.js";
import type {
  ShadowEntryEarlyDrawdownMode,
  ShadowEntryRuntimeConfig,
} from "./ShadowEntryConfig.js";
import {
  buildDefaultEntryProfiles,
  candidateMatchesProfile,
  selectCandidatesForTiming,
} from "./ShadowEntryProfile.js";
import type {
  ShadowEntryBaselineReproductionSummary,
  ShadowEntryCandidate,
  ShadowEntryCandidateDecision,
  ShadowEntryExitOutcome,
  ShadowEntryExitReason,
  ShadowEntryPortfolioSummary,
  ShadowEntryProfile,
  ShadowEntryProfileExitPairingSummary,
  ShadowEntryProfileImprovementSummary,
  ShadowEntryProfileSummary,
  ShadowEntryReadinessSummary,
  ShadowEntryRecommendation,
  ShadowEntryReport,
  ShadowEntryRunSummary,
  ShadowEntryScenario,
  ShadowEntryScenarioSummary,
  ShadowEntryVariant,
} from "./ShadowEntryTypes.js";

export interface ShadowEntryReportServiceInput {
  readonly config: ShadowEntryRuntimeConfig;
  readonly runs: readonly ShadowCalibrationRawRun[];
  readonly candidates: readonly ShadowEntryCandidate[];
  readonly clock?: () => number;
}

const ALL_LABEL = "ALL";
const BASELINE_EXPECTED = {
  entries: 10,
  target10HitRatePct: 40,
  averageWorstReturnPct: -46.77,
  drawdownFirst10RatePct: 70,
} as const;

export class ShadowEntryReportService {
  private readonly config: ShadowEntryRuntimeConfig;
  private readonly runs: readonly ShadowCalibrationRawRun[];
  private readonly candidates: readonly ShadowEntryCandidate[];
  private readonly clock: () => number;

  constructor(input: ShadowEntryReportServiceInput) {
    this.config = input.config;
    this.runs = input.runs;
    this.candidates = input.candidates;
    this.clock = input.clock ?? Date.now;
  }

  generate(): ShadowEntryReport {
    const profiles = buildDefaultEntryProfiles(this.config);
    const candidateDecisions = this.buildCandidateDecisions(profiles);
    const scenarioGrid = this.buildScenarioGrid(candidateDecisions);
    const portfolioSummaries = this.buildPortfolioSummaries(candidateDecisions);
    const bestExitByProfile = this.buildBestExitByProfile(scenarioGrid);
    const normalizedProfileSummaries = this.buildNormalizedProfileSummaries(candidateDecisions);
    const profileSummaries = this.buildProfileSummaries(candidateDecisions);
    const baselineReproduction = this.buildBaselineReproduction(candidateDecisions);
    const improvementVsBaseline = this.buildImprovementVsBaseline(
      normalizedProfileSummaries,
      portfolioSummaries,
    );
    const readinessByProfile = this.buildReadiness(
      normalizedProfileSummaries,
      candidateDecisions,
      improvementVsBaseline,
    );

    return {
      generatedAtMs: this.clock(),
      config: this.config,
      runs: this.runs.map((run) => this.summarizeRun(run)),
      aggregate: {
        runCount: this.runs.length,
        observedDecisionCount: this.candidates.filter(
          (candidate) => candidate.observedPoints.length > 0,
        ).length,
        uniqueMintCount: new Set(this.candidates.map((candidate) => candidate.mintAddress)).size,
        orderCount: sum(this.runs.map((run) => run.orderCount)),
        fillCount: sum(this.runs.map((run) => run.fillCount)),
        positionCount: sum(this.runs.map((run) => run.positionCount)),
      },
      normalizedProfiles: normalizedProfileSummaries,
      profiles: profileSummaries,
      baselineReproduction,
      improvementVsBaseline,
      candidates: candidateDecisions,
      scenarioGrid,
      bestExitByProfile,
      portfolioSummaries,
      readinessByProfile,
      recommendations: this.buildRecommendations(baselineReproduction, readinessByProfile),
      nextTestPlan: this.buildNextTestPlan(),
    };
  }

  private buildCandidateDecisions(
    profiles: readonly ShadowEntryProfile[],
  ): readonly ShadowEntryCandidateDecision[] {
    const decisions: ShadowEntryCandidateDecision[] = [];

    for (const profile of profiles) {
      const profileCandidates = this.candidates.filter((candidate) =>
        candidateMatchesProfile(candidate, profile),
      );

      for (const timingMode of profile.timingModes) {
        const timedCandidates = selectCandidatesForTiming(profileCandidates, timingMode);
        const variants = buildVariants(profile, timingMode, this.config);

        for (const variant of variants) {
          for (const candidate of timedCandidates) {
            decisions.push(this.evaluateCandidate(candidate, variant));
          }
        }
      }
    }

    return decisions;
  }

  private evaluateCandidate(
    candidate: ShadowEntryCandidate,
    variant: ShadowEntryVariant,
  ): ShadowEntryCandidateDecision {
    const firstPoint = candidate.observedPoints[0];
    const base = {
      runLabel: candidate.runLabel,
      profileId: variant.profile.id,
      profileVersion: variant.profile.profileVersion,
      profileKey: variant.profile.profileKey,
      profileName: variant.profile.name,
      timingMode: variant.timingMode,
      decisionId: candidate.decisionId,
      mintAddress: candidate.mintAddress,
      ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
      sourceDecision: candidate.decision,
      score: candidate.score,
      earlyDrawdownMode: variant.earlyDrawdownMode,
      ...(variant.confirmationHorizonMinutes !== undefined
        ? { confirmationHorizonMinutes: variant.confirmationHorizonMinutes }
        : {}),
      ...(variant.confirmationMinReturnPct !== undefined
        ? { confirmationMinReturnPct: variant.confirmationMinReturnPct }
        : {}),
      ...(variant.recoveryConfirmationReturnPct !== undefined
        ? { recoveryConfirmationReturnPct: variant.recoveryConfirmationReturnPct }
        : {}),
      ...(variant.recoveryWindowMinutes !== undefined
        ? { recoveryWindowMinutes: variant.recoveryWindowMinutes }
        : {}),
      ...(firstPoint ? { firstObservedReturnPct: firstPoint.returnPct } : {}),
      ...(candidate.bestReturnPct !== undefined
        ? { bestObservedReturnPct: candidate.bestReturnPct }
        : {}),
      ...(candidate.worstReturnPct !== undefined
        ? { worstObservedReturnPct: candidate.worstReturnPct }
        : {}),
      repeatedAttentionStrength: candidate.repeatedAttentionStrength,
      repeatedAttentionReasons: candidate.repeatedAttentionReasons,
      repeatedAttentionSourceCount: candidate.repeatedAttentionSourceCount,
      ...(candidate.firstAttentionAtMs !== undefined
        ? { firstAttentionAtMs: candidate.firstAttentionAtMs }
        : {}),
      ...(candidate.lastAttentionAtMs !== undefined
        ? { lastAttentionAtMs: candidate.lastAttentionAtMs }
        : {}),
      ...(candidate.timeBetweenAttentionSignalsMinutes !== undefined
        ? { timeBetweenAttentionSignalsMinutes: candidate.timeBetweenAttentionSignalsMinutes }
        : {}),
    } satisfies Omit<
      ShadowEntryCandidateDecision,
      "outcome" | "entered" | "gateReason" | "primaryExitOutcome"
    >;

    if (candidate.observedPoints.length === 0) {
      return {
        ...base,
        outcome: "NO_OBSERVED_RETURNS",
        entered: false,
        gateReason: "No observed watchlist returns were available.",
      };
    }

    const primaryScenario = buildScenarios(this.config)[0] ?? {
      targetPct: 10,
      stopPct: 10,
      maxHoldMinutes: 15,
    };

    if (!variant.profile.confirmationRequired) {
      return {
        ...base,
        outcome: "WOULD_ENTER",
        entered: true,
        gateReason: "Profile enters at decision baseline.",
        entryHorizonMinutes: 0,
        entryReturnPct: 0,
        primaryExitOutcome: simulateScenario(candidate.observedPoints, primaryScenario),
      };
    }

    const gated = applyConfirmationGate(
      candidate.observedPoints,
      variant,
      primaryScenario.targetPct,
    );

    if (!gated.entered) {
      return {
        ...base,
        outcome: gated.outcome,
        entered: false,
        gateReason: gated.reason,
        ...(gated.entryHorizonMinutes !== undefined
          ? { entryHorizonMinutes: gated.entryHorizonMinutes }
          : {}),
        ...(gated.entryReturnPct !== undefined ? { entryReturnPct: gated.entryReturnPct } : {}),
      };
    }

    if (gated.entryHorizonMinutes === undefined || gated.entryReturnPct === undefined) {
      return {
        ...base,
        outcome: "INSUFFICIENT_CONFIRMATION_DATA",
        entered: false,
        gateReason: "Confirmed entry did not include an entry observation.",
      };
    }

    const rebasedPoints = rebasePoints(
      candidate.observedPoints,
      gated.entryHorizonMinutes,
      gated.entryReturnPct,
    );

    return {
      ...base,
      outcome: gated.outcome,
      entered: true,
      gateReason: gated.reason,
      entryHorizonMinutes: gated.entryHorizonMinutes,
      entryReturnPct: gated.entryReturnPct,
      primaryExitOutcome: simulateScenario(rebasedPoints, primaryScenario),
    };
  }

  private buildScenarioGrid(
    candidateDecisions: readonly ShadowEntryCandidateDecision[],
  ): readonly ShadowEntryScenarioSummary[] {
    const rows: ShadowEntryScenarioSummary[] = [];
    const scenarioDecisions = [
      ...candidateDecisions,
      ...candidateDecisions.map((decision) => ({ ...decision, runLabel: ALL_LABEL })),
    ];

    for (const [key, items] of groupBy(
      scenarioDecisions.filter((decision) => decision.entered),
      (decision) => `${decision.runLabel}:${decision.profileKey}`,
    )) {
      const first = items[0];

      if (!first) continue;

      for (const scenario of buildScenarios(this.config)) {
        const outcomes = items.map((decision) =>
          simulateScenario(
            rebasePointsForDecision(
              this.candidates.find((candidate) => candidate.decisionId === decision.decisionId),
              decision,
            ),
            scenario,
          ),
        );
        const returns = outcomes
          .map((outcome) => outcome.exitReturnPct)
          .filter((value): value is number => value !== undefined);
        const portfolio = simulatePortfolio(
          outcomes,
          this.config.portfolioStartingSol,
          this.config.portfolioPositionSizeSol,
          this.config.portfolioMaxPositions,
        );

        rows.push({
          label: key.split(":")[0] ?? first.runLabel,
          profileId: first.profileId,
          profileVersion: first.profileVersion,
          profileKey: first.profileKey,
          profileName: first.profileName,
          targetPct: scenario.targetPct,
          stopPct: scenario.stopPct,
          maxHoldMinutes: scenario.maxHoldMinutes,
          evaluatedCount: outcomes.length,
          targetHitCount: countExitReason(outcomes, "TARGET_HIT"),
          stopHitCount: countExitReason(outcomes, "STOP_HIT"),
          maxHoldCount: countExitReason(outcomes, "MAX_HOLD"),
          noObservationCount: countExitReason(outcomes, "NO_OBSERVATION"),
          ambiguousCount: countExitReason(outcomes, "AMBIGUOUS"),
          ...(returns.length > 0 ? { averageExitReturnPct: average(returns) } : {}),
          ...(returns.length > 0 ? { medianExitReturnPct: median(returns) } : {}),
          simulatedEndingSol: portfolio.endingSol,
          simulatedPnlSol: portfolio.pnlSol,
          simulatedPnlPct: portfolio.pnlPct,
          maxDrawdownPct: portfolio.maxDrawdownPct,
          goalReached:
            portfolio.endingSol >=
            this.config.portfolioStartingSol * (1 + this.config.portfolioGoalPct / 100),
        });
      }
    }

    return rows.sort(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.profileKey.localeCompare(right.profileKey) ||
        right.simulatedPnlPct - left.simulatedPnlPct,
    );
  }

  private buildProfileSummaries(
    candidateDecisions: readonly ShadowEntryCandidateDecision[],
  ): readonly ShadowEntryProfileSummary[] {
    return this.summarizeProfileDecisions(candidateDecisions);
  }

  private buildNormalizedProfileSummaries(
    candidateDecisions: readonly ShadowEntryCandidateDecision[],
  ): readonly ShadowEntryProfileSummary[] {
    return this.summarizeProfileDecisions(this.selectNormalizedDecisions(candidateDecisions));
  }

  private summarizeProfileDecisions(
    candidateDecisions: readonly ShadowEntryCandidateDecision[],
  ): readonly ShadowEntryProfileSummary[] {
    const summaries: ShadowEntryProfileSummary[] = [];
    const summaryRows = [
      ...candidateDecisions,
      ...candidateDecisions.map((decision) => ({ ...decision, runLabel: ALL_LABEL })),
    ];

    for (const [, items] of groupBy(summaryRows, (decision) =>
      [decision.runLabel, decision.profileKey, decision.timingMode].join(":"),
    )) {
      const first = items[0];

      if (!first) continue;

      const entered = items.filter((item) => item.entered);
      const exits = entered
        .map((item) => item.primaryExitOutcome)
        .filter((outcome): outcome is ShadowEntryExitOutcome => outcome !== undefined);
      const exitReturns = exits
        .map((outcome) => outcome.exitReturnPct)
        .filter((value): value is number => value !== undefined);
      const bestReturns = items
        .map((item) => item.bestObservedReturnPct)
        .filter((value): value is number => value !== undefined);
      const worstReturns = items
        .map((item) => item.worstObservedReturnPct)
        .filter((value): value is number => value !== undefined);

      summaries.push({
        label: first.runLabel,
        profileId: first.profileId,
        profileVersion: first.profileVersion,
        profileKey: first.profileKey,
        profileName: first.profileName,
        timingMode: first.timingMode,
        consideredCount: items.length,
        enteredCount: entered.length,
        uniqueMints: new Set(items.map((item) => item.mintAddress)).size,
        targetFirstRatePct: percentage(countExitReason(exits, "TARGET_HIT"), exits.length),
        stopFirstRatePct: percentage(countExitReason(exits, "STOP_HIT"), exits.length),
        ...(bestReturns.length > 0 ? { averageBestReturnPct: average(bestReturns) } : {}),
        ...(worstReturns.length > 0 ? { averageWorstReturnPct: average(worstReturns) } : {}),
        ...(exitReturns.length > 0 ? { medianExitReturnPct: median(exitReturns) } : {}),
        missedFastMoveCount: items.filter((item) => item.outcome === "MISSED_FAST_MOVE").length,
        falsePositiveAvoidedCount: items.filter(
          (item) =>
            !item.entered &&
            item.sourceDecision === "BUY" &&
            (item.bestObservedReturnPct ?? Number.NEGATIVE_INFINITY) <
              (this.config.targetPcts[0] ?? 10),
        ).length,
      });
    }

    return summaries;
  }

  private selectNormalizedDecisions(
    candidateDecisions: readonly ShadowEntryCandidateDecision[],
  ): readonly ShadowEntryCandidateDecision[] {
    return [...groupBy(candidateDecisions, normalizedDecisionKey)]
      .map(([, items]) => selectRepresentativeDecision(items))
      .filter((decision): decision is ShadowEntryCandidateDecision => decision !== undefined);
  }

  private buildLabelSummariesByProfile(
    summaries: readonly ShadowEntryProfileSummary[],
  ): ReadonlyMap<string, readonly ShadowEntryProfileSummary[]> {
    return groupBy(
      summaries.filter((summary) => summary.label !== ALL_LABEL),
      (summary) => `${summary.profileKey}:${summary.timingMode}`,
    );
  }

  private buildBaselineReproduction(
    candidateDecisions: readonly ShadowEntryCandidateDecision[],
  ): ShadowEntryBaselineReproductionSummary {
    const baseline = candidateDecisions.filter(
      (decision) => decision.profileId === "P001" && decision.entered,
    );
    const applicable = this.isPhase891BaselineComparison();

    if (baseline.length === 0) {
      return {
        applicable,
        passed: !applicable,
        reason: applicable
          ? "P001 baseline_raw_buy summary was not produced."
          : "Baseline reproduction is only required for archived Phase 8.91 comparison runs.",
        expected: BASELINE_EXPECTED,
        observed: {
          entries: 0,
          target10HitRatePct: 0,
          drawdownFirst10RatePct: 0,
        },
      };
    }

    const worstReturns = baseline
      .map((decision) => decision.worstObservedReturnPct)
      .filter((value): value is number => value !== undefined);
    const primaryScenario = {
      targetPct: 10,
      stopPct: 10,
      maxHoldMinutes: 60,
    };
    const outcomes = baseline.map((decision) =>
      simulateScenario(
        rebasePointsForDecision(
          this.candidates.find((candidate) => candidate.decisionId === decision.decisionId),
          decision,
        ),
        primaryScenario,
      ),
    );
    const observed = {
      entries: baseline.length,
      target10HitRatePct: percentage(
        baseline.filter(
          (decision) => (decision.bestObservedReturnPct ?? Number.NEGATIVE_INFINITY) >= 10,
        ).length,
        baseline.length,
      ),
      ...(worstReturns.length > 0 ? { averageWorstReturnPct: average(worstReturns) } : {}),
      drawdownFirst10RatePct: percentage(countExitReason(outcomes, "STOP_HIT"), outcomes.length),
    };

    if (!applicable) {
      return {
        applicable,
        passed: true,
        reason: "Baseline reproduction is only required for archived Phase 8.91 comparison runs.",
        expected: BASELINE_EXPECTED,
        observed,
      };
    }

    const passed =
      observed.entries === BASELINE_EXPECTED.entries &&
      Math.abs(observed.target10HitRatePct - BASELINE_EXPECTED.target10HitRatePct) <= 5 &&
      Math.abs(
        (observed.averageWorstReturnPct ?? BASELINE_EXPECTED.averageWorstReturnPct) -
          BASELINE_EXPECTED.averageWorstReturnPct,
      ) <= 5 &&
      Math.abs(observed.drawdownFirst10RatePct - BASELINE_EXPECTED.drawdownFirst10RatePct) <= 5;

    return {
      applicable,
      passed,
      reason: passed
        ? "P001 approximately reproduces final Phase 8.91 raw BUY metrics."
        : "P001 does not reproduce final Phase 8.91 raw BUY metrics; implementation or source data needs review.",
      expected: BASELINE_EXPECTED,
      observed,
    };
  }

  private isPhase891BaselineComparison(): boolean {
    return (
      this.config.dbSources.length >= 3 &&
      this.config.dbSources.every((source) =>
        source.path.replace(/\\/g, "/").toLowerCase().includes("phase8.91"),
      )
    );
  }

  private buildImprovementVsBaseline(
    summaries: readonly ShadowEntryProfileSummary[],
    portfolios: readonly ShadowEntryPortfolioSummary[],
  ): readonly ShadowEntryProfileImprovementSummary[] {
    const baseline = summaries.find(
      (summary) =>
        summary.label === ALL_LABEL &&
        summary.profileKey === "P001@v1" &&
        summary.timingMode === "decision",
    );
    const baselinePortfolio = portfolios.find(
      (portfolio) => portfolio.label === ALL_LABEL && portfolio.profileKey === "P001@v1",
    );

    if (!baseline) {
      return [];
    }

    return summaries
      .filter((summary) => summary.label === ALL_LABEL)
      .map((summary) => {
        const portfolio = portfolios.find(
          (candidate) =>
            candidate.label === ALL_LABEL && candidate.profileKey === summary.profileKey,
        );
        const averageBestReturnDeltaPct = delta(
          summary.averageBestReturnPct,
          baseline.averageBestReturnPct,
        );
        const averageWorstReturnDeltaPct = delta(
          summary.averageWorstReturnPct,
          baseline.averageWorstReturnPct,
        );
        const medianExitReturnDeltaPct = delta(
          summary.medianExitReturnPct,
          baseline.medianExitReturnPct,
        );

        return {
          label: summary.label,
          profileId: summary.profileId,
          profileVersion: summary.profileVersion,
          profileKey: summary.profileKey,
          profileName: summary.profileName,
          observedEntriesDelta: summary.enteredCount - baseline.enteredCount,
          targetFirstRateDeltaPct: summary.targetFirstRatePct - baseline.targetFirstRatePct,
          stopFirstRateDeltaPct: summary.stopFirstRatePct - baseline.stopFirstRatePct,
          ...(averageBestReturnDeltaPct !== undefined ? { averageBestReturnDeltaPct } : {}),
          ...(averageWorstReturnDeltaPct !== undefined ? { averageWorstReturnDeltaPct } : {}),
          ...(medianExitReturnDeltaPct !== undefined ? { medianExitReturnDeltaPct } : {}),
          simulatedPnlDeltaSol:
            (portfolio?.simulatedPnlSol ?? 0) - (baselinePortfolio?.simulatedPnlSol ?? 0),
          maxDrawdownDeltaPct:
            (portfolio?.maxDrawdownPct ?? 0) - (baselinePortfolio?.maxDrawdownPct ?? 0),
          missedFastMoversDelta: summary.missedFastMoveCount - baseline.missedFastMoveCount,
          falsePositiveAvoidedDelta:
            summary.falsePositiveAvoidedCount - baseline.falsePositiveAvoidedCount,
        };
      });
  }

  private buildPortfolioSummaries(
    candidateDecisions: readonly ShadowEntryCandidateDecision[],
  ): readonly ShadowEntryPortfolioSummary[] {
    const rows: ShadowEntryPortfolioSummary[] = [];
    const primaryScenario = buildScenarios(this.config)[0] ?? {
      targetPct: 10,
      stopPct: 10,
      maxHoldMinutes: 15,
    };
    const allRows = [
      ...candidateDecisions,
      ...candidateDecisions.map((decision) => ({ ...decision, runLabel: ALL_LABEL })),
    ];

    for (const [, items] of groupBy(
      allRows.filter((item) => item.entered),
      (item) => `${item.runLabel}:${item.profileKey}`,
    )) {
      const first = items[0];

      if (!first) continue;

      const outcomes = items.map((decision) =>
        simulateScenario(
          rebasePointsForDecision(
            this.candidates.find((candidate) => candidate.decisionId === decision.decisionId),
            decision,
          ),
          primaryScenario,
        ),
      );
      const portfolio = simulatePortfolio(
        outcomes,
        this.config.portfolioStartingSol,
        this.config.portfolioPositionSizeSol,
        this.config.portfolioMaxPositions,
      );

      rows.push({
        label: first.runLabel,
        profileId: first.profileId,
        profileVersion: first.profileVersion,
        profileKey: first.profileKey,
        profileName: first.profileName,
        enteredCount: outcomes.length,
        simulatedEndingSol: portfolio.endingSol,
        simulatedPnlSol: portfolio.pnlSol,
        simulatedPnlPct: portfolio.pnlPct,
        maxDrawdownPct: portfolio.maxDrawdownPct,
        goalReached:
          portfolio.endingSol >=
          this.config.portfolioStartingSol * (1 + this.config.portfolioGoalPct / 100),
      });
    }

    return rows;
  }

  private buildBestExitByProfile(
    scenarioGrid: readonly ShadowEntryScenarioSummary[],
  ): readonly ShadowEntryProfileExitPairingSummary[] {
    return [...groupBy(scenarioGrid, (row) => `${row.label}:${row.profileKey}`)].flatMap(
      ([, rows]) => {
        const best = [...rows].sort(
          (left, right) =>
            right.simulatedPnlPct - left.simulatedPnlPct ||
            left.maxDrawdownPct - right.maxDrawdownPct,
        )[0];

        return best
          ? [
              {
                label: best.label,
                profileId: best.profileId,
                profileVersion: best.profileVersion,
                profileKey: best.profileKey,
                profileName: best.profileName,
                targetPct: best.targetPct,
                stopPct: best.stopPct,
                maxHoldMinutes: best.maxHoldMinutes,
                evaluatedCount: best.evaluatedCount,
                simulatedPnlPct: best.simulatedPnlPct,
                maxDrawdownPct: best.maxDrawdownPct,
                targetHitCount: best.targetHitCount,
                stopHitCount: best.stopHitCount,
              },
            ]
          : [];
      },
    );
  }

  private buildReadiness(
    summaries: readonly ShadowEntryProfileSummary[],
    candidateDecisions: readonly ShadowEntryCandidateDecision[],
    improvements: readonly ShadowEntryProfileImprovementSummary[],
  ): readonly ShadowEntryReadinessSummary[] {
    const normalizedDecisions = this.selectNormalizedDecisions(candidateDecisions);
    const labelSummariesByProfile = this.buildLabelSummariesByProfile(summaries);

    return summaries
      .filter((summary) => summary.label === ALL_LABEL)
      .map((summary) => {
        const improvement = improvements.find(
          (item) => item.profileKey === summary.profileKey && item.label === ALL_LABEL,
        );
        const labelSummaries =
          labelSummariesByProfile.get(`${summary.profileKey}:${summary.timingMode}`) ?? [];
        const signalStability = calculateSignalStability(labelSummaries);
        const maxMarketWindowWinConcentrationPct = calculateMaxMarketWindowWinConcentrationPct(
          normalizedDecisions,
          summary,
        );
        const labelsWithEntries = labelSummaries.filter((item) => item.enteredCount > 0).length;
        const confidence = calculateConfidence({
          enteredCount: summary.enteredCount,
          uniqueMints: summary.uniqueMints,
          labelsWithEntries,
          maxMarketWindowWinConcentrationPct,
          signalStability,
        });
        const evidence = [
          `entered=${summary.enteredCount}`,
          `uniqueMints=${summary.uniqueMints}`,
          `labelsWithEntries=${labelsWithEntries}`,
          `targetFirst=${summary.targetFirstRatePct.toFixed(2)}%`,
          `stopFirst=${summary.stopFirstRatePct.toFixed(2)}%`,
          `avgWorst=${formatOptional(summary.averageWorstReturnPct)}%`,
          `confidence=${confidence}`,
          `signalStability=${signalStability}`,
          `maxMarketWindowWins=${maxMarketWindowWinConcentrationPct.toFixed(2)}%`,
        ];
        const positiveImprovement =
          improvement &&
          improvement.targetFirstRateDeltaPct > 0 &&
          improvement.stopFirstRateDeltaPct <= 0;
        const promotionSampleReady =
          summary.enteredCount >= 20 &&
          summary.uniqueMints >= 10 &&
          labelsWithEntries >= 3 &&
          maxMarketWindowWinConcentrationPct <= 40;

        if (summary.profileId === "P001") {
          return {
            label: summary.label,
            profileId: summary.profileId,
            profileVersion: summary.profileVersion,
            profileKey: summary.profileKey,
            profileName: summary.profileName,
            status: "NOT_READY" as const,
            confidence,
            signalStability,
            maxMarketWindowWinConcentrationPct,
            evidence,
          };
        }

        if (
          positiveImprovement &&
          promotionSampleReady &&
          confidence !== "LOW" &&
          signalStability !== "LOW" &&
          (summary.averageWorstReturnPct ?? Number.NEGATIVE_INFINITY) > -25
        ) {
          return {
            label: summary.label,
            profileId: summary.profileId,
            profileVersion: summary.profileVersion,
            profileKey: summary.profileKey,
            profileName: summary.profileName,
            status: "CANDIDATE_FOR_PROMOTION" as const,
            confidence,
            signalStability,
            maxMarketWindowWinConcentrationPct,
            evidence,
          };
        }

        if (positiveImprovement) {
          return {
            label: summary.label,
            profileId: summary.profileId,
            profileVersion: summary.profileVersion,
            profileKey: summary.profileKey,
            profileName: summary.profileName,
            status: "PROMISING_RESEARCH" as const,
            confidence,
            signalStability,
            maxMarketWindowWinConcentrationPct,
            evidence,
          };
        }

        return {
          label: summary.label,
          profileId: summary.profileId,
          profileVersion: summary.profileVersion,
          profileKey: summary.profileKey,
          profileName: summary.profileName,
          status: "NOT_READY" as const,
          confidence,
          signalStability,
          maxMarketWindowWinConcentrationPct,
          evidence,
        };
      });
  }

  private summarizeRun(run: ShadowCalibrationRawRun): ShadowEntryRunSummary {
    const runCandidates = this.candidates.filter((candidate) => candidate.runLabel === run.label);
    const mechanicallyValid =
      run.orderCount === 0 && run.fillCount === 0 && run.positionCount === 0;

    return {
      label: run.label,
      sourceKind: run.sourceKind,
      ...(run.session ? { sessionId: run.session.id } : {}),
      strategyRows: run.strategyDecisions.length,
      observedReturnRows: run.watchlistReturns.length,
      observedDecisionCount: runCandidates.filter(
        (candidate) => candidate.observedPoints.length > 0,
      ).length,
      uniqueMints: new Set(runCandidates.map((candidate) => candidate.mintAddress)).size,
      orderCount: run.orderCount,
      fillCount: run.fillCount,
      positionCount: run.positionCount,
      warnings: [
        ...run.warnings,
        ...(mechanicallyValid
          ? []
          : [
              `Run contains paper execution rows: orders=${run.orderCount} fills=${run.fillCount} positions=${run.positionCount}.`,
            ]),
      ],
    };
  }

  private buildRecommendations(
    baseline: ShadowEntryBaselineReproductionSummary,
    readiness: readonly ShadowEntryReadinessSummary[],
  ): readonly ShadowEntryRecommendation[] {
    const recommendations: ShadowEntryRecommendation[] = [];
    const candidatesForPromotion = readiness.filter(
      (item) => item.status === "CANDIDATE_FOR_PROMOTION",
    );

    if (!baseline.passed) {
      recommendations.push({
        category: "baseline_reproduction",
        recommendation:
          "Fix P001 baseline reproduction before trusting Phase 8.92 profile comparisons.",
        evidence: [baseline.reason],
      });
    }

    if (candidatesForPromotion.length > 0) {
      recommendations.push({
        category: "phase_8_93_candidate",
        recommendation:
          "One or more profiles are candidates for future Phase 8.93 Strategy Promotion review; paper execution remains disabled.",
        evidence: candidatesForPromotion.map(
          (item) =>
            `${item.profileKey} ${item.profileName}: confidence=${item.confidence}; stability=${item.signalStability}; ${item.evidence.join("; ")}`,
        ),
      });
    } else {
      recommendations.push({
        category: "phase_9_default",
        recommendation:
          "Keep Phase 9 shadow-first; paper execution remains disabled. No Phase 8.92 profile is promoted into paper execution.",
        evidence: ["CANDIDATE_FOR_PROMOTION is a review label, not an execution trigger."],
      });
    }

    recommendations.push({
      category: "quote_policy",
      recommendation:
        "Keep missing Jupiter quote visible as evidence, but do not reject by default while rate limiting remains elevated.",
      evidence: ["P005 quote_control exists to measure quote availability effects."],
    });

    return recommendations;
  }

  private buildNextTestPlan(): readonly string[] {
    return [
      "First run shadow:entries against the archived Phase 8.91 datasets and verify P001 baseline reproduction.",
      "If P001 reproduction passes, run three or more fresh Phase 8.92B validation windows with shadow:entries after shadow:exits.",
      "Compare P002-P011 profile versions against immutable P001@v1 before considering any Phase 8.93 Strategy Promotion work.",
      "Keep paper:execute out of TerminalRunner defaults until a separate promotion phase validates a candidate profile.",
    ];
  }
}

function buildVariants(
  profile: ShadowEntryProfile,
  timingMode: ShadowEntryVariant["timingMode"],
  config: ShadowEntryRuntimeConfig,
): readonly ShadowEntryVariant[] {
  if (!profile.confirmationRequired) {
    return [
      {
        profile,
        timingMode,
        earlyDrawdownMode: "off",
      },
    ];
  }

  const variants: ShadowEntryVariant[] = [];

  for (const confirmationHorizonMinutes of config.confirmationHorizonsMinutes) {
    for (const confirmationMinReturnPct of config.confirmationMinReturnPcts) {
      for (const earlyDrawdownMode of profile.earlyDrawdownModes) {
        if (earlyDrawdownMode === "require_recovery") {
          for (const recoveryWindowMinutes of config.recoveryWindowMinutes) {
            for (const recoveryConfirmationReturnPct of config.recoveryConfirmationReturnPcts) {
              variants.push({
                profile,
                timingMode,
                confirmationHorizonMinutes,
                confirmationMinReturnPct,
                earlyDrawdownMode,
                recoveryWindowMinutes,
                recoveryConfirmationReturnPct,
              });
            }
          }
        } else {
          variants.push({
            profile,
            timingMode,
            confirmationHorizonMinutes,
            confirmationMinReturnPct,
            earlyDrawdownMode,
          });
        }
      }
    }
  }

  return variants;
}

function applyConfirmationGate(
  points: readonly ReturnPoint[],
  variant: ShadowEntryVariant,
  targetPct: number,
): {
  readonly outcome: ShadowEntryCandidateDecision["outcome"];
  readonly entered: boolean;
  readonly reason: string;
  readonly entryHorizonMinutes?: number;
  readonly entryReturnPct?: number;
} {
  const sorted = [...points].sort((left, right) => left.horizonMinutes - right.horizonMinutes);
  const horizon = variant.confirmationHorizonMinutes ?? 1;
  const minReturn = variant.confirmationMinReturnPct ?? 0;
  const beforeConfirmation = sorted.filter((point) => point.horizonMinutes < horizon);
  const throughConfirmation = sorted.filter((point) => point.horizonMinutes <= horizon);
  const confirmationPoint = sorted.find((point) => point.horizonMinutes >= horizon);

  if (beforeConfirmation.some((point) => point.returnPct >= targetPct)) {
    return {
      outcome: "MISSED_FAST_MOVE",
      entered: false,
      reason: "Target was reached before confirmation horizon.",
    };
  }

  if (!confirmationPoint) {
    return {
      outcome: "INSUFFICIENT_CONFIRMATION_DATA",
      entered: false,
      reason: "No observation was available at or after confirmation horizon.",
    };
  }

  const drawdownThreshold = drawdownThresholdForMode(variant.earlyDrawdownMode);
  const drawdownPoint =
    drawdownThreshold === undefined
      ? undefined
      : throughConfirmation.find((point) => point.returnPct <= -drawdownThreshold);

  if (drawdownPoint && variant.earlyDrawdownMode.startsWith("reject_")) {
    return {
      outcome: "REJECT_EARLY_DRAWDOWN",
      entered: false,
      reason: `Early drawdown reached -${drawdownThreshold}%.`,
      entryHorizonMinutes: drawdownPoint.horizonMinutes,
      entryReturnPct: drawdownPoint.returnPct,
    };
  }

  if (drawdownPoint && variant.earlyDrawdownMode === "require_recovery") {
    const recoveryWindow = variant.recoveryWindowMinutes ?? horizon;
    const recoveryReturn = variant.recoveryConfirmationReturnPct ?? minReturn;
    const recoveryPoint = sorted.find(
      (point) =>
        point.horizonMinutes >= drawdownPoint.horizonMinutes &&
        point.horizonMinutes <= recoveryWindow &&
        point.returnPct >= recoveryReturn,
    );
    const lateRecoveryPoint = sorted.find(
      (point) => point.horizonMinutes > recoveryWindow && point.returnPct >= recoveryReturn,
    );

    if (recoveryPoint) {
      return {
        outcome: "WOULD_ENTER_AFTER_RECOVERY",
        entered: true,
        reason: "Candidate recovered after early drawdown within the configured window.",
        entryHorizonMinutes: recoveryPoint.horizonMinutes,
        entryReturnPct: recoveryPoint.returnPct,
      };
    }

    if (lateRecoveryPoint) {
      return {
        outcome: "WOULD_SKIP_RECOVERY_TOO_LATE",
        entered: false,
        reason: "Candidate recovered after the configured recovery window.",
        entryHorizonMinutes: lateRecoveryPoint.horizonMinutes,
        entryReturnPct: lateRecoveryPoint.returnPct,
      };
    }

    return {
      outcome: "FAILED_RECOVERY_AFTER_DRAWDOWN",
      entered: false,
      reason: "Candidate did not recover after early drawdown within the configured window.",
      entryHorizonMinutes: drawdownPoint.horizonMinutes,
      entryReturnPct: drawdownPoint.returnPct,
    };
  }

  if (confirmationPoint.returnPct < minReturn) {
    return {
      outcome: "REJECT_CONFIRMATION_RETURN",
      entered: false,
      reason: `Confirmation return ${confirmationPoint.returnPct.toFixed(
        4,
      )}% was below ${minReturn}%.`,
      entryHorizonMinutes: confirmationPoint.horizonMinutes,
      entryReturnPct: confirmationPoint.returnPct,
    };
  }

  return {
    outcome:
      drawdownPoint && variant.earlyDrawdownMode === "warn_only"
        ? "WARN_EARLY_DRAWDOWN"
        : "WOULD_ENTER",
    entered: true,
    reason:
      drawdownPoint && variant.earlyDrawdownMode === "warn_only"
        ? "Candidate entered with early drawdown warning."
        : "Candidate confirmed entry.",
    entryHorizonMinutes: confirmationPoint.horizonMinutes,
    entryReturnPct: confirmationPoint.returnPct,
  };
}

function drawdownThresholdForMode(mode: ShadowEntryEarlyDrawdownMode): number | undefined {
  if (mode === "reject_5") return 5;
  if (mode === "reject_10") return 10;
  if (mode === "reject_15") return 15;
  if (mode === "require_recovery") return 0;

  return undefined;
}

function normalizedDecisionKey(decision: ShadowEntryCandidateDecision): string {
  return [decision.runLabel, decision.profileKey, decision.timingMode, decision.decisionId].join(
    ":",
  );
}

function selectRepresentativeDecision(
  decisions: readonly ShadowEntryCandidateDecision[],
): ShadowEntryCandidateDecision | undefined {
  return [...decisions].sort(
    (left, right) =>
      Number(right.entered) - Number(left.entered) ||
      (left.entryHorizonMinutes ?? Number.POSITIVE_INFINITY) -
        (right.entryHorizonMinutes ?? Number.POSITIVE_INFINITY) ||
      (left.confirmationHorizonMinutes ?? Number.POSITIVE_INFINITY) -
        (right.confirmationHorizonMinutes ?? Number.POSITIVE_INFINITY) ||
      (left.confirmationMinReturnPct ?? Number.POSITIVE_INFINITY) -
        (right.confirmationMinReturnPct ?? Number.POSITIVE_INFINITY) ||
      earlyDrawdownModeRank(left.earlyDrawdownMode) -
        earlyDrawdownModeRank(right.earlyDrawdownMode),
  )[0];
}

function earlyDrawdownModeRank(mode: ShadowEntryEarlyDrawdownMode): number {
  const order: readonly ShadowEntryEarlyDrawdownMode[] = [
    "off",
    "warn_only",
    "reject_5",
    "reject_10",
    "reject_15",
    "require_recovery",
  ];

  return order.indexOf(mode);
}

function calculateSignalStability(
  summaries: readonly ShadowEntryProfileSummary[],
): ShadowEntryReadinessSummary["signalStability"] {
  const active = summaries.filter((summary) => summary.enteredCount > 0);

  if (active.length < 2) {
    return "LOW";
  }

  const stableWindows = active.filter(
    (summary) => summary.targetFirstRatePct >= 40 && summary.stopFirstRatePct <= 50,
  ).length;
  const targetRates = active.map((summary) => summary.targetFirstRatePct);
  const targetSpread = Math.max(...targetRates) - Math.min(...targetRates);

  if (active.length >= 3 && stableWindows / active.length >= 0.67 && targetSpread <= 40) {
    return "HIGH";
  }

  if (stableWindows / active.length >= 0.5 || targetSpread <= 50) {
    return "MEDIUM";
  }

  return "LOW";
}

function calculateMaxMarketWindowWinConcentrationPct(
  decisions: readonly ShadowEntryCandidateDecision[],
  summary: ShadowEntryProfileSummary,
): number {
  const targetWins = decisions.filter(
    (decision) =>
      decision.profileKey === summary.profileKey &&
      decision.timingMode === summary.timingMode &&
      decision.entered &&
      decision.primaryExitOutcome?.exitReason === "TARGET_HIT",
  );
  const winsByLabel = groupBy(targetWins, (decision) => decision.runLabel);
  const winCounts = [...winsByLabel.values()].map((items) => items.length);
  const totalWins = sum(winCounts);

  if (totalWins === 0) {
    return 0;
  }

  return percentage(Math.max(...winCounts), totalWins);
}

function calculateConfidence(input: {
  readonly enteredCount: number;
  readonly uniqueMints: number;
  readonly labelsWithEntries: number;
  readonly maxMarketWindowWinConcentrationPct: number;
  readonly signalStability: ShadowEntryReadinessSummary["signalStability"];
}): ShadowEntryReadinessSummary["confidence"] {
  if (
    input.enteredCount >= 20 &&
    input.uniqueMints >= 10 &&
    input.labelsWithEntries >= 3 &&
    input.maxMarketWindowWinConcentrationPct <= 40 &&
    input.signalStability !== "LOW"
  ) {
    return "HIGH";
  }

  if (input.enteredCount >= 10 && input.uniqueMints >= 5 && input.labelsWithEntries >= 2) {
    return "MEDIUM";
  }

  return "LOW";
}

function buildScenarios(config: ShadowEntryRuntimeConfig): readonly ShadowEntryScenario[] {
  return config.targetPcts.flatMap((targetPct) =>
    config.stopPcts.flatMap((stopPct) =>
      config.maxHoldMinutes.map((maxHoldMinutes) => ({
        targetPct,
        stopPct,
        maxHoldMinutes,
      })),
    ),
  );
}

function simulateScenario(
  observedPoints: readonly ReturnPoint[],
  scenario: ShadowEntryScenario,
): ShadowEntryExitOutcome {
  const eligible = observedPoints.filter(
    (point) => point.horizonMinutes <= scenario.maxHoldMinutes,
  );

  if (eligible.length === 0) {
    return { scenario, exitReason: "NO_OBSERVATION" };
  }

  for (const point of eligible) {
    const targetHit = point.returnPct >= scenario.targetPct;
    const stopHit = point.returnPct <= -scenario.stopPct;

    if (targetHit && stopHit) {
      return {
        scenario,
        exitReason: "AMBIGUOUS",
        exitReturnPct: point.returnPct,
        exitHorizonMinutes: point.horizonMinutes,
      };
    }

    if (targetHit) {
      return {
        scenario,
        exitReason: "TARGET_HIT",
        exitReturnPct: scenario.targetPct,
        exitHorizonMinutes: point.horizonMinutes,
      };
    }

    if (stopHit) {
      return {
        scenario,
        exitReason: "STOP_HIT",
        exitReturnPct: -scenario.stopPct,
        exitHorizonMinutes: point.horizonMinutes,
      };
    }
  }

  const finalPoint = eligible[eligible.length - 1];

  return finalPoint
    ? {
        scenario,
        exitReason: "MAX_HOLD",
        exitReturnPct: finalPoint.returnPct,
        exitHorizonMinutes: finalPoint.horizonMinutes,
      }
    : { scenario, exitReason: "NO_OBSERVATION" };
}

function rebasePointsForDecision(
  candidate: ShadowEntryCandidate | undefined,
  decision: ShadowEntryCandidateDecision,
): readonly ReturnPoint[] {
  if (
    !candidate ||
    decision.entryHorizonMinutes === undefined ||
    decision.entryReturnPct === undefined
  ) {
    return [];
  }

  return rebasePoints(
    candidate.observedPoints,
    decision.entryHorizonMinutes,
    decision.entryReturnPct,
  );
}

function rebasePoints(
  points: readonly ReturnPoint[],
  entryHorizonMinutes: number,
  entryReturnPct: number,
): readonly ReturnPoint[] {
  return points
    .filter((point) => point.horizonMinutes > entryHorizonMinutes)
    .map((point) => ({
      horizonMinutes: point.horizonMinutes - entryHorizonMinutes,
      returnPct: rebaseReturnPct(point.returnPct, entryReturnPct),
    }));
}

function simulatePortfolio(
  outcomes: readonly ShadowEntryExitOutcome[],
  startingSol: number,
  positionSizeSol: number,
  maxPositions: number,
): {
  readonly endingSol: number;
  readonly pnlSol: number;
  readonly pnlPct: number;
  readonly maxDrawdownPct: number;
} {
  let balance = startingSol;
  let peak = startingSol;
  let maxDrawdownPct = 0;

  for (const outcome of outcomes.slice(0, maxPositions)) {
    if (outcome.exitReturnPct === undefined) continue;

    balance += positionSizeSol * (outcome.exitReturnPct / 100);
    peak = Math.max(peak, balance);
    maxDrawdownPct = Math.max(maxDrawdownPct, percentage(peak - balance, peak));
  }

  return {
    endingSol: balance,
    pnlSol: balance - startingSol,
    pnlPct: percentage(balance - startingSol, startingSol),
    maxDrawdownPct,
  };
}

function countExitReason(
  outcomes: readonly ShadowEntryExitOutcome[],
  reason: ShadowEntryExitReason,
): number {
  return outcomes.filter((outcome) => outcome.exitReason === reason).length;
}

function rebaseReturnPct(laterReturnPct: number, entryReturnPct: number): number {
  return ((1 + laterReturnPct / 100) / (1 + entryReturnPct / 100) - 1) * 100;
}

function delta(left: number | undefined, right: number | undefined): number | undefined {
  return left !== undefined && right !== undefined ? left - right : undefined;
}

function formatOptional(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(2);
}

function groupBy<T>(
  items: readonly T[],
  getKey: (item: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = getKey(item);
    const group = groups.get(key);

    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  return groups;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: readonly number[]): number {
  return sum(values) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const middleValue = sorted[middle];

  if (middleValue === undefined) return 0;

  if (sorted.length % 2 === 1) return middleValue;

  return ((sorted[middle - 1] ?? middleValue) + middleValue) / 2;
}

function percentage(count: number, total: number): number {
  return total === 0 ? 0 : (count / total) * 100;
}
