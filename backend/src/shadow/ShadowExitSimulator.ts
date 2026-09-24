import type { WatchlistReturnObservationRecord } from "../db/schema/index.js";
import type { ShadowRuntimeConfig } from "./ShadowConfig.js";
import type {
  ShadowCandidate,
  ShadowCandidateResult,
  ShadowExitOutcome,
  ShadowExitScenario,
  ShadowObservedReturn,
  ShadowScenarioSummary,
} from "./ShadowTypes.js";

export interface ShadowExitSimulatorInput {
  readonly config: ShadowRuntimeConfig;
  readonly candidates: readonly ShadowCandidate[];
  readonly observationsByDecisionId: ReadonlyMap<
    string,
    readonly WatchlistReturnObservationRecord[]
  >;
}

export class ShadowExitSimulator {
  simulate(input: ShadowExitSimulatorInput): {
    readonly candidates: readonly ShadowCandidateResult[];
    readonly scenarioSummaries: readonly ShadowScenarioSummary[];
  } {
    const scenarios = buildScenarios(input.config);
    const candidates = input.candidates.map((candidate) =>
      this.simulateCandidate(
        candidate,
        normalizeObservedReturns(input.observationsByDecisionId.get(candidate.decision.id) ?? []),
        scenarios,
      ),
    );

    return {
      candidates,
      scenarioSummaries: summarizeScenarios(candidates, scenarios),
    };
  }

  private simulateCandidate(
    candidate: ShadowCandidate,
    observedReturns: readonly ShadowObservedReturn[],
    scenarios: readonly ShadowExitScenario[],
  ): ShadowCandidateResult {
    const returnsWithinMaxObserved = observedReturns;
    const values = returnsWithinMaxObserved.map((observed) => observed.returnPct);
    const bestReturnPct = values.length > 0 ? Math.max(...values) : undefined;
    const worstReturnPct = values.length > 0 ? Math.min(...values) : undefined;

    return {
      strategyDecisionId: candidate.decision.id,
      mintAddress: candidate.decision.mintAddress,
      symbol: candidate.symbol,
      decision: candidate.decision.decision,
      score: candidate.decision.score ?? undefined,
      selectionMode: candidate.selectionMode,
      baselinePriceSol: candidate.baselinePriceSol,
      liquidityUsd: candidate.liquidityUsd,
      volume1hUsd: candidate.volume1hUsd,
      ageSeconds: candidate.ageSeconds,
      observedReturns,
      bestReturnPct,
      worstReturnPct,
      outcomes: scenarios.map((scenario) => simulateScenario(observedReturns, scenario)),
    };
  }
}

function buildScenarios(config: ShadowRuntimeConfig): ShadowExitScenario[] {
  const scenarios: ShadowExitScenario[] = [];

  for (const maxHoldMinutes of config.maxHoldScenariosMinutes.filter(
    (value) => value <= config.maxHoldMinutes,
  )) {
    for (const targetPct of config.targetPcts) {
      for (const stopPct of config.stopPcts) {
        scenarios.push({
          targetPct,
          stopPct,
          maxHoldMinutes,
        });
      }
    }
  }

  if (scenarios.length > 0) {
    return scenarios;
  }

  return config.targetPcts.flatMap((targetPct) =>
    config.stopPcts.map((stopPct) => ({
      targetPct,
      stopPct,
      maxHoldMinutes: config.maxHoldMinutes,
    })),
  );
}

function normalizeObservedReturns(
  observations: readonly WatchlistReturnObservationRecord[],
): readonly ShadowObservedReturn[] {
  return observations
    .filter((observation) => observation.status === "OBSERVED")
    .map((observation) => ({
      horizonMinutes: observation.horizonMinutes,
      status: observation.status,
      returnPct: parseReturnPercent(observation.returnPctSol ?? observation.returnPctUsd),
    }))
    .filter((observation): observation is ShadowObservedReturn =>
      Number.isFinite(observation.returnPct),
    )
    .sort((left, right) => left.horizonMinutes - right.horizonMinutes);
}

