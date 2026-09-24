import type { PositionRecord, SessionRecord, TokenRadarRecord } from "../db/schema/index.js";
import type { Repositories } from "../db/repositories/index.js";
import type { PaperSellRuntimeConfig } from "./PaperSellConfig.js";

export interface PaperSellCandidate {
  readonly session: SessionRecord;
  readonly position: PositionRecord;
  readonly tokenRadar?: TokenRadarRecord;
}

export interface PaperSellCandidateSelection {
  readonly session: SessionRecord;
  readonly candidates: readonly PaperSellCandidate[];
  readonly triggerType: PaperSellRuntimeConfig["trigger"]["type"];
}

export class PaperSellCandidateSelector {
  constructor(
    private readonly repositories: Pick<Repositories, "sessions" | "positions" | "tokenRadar">,
  ) {}

  selectCandidates(config: PaperSellRuntimeConfig): PaperSellCandidateSelection {
    if (config.sessionId) {
      const session = this.resolveExplicitSession(config.sessionId);
      const candidates = this.loadCandidatesForSession(session, config);

      if (candidates.length === 0) {
        throw new Error(
          `No OPEN positions match the Phase 7.5 sell trigger in session ${session.id}.`,
        );
      }

      return {
        session,
        candidates,
        triggerType: config.trigger.type,
      };
    }

    for (const session of this.repositories.sessions.getActivePaperSessions()) {
      const candidates = this.loadCandidatesForSession(session, config);

      if (candidates.length > 0) {
        return {
          session,
          candidates,
          triggerType: config.trigger.type,
        };
      }
    }

    throw new Error(
      "No RUNNING PAPER session has OPEN positions matching the explicit sell trigger.",
    );
  }

  private resolveExplicitSession(sessionId: string): SessionRecord {
    const session = this.repositories.sessions.getSessionById(sessionId);

    if (!session) {
      throw new Error(`Paper sell session not found: ${sessionId}`);
    }

    if (session.mode !== "PAPER") {
      throw new Error(
        `Paper sell requires a PAPER session. Session ${sessionId} is ${session.mode}.`,
      );
    }

    if (session.status !== "RUNNING") {
      throw new Error(
        `Paper sell requires a RUNNING session. Session ${sessionId} is ${session.status}.`,
      );
    }

    return session;
  }

  private loadCandidatesForSession(
    session: SessionRecord,
    config: PaperSellRuntimeConfig,
  ): PaperSellCandidate[] {
    const openPositions = this.repositories.positions.listOpenPositions(session.id);

    let matchingPositions = openPositions;

    if (config.trigger.type === "MINT") {
      const mintAddress = config.trigger.mintAddress;

      matchingPositions = openPositions.filter((position) => position.mintAddress === mintAddress);

      if (matchingPositions.length > 1) {
        throw new Error(
          `AMBIGUOUS_MINT_POSITION: found ${matchingPositions.length} open positions for mint ${mintAddress} in session ${session.id}.`,
        );
      }
    }

    return matchingPositions.slice(0, config.limit).map((position) => {
      const tokenRadar = this.repositories.tokenRadar.findRadarEntryByMint(
        session.id,
        position.mintAddress,
      );

      return {
        session,
        position,
        ...(tokenRadar ? { tokenRadar } : {}),
      };
    });
  }
}
