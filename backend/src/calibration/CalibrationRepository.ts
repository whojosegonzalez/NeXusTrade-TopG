import type { Repositories } from "../db/repositories/index.js";
import type { SessionRecord } from "../db/schema/index.js";
import type { CalibrationRuntimeConfig } from "./CalibrationConfig.js";
import type { CalibrationRawDataset } from "./CalibrationTypes.js";

const MAX_CALIBRATION_ROWS = 10_000;

export class CalibrationRepository {
  constructor(
    private readonly options: {
      readonly label: string;
      readonly path: string;
      readonly repositories: Repositories;
    },
  ) {}

  load(config: CalibrationRuntimeConfig): CalibrationRawDataset {
    const session = this.resolveSession(config.sessionId);
    const sessionProviderHealth = this.options.repositories.providerHealth.listProviderHealth({
      sessionId: session.id,
      limit: MAX_CALIBRATION_ROWS,
    });

    return {
      label: this.options.label,
      path: this.options.path,
      session,
      strategyDecisions: this.options.repositories.strategyDecisions.listStrategyDecisions(
        session.id,
        { limit: MAX_CALIBRATION_ROWS },
      ),
      watchlistReturns: this.options.repositories.watchlistReturns.listObservations(session.id, {
        limit: MAX_CALIBRATION_ROWS,
      }),
      riskAssessments: this.options.repositories.riskAssessments.listRiskAssessments(session.id, {
        limit: MAX_CALIBRATION_ROWS,
      }),
      tokenRadar: this.options.repositories.tokenRadar.listRadarEntries(session.id, {
        limit: MAX_CALIBRATION_ROWS,
      }),
      providerHealth:
        sessionProviderHealth.length > 0
          ? sessionProviderHealth
          : this.options.repositories.providerHealth.listProviderHealth({
              limit: MAX_CALIBRATION_ROWS,
            }),
    };
  }

  private resolveSession(sessionId: string | undefined): SessionRecord {
    if (sessionId) {
      const session = this.options.repositories.sessions.getSessionById(sessionId);

      if (!session) {
        throw new Error(`Calibration session not found: ${sessionId}`);
      }

      if (session.mode !== "PAPER") {
        throw new Error(
          `Calibration requires a PAPER session. Session ${session.id} is ${session.mode}.`,
        );
      }

      return session;
    }

    for (const session of this.options.repositories.sessions.listSessions({
      mode: "PAPER",
      limit: 100,
    })) {
      const hasDecisions =
        this.options.repositories.strategyDecisions.listStrategyDecisions(session.id, {
          limit: 1,
        }).length > 0;
      const hasReturns =
        this.options.repositories.watchlistReturns.listObservations(session.id, {
          limit: 1,
        }).length > 0;

      if (hasDecisions || hasReturns) {
        return session;
      }
    }

    throw new Error(
      "No PAPER session with StrategyDecision or watchlist return rows was found. Run strategy/watchlist first or pass --session-id.",
    );
  }
}
