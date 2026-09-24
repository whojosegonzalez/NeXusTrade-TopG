import type { Repositories } from "../db/repositories/index.js";
import type { SessionRecord, TerminationReason } from "../db/schema/index.js";
import type { ExitManagerRuntimeConfig } from "./ExitManagerConfig.js";

export interface ExitSessionSelection {
  readonly session: SessionRecord;
  readonly openPositionCount: number;
}

export class ExitCandidateSelector {
  constructor(private readonly repositories: Pick<Repositories, "sessions" | "positions">) {}

  selectSession(config: ExitManagerRuntimeConfig): ExitSessionSelection {
    if (config.sessionId) {
      const session = this.resolveExplicitSession(config.sessionId);

      return {
        session,
        openPositionCount: this.repositories.positions.listOpenPositions(session.id).length,
      };
    }

    const eligible = this.repositories.sessions
      .getActivePaperSessions()
      .filter((session) => isSupportedExitReason(session.terminationReason));

    for (const session of eligible) {
      const openPositionCount = this.repositories.positions.listOpenPositions(session.id).length;

      if (openPositionCount > 0) {
        return {
          session,
          openPositionCount,
        };
      }
    }

    const session = eligible[0];

    if (session) {
      return {
        session,
        openPositionCount: this.repositories.positions.listOpenPositions(session.id).length,
      };
    }

    throw new Error(
      "NO_GATED_RUNNING_PAPER_SESSION: no RUNNING PAPER session has a supported Phase 8.5 exit trigger.",
    );
  }

  private resolveExplicitSession(sessionId: string): SessionRecord {
    const session = this.repositories.sessions.getSessionById(sessionId);

    if (!session) {
      throw new Error(`SESSION_NOT_FOUND: exit manager session not found: ${sessionId}`);
    }

    if (session.mode !== "PAPER") {
      throw new Error(
        `SESSION_NOT_PAPER: ExitManager requires a PAPER session. Session ${sessionId} is ${session.mode}.`,
      );
    }

    if (session.status !== "RUNNING") {
      throw new Error(
        `SESSION_NOT_RUNNING: ExitManager requires a RUNNING session. Session ${sessionId} is ${session.status}.`,
      );
    }

    if (session.terminationReason === "NOT_TERMINATED") {
      throw new Error(
        `SESSION_NOT_GATED: ExitManager requires a gated session. Session ${sessionId} terminationReason=NOT_TERMINATED.`,
      );
    }

    return session;
  }
}

function isSupportedExitReason(reason: TerminationReason): boolean {
  return reason === "TARGET_REACHED" || reason === "MAX_DRAWDOWN";
}