function simulateScenario(
  observations: readonly ShadowObservedReturn[],
  scenario: ShadowExitScenario,
): ShadowExitOutcome {
  const eligibleObservations = observations.filter(
    (observation) => observation.horizonMinutes <= scenario.maxHoldMinutes,
  );

  if (eligibleObservations.length === 0) {
    return {
      scenario,
      exitReason: "NO_OBSERVATION",
    };
  }

  for (const observation of eligibleObservations) {
    const targetHit = observation.returnPct >= scenario.targetPct;
    const stopHit = observation.returnPct <= -scenario.stopPct;

    if (targetHit && stopHit) {
      return {
        scenario,
        exitReason: "AMBIGUOUS",
        exitReturnPct: observation.returnPct,
        exitHorizonMinutes: observation.horizonMinutes,
        targetHorizonMinutes: observation.horizonMinutes,
        stopHorizonMinutes: observation.horizonMinutes,
      };
    }

    if (targetHit) {
      return {
        scenario,
        exitReason: "TARGET_HIT",
        exitReturnPct: scenario.targetPct,
        exitHorizonMinutes: observation.horizonMinutes,
        targetHorizonMinutes: observation.horizonMinutes,
      };
    }

    if (stopHit) {
      return {
        scenario,
        exitReason: "STOP_HIT",
        exitReturnPct: -scenario.stopPct,
        exitHorizonMinutes: observation.horizonMinutes,
        stopHorizonMinutes: observation.horizonMinutes,
      };
    }
  }

  const finalObservation = eligibleObservations[eligibleObservations.length - 1];

  if (!finalObservation) {
    return {
      scenario,
      exitReason: "NO_OBSERVATION",
    };
  }

  return {
    scenario,
    exitReason: "MAX_HOLD",
    exitReturnPct: finalObservation.returnPct,
    exitHorizonMinutes: finalObservation.horizonMinutes,
  };
}

function summarizeScenarios(
  candidates: readonly ShadowCandidateResult[],
  scenarios: readonly ShadowExitScenario[],
): readonly ShadowScenarioSummary[] {
  return scenarios.map((scenario) => {
    const outcomes = candidates
      .map((candidate) => findOutcome(candidate.outcomes, scenario))
      .filter((outcome): outcome is ShadowExitOutcome => outcome !== undefined);
    const exitReturns = outcomes
      .map((outcome) => outcome.exitReturnPct)
      .filter((value): value is number => value !== undefined);

    return {
      targetPct: scenario.targetPct,
      stopPct: scenario.stopPct,
      maxHoldMinutes: scenario.maxHoldMinutes,
      evaluatedCount: outcomes.length,
      targetHitCount: outcomes.filter((outcome) => outcome.exitReason === "TARGET_HIT").length,
      stopHitCount: outcomes.filter((outcome) => outcome.exitReason === "STOP_HIT").length,
      maxHoldCount: outcomes.filter((outcome) => outcome.exitReason === "MAX_HOLD").length,
      noObservationCount: outcomes.filter((outcome) => outcome.exitReason === "NO_OBSERVATION")
        .length,
      ambiguousCount: outcomes.filter((outcome) => outcome.exitReason === "AMBIGUOUS").length,
      averageExitReturnPct: average(exitReturns),
      targetHitRatePct:
        outcomes.length === 0 ? 0 : percentage(countTargetHits(outcomes), outcomes.length),
    };
  });
}

function findOutcome(
  outcomes: readonly ShadowExitOutcome[],
  scenario: ShadowExitScenario,
): ShadowExitOutcome | undefined {
  return outcomes.find(
    (outcome) =>
      outcome.scenario.targetPct === scenario.targetPct &&
      outcome.scenario.stopPct === scenario.stopPct &&
      outcome.scenario.maxHoldMinutes === scenario.maxHoldMinutes,
  );
}

function parseReturnPercent(value: string | null | undefined): number {
  if (value === null || value === undefined || value.trim() === "") {
    return Number.NaN;
  }

  return Number(value);
}

function average(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countTargetHits(outcomes: readonly ShadowExitOutcome[]): number {
  return outcomes.filter((outcome) => outcome.exitReason === "TARGET_HIT").length;
}

function percentage(count: number, total: number): number {
  return (count / total) * 100;
}
