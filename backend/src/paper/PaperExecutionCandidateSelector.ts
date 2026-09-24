import type {
  RiskAssessmentRecord,
  SessionRecord,
  StrategyDecisionRecord,
  TokenRadarRecord,
} from "../db/schema/index.js";
import type { Repositories } from "../db/repositories/index.js";
import type { PaperExchangeRuntimeConfig } from "./PaperExchangeConfig.js";

export interface PaperExecutionCandidate {
  readonly tokenRadar: TokenRadarRecord;
  readonly strategyDecision: StrategyDecisionRecord;
  readonly latestRiskAssessment?: RiskAssessmentRecord;
}

export interface PaperExecutionCandidateSelection {
  readonly session: SessionRecord;
  readonly candidates: readonly PaperExecutionCandidate[];
  readonly missingRiskAssessmentCount: number;
}

export class PaperExecutionCandidateSelector {
  constructor(
    private readonly repositories: Pick<
      Repositories,
      "sessions" | "tokenRadar" | "strategyDecisions" | "riskAssessments"
    >,
  ) {}

  selectCandidates(config: PaperExchangeRuntimeConfig): PaperExecutionCandidateSelection {
    if (config.sessionId) {
      const session = this.resolveExplicitSession(config.sessionId);

      return {
        session,
        ...this.loadCandidatesForSession(session, config),
      };
    }

    for (const session of this.repositories.sessions.getActivePaperSessions()) {
      if (isBuyGated(session)) {
        continue;
      }

      const loaded = this.loadCandidatesForSession(session, config);

      if (loaded.candidates.length > 0) {
        return {
          session,
          ...loaded,
        };
      }
    }

    throw new Error(
      "No ungated RUNNING PAPER session has approved paper execution candidates. Run scanner, risk, and strategy first or pass --session-id.",
    );
  }

  private resolveExplicitSession(sessionId: string): SessionRecord {
    const session = this.repositories.sessions.getSessionById(sessionId);

    if (!session) {
      throw new Error(`Paper execution session not found: ${sessionId}`);
    }

    if (session.mode !== "PAPER") {
      throw new Error(
        `Paper execution requires a PAPER session. Session ${sessionId} is ${session.mode}.`,
      );
    }

    if (session.status !== "RUNNING") {
      throw new Error(
        `Paper execution requires a RUNNING session. Session ${sessionId} is ${session.status}.`,
      );
    }

    if (isBuyGated(session)) {
      throw new Error(
        `SESSION_BUY_GATED: Paper BUY is gated for session ${sessionId}: terminationReason=${session.terminationReason}.`,
      );
    }

    return session;
  }

  private loadCandidatesForSession(
    session: SessionRecord,
    config: PaperExchangeRuntimeConfig,
  ): Omit<PaperExecutionCandidateSelection, "session"> {
    const approvedRadarRows = this.repositories.tokenRadar.listRadarEntries(session.id, {
      status: "APPROVED",
      limit: Math.min(config.limit * 5, 250),
    });
    const candidates: PaperExecutionCandidate[] = [];
    const seenMints = new Set<string>();
    let missingRiskAssessmentCount = 0;

    for (const tokenRadar of approvedRadarRows) {
      if (seenMints.has(tokenRadar.mintAddress)) {
        continue;
      }

      const strategyDecision = this.repositories.strategyDecisions
        .listDecisionsForMint(session.id, tokenRadar.mintAddress)
        .find((decision) => decision.decision === "BUY");

      if (!strategyDecision) {
        continue;
      }

      const latestRiskAssessment = this.repositories.riskAssessments.getLatestRiskAssessment(
        session.id,
        tokenRadar.mintAddress,
      );

      if (!latestRiskAssessment) {
        missingRiskAssessmentCount += 1;
      }

      seenMints.add(tokenRadar.mintAddress);
      candidates.push({
        tokenRadar,
        strategyDecision,
        ...(latestRiskAssessment ? { latestRiskAssessment } : {}),
      });

      if (candidates.length >= config.limit) {
        break;
      }
    }

    return {
      candidates,
      missingRiskAssessmentCount,
    };
  }
}

function isBuyGated(session: SessionRecord): boolean {
  return session.terminationReason !== "NOT_TERMINATED";
}
