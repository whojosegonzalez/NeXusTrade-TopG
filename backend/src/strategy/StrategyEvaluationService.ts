import { stringifyJson } from "../db/utils/json.js";
import { nowMs } from "../db/utils/timestamps.js";
import type { Repositories } from "../db/repositories/index.js";
import type { StrategyDecision } from "../db/schema/index.js";
import type { StrategyCandidate, StrategyCandidateSelector } from "./StrategyCandidateSelector.js";
import type { StrategyRuntimeConfig } from "./StrategyConfig.js";
import { StrategyScoringService, type StrategyScoreResult } from "./StrategyScoringService.js";

export interface StrategyEvaluationSummary {
  readonly sessionId: string;
  readonly selectedCount: number;
  readonly evaluatedCount: number;
  readonly writtenCount: number;
  readonly statusUpdatedCount: number;
  readonly buyCount: number;
  readonly watchCount: number;
  readonly skipCount: number;
  readonly holdCount: number;
  readonly sellCount: number;
  readonly duplicateBuyBlockedCount: number;
  readonly maxBuyCapBlockedCount: number;
  readonly errorCount: number;
  readonly dryRun: boolean;
}

export interface StrategyEvaluationServiceOptions {
  readonly config: StrategyRuntimeConfig;
  readonly repositories: Repositories;
  readonly selector: StrategyCandidateSelector;
  readonly scoringService?: StrategyScoringService;
  readonly clock?: () => number;
}

export class StrategyEvaluationService {
  private readonly scoringService: StrategyScoringService;
  private readonly clock: () => number;

  constructor(private readonly options: StrategyEvaluationServiceOptions) {
    this.scoringService = options.scoringService ?? new StrategyScoringService();
    this.clock = options.clock ?? nowMs;
  }

  async evaluate(): Promise<StrategyEvaluationSummary> {
    const startedAtMs = this.clock();
    const selection = this.options.selector.selectCandidates(this.options.config, startedAtMs);
    const counts = createEmptyCounts();
    const buyMintsThisRun = new Set<string>();

    this.writeLog(selection.session.id, "Strategy evaluation started.", {
      status: this.options.config.status,
      riskPolicy: this.options.config.riskPolicy,
      sinceHours: this.options.config.sinceHours,
      limit: this.options.config.limit,
      maxBuyDecisions: this.options.config.maxBuyDecisions,
      buyScoreThreshold: this.options.config.buyScoreThreshold,
      watchScoreThreshold: this.options.config.watchScoreThreshold,
      strategyName: this.options.config.strategyName,
      selectedCount: selection.candidates.length,
      missingRiskAssessmentCount: selection.missingRiskAssessmentCount,
      dryRun: this.options.config.dryRun,
      discoveredFromMs: selection.discoveredFromMs,
    });

    for (const candidate of selection.candidates) {
      try {
        const decidedAtMs = this.clock();
        const scoring = this.scoringService.evaluate({
          candidate,
          config: this.options.config,
          duplicateBuyInCurrentRun: buyMintsThisRun.has(candidate.tokenRadar.mintAddress),
          maxBuyCapReached: counts.buyCount >= this.options.config.maxBuyDecisions,
        });
        const write = this.writeDecision({
          sessionId: selection.session.id,
          candidate,
          scoring,
          decidedAtMs,
        });

        counts.evaluatedCount += 1;
        counts.writtenCount += write.wroteDecision ? 1 : 0;
        counts.statusUpdatedCount += write.updatedRadarStatus ? 1 : 0;
        counts.duplicateBuyBlockedCount += scoring.duplicateBuyBlocked ? 1 : 0;
        counts.maxBuyCapBlockedCount += scoring.maxBuyCapBlocked ? 1 : 0;
        incrementDecisionCount(counts, scoring.decision);

        if (scoring.decision === "BUY") {
          buyMintsThisRun.add(candidate.tokenRadar.mintAddress);
        }

        this.writeLog(selection.session.id, "Strategy candidate evaluated.", {
          tokenRadarId: candidate.tokenRadar.id,
          mintAddress: candidate.tokenRadar.mintAddress,
          score: scoring.score,
          decision: scoring.decision,
          rawDecision: scoring.rawDecision,
          dryRun: this.options.config.dryRun,
          wroteDecision: write.wroteDecision,
          updatedRadarStatus: write.updatedRadarStatus,
        });
      } catch (error) {
        counts.errorCount += 1;
        this.writeLog(
          selection.session.id,
          "Strategy candidate evaluation failed.",
          {
            tokenRadarId: candidate.tokenRadar.id,
            mintAddress: candidate.tokenRadar.mintAddress,
            error: error instanceof Error ? error.message : "Unknown strategy evaluation failure.",
          },
          "ERROR",
        );
      }
    }

    const summary: StrategyEvaluationSummary = {
      sessionId: selection.session.id,
      selectedCount: selection.candidates.length,
      evaluatedCount: counts.evaluatedCount,
      writtenCount: counts.writtenCount,
      statusUpdatedCount: counts.statusUpdatedCount,
      buyCount: counts.buyCount,
      watchCount: counts.watchCount,
      skipCount: counts.skipCount,
      holdCount: counts.holdCount,
      sellCount: counts.sellCount,
      duplicateBuyBlockedCount: counts.duplicateBuyBlockedCount,
      maxBuyCapBlockedCount: counts.maxBuyCapBlockedCount,
      errorCount: counts.errorCount,
      dryRun: this.options.config.dryRun,
    };

    this.writeLog(selection.session.id, "Strategy evaluation summary.", summary);

    return summary;
  }

