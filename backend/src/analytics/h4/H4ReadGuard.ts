import type { Repositories } from "../../db/repositories/index.js";
import type { AnalyticsReadRepositories } from "../AnalyticsReadRepositories.js";

const methods = {
  sessions: ["getSessionById", "listSessions"],
  tokenRadar: ["listRadarEntries"],
  riskAssessments: ["listRiskAssessments"],
  strategyDecisions: ["listStrategyDecisions"],
  orders: ["listOrders"],
  fills: ["listFillsForSession"],
  positions: ["listOpenPositions", "listClosedPositions"],
  snapshots: ["listEquitySnapshots"],
  watchlistReturns: ["listObservations"],
  providerHealth: ["listProviderHealth"],
} as const;
export function guardAnalyticsReads(input: Repositories) {
  const calls: {
    readonly repository: string;
    readonly method: string;
    readonly args: readonly unknown[];
  }[] = [];
  const guarded = Object.fromEntries(
    Object.entries(methods).map(([repository, names]) => [
      repository,
      new Proxy(
        {},
        {
          get(_target, method) {
            if (typeof method !== "string" || !(names as readonly string[]).includes(method))
              throw new Error("H4_UNDECLARED_REPOSITORY_ACCESS");
            return (...args: unknown[]) => {
              calls.push({ repository, method, args });
              const target = input[repository as keyof Repositories];
              const fn = Reflect.get(target, method) as (...values: unknown[]) => unknown;
              return Reflect.apply(fn, target, args);
            };
          },
          set() {
            throw new Error("H4_REPOSITORY_WRITE_FORBIDDEN");
          },
        },
      ),
    ]),
  );
  return { repositories: guarded as unknown as AnalyticsReadRepositories, calls };
}
