import type { Repositories } from "../db/repositories/index.js";
import type { SessionRecord } from "../db/schema/index.js";
import type { SessionManagerRuntimeConfig } from "./SessionManagerConfig.js";

export class SessionCandidateSelector {
  constructor(private readonly repositories: Pick<Repositories, "sessions">) {}

  selectSession(config: SessionManagerRuntimeConfig): SessionRecord {
    if (config.sessionId) {
      return this.resolveExplicitSession(config.sessionId);
    }

    const session = this.repositories.sessions.getLatestRunningPaperSession();

    if (!session) {
      throw new Error("NO_RUNNING_PAPER_SESSION: no PAPER session with status RUNNING exists.");
    }

    return session;
  }

  private resolveExplicitSession(sessionId: string): SessionRecord {
    const session = this.repositories.sessions.getSessionById(sessionId);

    if (!session) {
      throw new Error(`SESSION_NOT_FOUND: SessionManager session not found: ${sessionId}`);
    }

    if (session.mode !== "PAPER") {
      throw new Error(
        `SESSION_NOT_PAPER: SessionManager requires a PAPER session. Session ${sessionId} is ${session.mode}.`,
      );
    }

    if (session.status !== "RUNNING") {
      throw new Error(
        `SESSION_NOT_RUNNING: SessionManager requires a RUNNING session. Session ${sessionId} is ${session.status}.`,
      );
    }

    return session;
  }
}