  private writeDecision(input: {
    readonly sessionId: string;
    readonly candidate: StrategyCandidate;
    readonly scoring: StrategyScoreResult;
    readonly decidedAtMs: number;
  }): { readonly wroteDecision: boolean; readonly updatedRadarStatus: boolean } {
    if (this.options.config.dryRun) {
      return {
        wroteDecision: false,
        updatedRadarStatus: false,
      };
    }

    this.options.repositories.strategyDecisions.createStrategyDecision({
      sessionId: input.sessionId,
      mintAddress: input.candidate.tokenRadar.mintAddress,
      decidedAtMs: input.decidedAtMs,
      decision: input.scoring.decision,
      strategyName: this.options.config.strategyName,
      score: input.scoring.score,
      reason: input.scoring.reason,
      inputSnapshotJson: stringifyJson(buildInputSnapshot(input, this.options.config)),
    });

    const updatedRadarStatus = this.applyTokenRadarStatus(input.candidate, input.scoring);

    return {
      wroteDecision: true,
      updatedRadarStatus,
    };
  }

  private applyTokenRadarStatus(
    candidate: StrategyCandidate,
    scoring: StrategyScoreResult,
  ): boolean {
    if (scoring.decision === "BUY") {
      this.options.repositories.tokenRadar.updateRadarStatus(
        candidate.tokenRadar.id,
        "APPROVED",
        appendStrategyNote(candidate.tokenRadar.notes, scoring),
      );

      return true;
    }

    if (scoring.decision === "WATCH" && candidate.tokenRadar.status !== "WATCHING") {
      this.options.repositories.tokenRadar.updateRadarStatus(
        candidate.tokenRadar.id,
        "WATCHING",
        appendStrategyNote(candidate.tokenRadar.notes, scoring),
      );

      return true;
    }

    return false;
  }

  private writeLog(
    sessionId: string,
    message: string,
    context: unknown,
    level: "ERROR" | "INFO" | "WARN" = "INFO",
  ): void {
    this.options.repositories.systemLogs.createLog({
      sessionId,
      level,
      scope: "STRATEGY",
      message,
      contextJson: stringifyJson(context),
    });
  }
}

