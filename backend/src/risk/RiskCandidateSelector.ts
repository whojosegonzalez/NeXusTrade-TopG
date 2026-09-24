import type { SessionRecord, TokenRadarRecord } from "../db/schema/index.js";
import type { Repositories } from "../db/repositories/index.js";
import type { RiskRuntimeConfig } from "./RiskConfig.js";

export interface RiskCandidateSelection {
  readonly session: SessionRecord;
  readonly candidates: readonly TokenRadarRecord[];
  readonly discoveredFromMs: number;
}

export class RiskCandidateSelector {
  constructor(private readonly repositories: Pick<Repositories, "sessions" | "tokenRadar">) {}

  selectCandidates(config: RiskRuntimeConfig, nowMs: number): RiskCandidateSelection {
    const discoveredFromMs = nowMs - config.sinceHours * 60 * 60 * 1000;
    const session = config.sessionId
      ? this.resolveExplicitSession(config.sessionId)
      : this.resolveLatestRunningSessionWithCandidates(config, discoveredFromMs);
    const candidates = this.repositories.tokenRadar.listRadarEntries(session.id, {
      statuses: config.statuses,
      discoveredFromMs,
      limit: config.limit,
    });

    return {
      session,
      candidates,
      discoveredFromMs,
    };
  }

  private resolveExplicitSession(sessionId: string): SessionRecord {
    const session = this.repositories.sessions.getSessionById(sessionId);

    if (!session) {
      throw new Error(`Risk evaluation session not found: ${sessionId}`);
    }

    if (session.mode !== "PAPER") {
      throw new Error(
        `Risk evaluation requires a PAPER session. Session ${sessionId} is ${session.mode}.`,
      );
    }

    return session;
  }

  private resolveLatestRunningSessionWithCandidates(
    config: RiskRuntimeConfig,
    discoveredFromMs: number,
  ): SessionRecord {
    for (const session of this.repositories.sessions.getActivePaperSessions()) {
      const candidate = this.repositories.tokenRadar.listRadarEntries(session.id, {
        statuses: config.statuses,
        discoveredFromMs,
        limit: 1,
      })[0];

      if (candidate) {
        return session;
      }
    }

    throw new Error(
      `No RUNNING PAPER session has TokenRadar candidates for statuses ${config.statuses.join(
        ",",
      )} in the last ${config.sinceHours} hour(s). Run scanner discovery first or pass --session-id.`,
    );
  }
}
