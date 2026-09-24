import type { Repositories } from "../db/repositories/index.js";
/** A compile-time read surface, not a runtime security sandbox. */
export interface AnalyticsReadRepositories {
  readonly sessions: Readonly<Pick<Repositories["sessions"], "getSessionById" | "listSessions">>;
  readonly tokenRadar: Readonly<Pick<Repositories["tokenRadar"], "listRadarEntries">>;
  readonly riskAssessments: Readonly<Pick<Repositories["riskAssessments"], "listRiskAssessments">>;
  readonly strategyDecisions: Readonly<
    Pick<Repositories["strategyDecisions"], "listStrategyDecisions">
  >;
  readonly orders: Readonly<Pick<Repositories["orders"], "listOrders">>;
  readonly fills: Readonly<Pick<Repositories["fills"], "listFillsForSession">>;
  readonly positions: Readonly<
    Pick<Repositories["positions"], "listOpenPositions" | "listClosedPositions">
  >;
  readonly snapshots: Readonly<Pick<Repositories["snapshots"], "listEquitySnapshots">>;
  readonly watchlistReturns: Readonly<Pick<Repositories["watchlistReturns"], "listObservations">>;
  readonly providerHealth: Readonly<Pick<Repositories["providerHealth"], "listProviderHealth">>;
}
