import type {
  RiskAssessmentRecord,
  SessionRecord,
  StrategyDecisionRecord,
  TokenRadarRecord,
} from "../db/schema/index.js";
import type { Repositories } from "../db/repositories/index.js";
import type { StrategyRuntimeConfig } from "./StrategyConfig.js";

export interface StrategyCandidate {
  readonly tokenRadar: TokenRadarRecord;
  readonly latestRiskAssessment: RiskAssessmentRecord;
  readonly existingDecisions: readonly StrategyDecisionRecord[];
}

export interface StrategyCandidateSelection {
  readonly session: SessionRecord;
  readonly candidates: readonly StrategyCandidate[];
  readonly discoveredFromMs: number;
  readonly missingRiskAssessmentCount: number;
}

interface LoadCandidatesResult {
  readonly candidates: readonly StrategyCandidate[];
  readonly missingRiskAssessmentCount: number;
}

export class StrategyCandidateSelector {
  constructor(
    private readonly repositories: Pick<
      Repositories,
      "sessions" | "tokenRadar" | "riskAssessments" | "strategyDecisions"
    >,
  ) {}

  selectCandidates(config: StrategyRuntimeConfig, nowMs: number): StrategyCandidateSelection {
    const discoveredFromMs = nowMs - config.sinceHours * 60 * 60 * 1000;

    if (config.sessionId) {
      const session = this.resolveExplicitSession(config.sessionId);
      const loaded = this.loadCandidatesForSession(session, config, discoveredFromMs);

      return {
        session,
        candidates: loaded.candidates,
        discoveredFromMs,
        missingRiskAssessmentCount: loaded.missingRiskAssessmentCount,
      };
    }

    for (const session of this.repositories.sessions.getActivePaperSessions()) {
      const loaded = this.loadCandidatesForSession(session, config, discoveredFromMs);

      if (loaded.candidates.length > 0) {
        return {
          session,
          candidates: loaded.candidates,
          discoveredFromMs,
          missingRiskAssessmentCount: loaded.missingRiskAssessmentCount,
        };
      }
    }

    throw new Error(
      `No RUNNING PAPER session has strategy candidates for status ${config.status} with latest RiskAssessment records in the last ${config.sinceHours} hour(s). Run scanner and risk evaluation first or pass --session-id.`,
    );
  }

  private resolveExplicitSession(sessionId: string): SessionRecord {
    const session = this.repositories.sessions.getSessionById(sessionId);

    if (!session) {
      throw new Error(`Strategy evaluation session not found: ${sessionId}`);
    }

    if (session.mode !== "PAPER") {
      throw new Error(
        `Strategy evaluation requires a PAPER session. Session ${sessionId} is ${session.mode}.`,
      );
    }

    if (session.status !== "RUNNING") {
      throw new Error(
        `Strategy evaluation requires a RUNNING session. Session ${sessionId} is ${session.status}.`,
      );
    }

    return session;
  }

  private loadCandidatesForSession(
    session: SessionRecord,
    config: StrategyRuntimeConfig,
    discoveredFromMs: number,
  ): LoadCandidatesResult {
    const tokenRadarRows = this.repositories.tokenRadar.listRadarEntries(session.id, {
      status: config.status,
      discoveredFromMs,
      limit: config.limit,
    });
    const candidates: StrategyCandidate[] = [];
    let missingRiskAssessmentCount = 0;

    for (const tokenRadar of tokenRadarRows) {
      const latestRiskAssessment = this.repositories.riskAssessments.getLatestRiskAssessment(
        session.id,
        tokenRadar.mintAddress,
      );

      if (!latestRiskAssessment) {
        missingRiskAssessmentCount += 1;
        continue;
      }

      candidates.push({
        tokenRadar,
        latestRiskAssessment,
        existingDecisions: this.repositories.strategyDecisions.listDecisionsForMint(
          session.id,
          tokenRadar.mintAddress,
        ),
      });
    }

    return {
      candidates,
      missingRiskAssessmentCount,
    };
  }
}