interface MutableStrategyCounts {
  evaluatedCount: number;
  writtenCount: number;
  statusUpdatedCount: number;
  buyCount: number;
  watchCount: number;
  skipCount: number;
  holdCount: number;
  sellCount: number;
  duplicateBuyBlockedCount: number;
  maxBuyCapBlockedCount: number;
  errorCount: number;
}

function createEmptyCounts(): MutableStrategyCounts {
  return {
    evaluatedCount: 0,
    writtenCount: 0,
    statusUpdatedCount: 0,
    buyCount: 0,
    watchCount: 0,
    skipCount: 0,
    holdCount: 0,
    sellCount: 0,
    duplicateBuyBlockedCount: 0,
    maxBuyCapBlockedCount: 0,
    errorCount: 0,
  };
}

function incrementDecisionCount(counts: MutableStrategyCounts, decision: StrategyDecision): void {
  switch (decision) {
    case "BUY":
      counts.buyCount += 1;
      break;
    case "WATCH":
      counts.watchCount += 1;
      break;
    case "SKIP":
      counts.skipCount += 1;
      break;
    case "HOLD":
      counts.holdCount += 1;
      break;
    case "SELL":
      counts.sellCount += 1;
      break;
  }
}

function appendStrategyNote(existingNotes: string | null, scoring: StrategyScoreResult): string {
  const note = `Strategy ${scoring.decision} score=${scoring.score}`;

  if (!existingNotes || existingNotes.trim() === "") {
    return note;
  }

  if (existingNotes.includes(note)) {
    return existingNotes;
  }

  return `${existingNotes}\n${note}`;
}

function buildInputSnapshot(
  input: {
    readonly candidate: StrategyCandidate;
    readonly scoring: StrategyScoreResult;
    readonly decidedAtMs: number;
  },
  config: StrategyRuntimeConfig,
): unknown {
  return {
    phase: "PHASE_6_STRATEGY_ENGINE",
    strategyName: config.strategyName,
    decidedAt: new Date(input.decidedAtMs).toISOString(),
    tokenRadar: {
      id: input.candidate.tokenRadar.id,
      mintAddress: input.candidate.tokenRadar.mintAddress,
      symbol: input.candidate.tokenRadar.symbol,
      name: input.candidate.tokenRadar.name,
      pairAddress: input.candidate.tokenRadar.pairAddress,
      source: input.candidate.tokenRadar.source,
      status: input.candidate.tokenRadar.status,
      priceSol: input.candidate.tokenRadar.priceSol,
      priceUsd: input.candidate.tokenRadar.priceUsd,
      liquidityUsd: input.candidate.tokenRadar.liquidityUsd,
      volume5mUsd: input.candidate.tokenRadar.volume5mUsd,
      volume1hUsd: input.candidate.tokenRadar.volume1hUsd,
      ageSeconds: input.candidate.tokenRadar.ageSeconds,
      firstSeenAtMs: input.candidate.tokenRadar.firstSeenAtMs,
      discoveredAtMs: input.candidate.tokenRadar.discoveredAtMs,
      updatedAtMs: input.candidate.tokenRadar.updatedAtMs,
    },
    riskAssessment: {
      id: input.candidate.latestRiskAssessment.id,
      result: input.candidate.latestRiskAssessment.result,
      score: input.candidate.latestRiskAssessment.score,
      riskFlags: input.scoring.facts.riskFlags,
    },
    strategyScore: {
      score: input.scoring.score,
      rawDecision: input.scoring.rawDecision,
      buyScoreThreshold: config.buyScoreThreshold,
      watchScoreThreshold: config.watchScoreThreshold,
      buyEligible: input.scoring.buyEligible,
      duplicateBuyBlocked: input.scoring.duplicateBuyBlocked,
      maxBuyCapBlocked: input.scoring.maxBuyCapBlocked,
      factors: input.scoring.factors,
      facts: input.scoring.facts,
    },
    decision: input.scoring.decision,
    reason: input.scoring.reason,
  };
}
