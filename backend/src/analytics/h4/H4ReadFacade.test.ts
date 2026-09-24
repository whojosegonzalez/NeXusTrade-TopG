import { describe, expect, it } from "vitest";
import type { AnalyticsReadRepositories } from "../AnalyticsReadRepositories.js";
import { buildQuoteBudgetReport } from "../AnalyticsQuoteBudget.js";

// Compiled, never executed: widening this surface makes the expected errors fail typecheck.
function forbiddenWrites(repositories: AnalyticsReadRepositories) {
  // @ts-expect-error Analytics cannot create sessions.
  repositories.sessions.createSession({});
  // @ts-expect-error Analytics cannot mutate cash.
  repositories.sessions.updateSession({});
  // @ts-expect-error No raw database handle exists on the facade.
  void repositories.db;
  // @ts-expect-error Pure calculator accepts projected facts, never repositories.
  buildQuoteBudgetReport(repositories);
}
describe("H4 read facade", () => {
  it("keeps compile-time negative fixtures without executing writes", () => {
    expect(typeof forbiddenWrites).toBe("function");
  });
});
