import type { ShadowRuntimeConfig } from "./ShadowConfig.js";
import type {
  ShadowCandidateResult,
  ShadowExitOutcome,
  ShadowExitScenario,
  ShadowPortfolioSummary,
  ShadowPortfolioTrade,
} from "./ShadowTypes.js";

export interface ShadowPortfolioSimulatorInput {
  readonly config: ShadowRuntimeConfig;
  readonly candidates: readonly ShadowCandidateResult[];
}

export class ShadowPortfolioSimulator {
  simulate(input: ShadowPortfolioSimulatorInput): ShadowPortfolioSummary {
    const scenario = selectPortfolioScenario(input.config);
    const startingBalanceSol = input.config.startingBalanceSol;
    const goalBalanceSol = startingBalanceSol * (1 + input.config.sessionGoalPct / 100);
    let balanceSol = startingBalanceSol;
    let peakBalanceSol = startingBalanceSol;
    let maxDrawdownPct = 0;
    const trades: ShadowPortfolioTrade[] = [];

    for (const candidate of input.candidates) {
      if (trades.length >= input.config.maxPositions || balanceSol >= goalBalanceSol) {
        break;
      }

      const outcome = findScenarioOutcome(candidate.outcomes, scenario);

      if (!outcome || outcome.exitReturnPct === undefined) {
        continue;
      }

      const entrySol = Math.min(input.config.positionSizeSol, balanceSol);
      const pnlSol = entrySol * (outcome.exitReturnPct / 100);
      balanceSol += pnlSol;
      peakBalanceSol = Math.max(peakBalanceSol, balanceSol);
      maxDrawdownPct = Math.max(
        maxDrawdownPct,
        peakBalanceSol <= 0 ? 0 : ((peakBalanceSol - balanceSol) / peakBalanceSol) * 100,
      );

      trades.push({
        strategyDecisionId: candidate.strategyDecisionId,
        symbol: candidate.symbol,
        mintAddress: candidate.mintAddress,
        decision: candidate.decision,
        score: candidate.score,
        entrySol,
        exitReturnPct: outcome.exitReturnPct,
        pnlSol,
        exitReason: outcome.exitReason,
        exitHorizonMinutes: outcome.exitHorizonMinutes,
      });
    }

    const winners = trades.filter((trade) => trade.pnlSol > 0);
    const losers = trades.filter((trade) => trade.pnlSol < 0);
    const pnlSol = balanceSol - startingBalanceSol;

    return {
      startingBalanceSol,
      endingBalanceSol: balanceSol,
      pnlSol,
      pnlPct: (pnlSol / startingBalanceSol) * 100,
      goalBalanceSol,
      goalReached: balanceSol >= goalBalanceSol,
      winningTrades: winners.length,
      losingTrades: losers.length,
      averageWinnerPct: average(winners.map((trade) => trade.exitReturnPct)),
      averageLoserPct: average(losers.map((trade) => trade.exitReturnPct)),
      maxDrawdownPct,
      trades,
    };
  }
}

function selectPortfolioScenario(config: ShadowRuntimeConfig): ShadowExitScenario {
  return {
    targetPct: config.targetPcts[0] ?? 10,
    stopPct: config.stopPcts[0] ?? 10,
    maxHoldMinutes: Math.min(
      config.maxHoldMinutes,
      config.maxHoldScenariosMinutes[0] ?? config.maxHoldMinutes,
    ),
  };
}

function findScenarioOutcome(
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

function average(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
