import { describe, expect, it } from "vitest";
import { readQuoteBudgetProjection, readStrategyProjection } from "../AnalyticsJsonReaders.js";
import { buildQuoteBudgetReport } from "../AnalyticsQuoteBudget.js";

describe("H4 legacy reader contract", () => {
  it.each([null, "", "{", "[]", "null", "5", '"text"'])(
    "bounds missing/invalid input %s",
    (raw) => {
      const strategy = readStrategyProjection(raw),
        quote = readQuoteBudgetProjection(raw);
      expect(strategy.value.riskFlags).toEqual([]);
      expect(strategy.value.blockingFactors).toEqual([]);
      expect(quote.value).toBeUndefined();
      expect(strategy.status).toBe(
        raw === null || raw === "" ? "MISSING" : raw === "{" ? "MALFORMED_JSON" : "INVALID_FIELDS",
      );
    },
  );
  it("refuses unknown interpretation versions before parsing", () => {
    expect(readStrategyProjection('{"secret":"private"}', 1)).toEqual({
      status: "UNSUPPORTED_VERSION",
      value: { riskFlags: [], blockingFactors: [] },
    });
    expect(readQuoteBudgetProjection("{", -1)).toEqual({
      status: "UNSUPPORTED_VERSION",
      value: undefined,
    });
  });
  it("retains valid optional fields and exact legacy string/number/array rules", () => {
    const result = readStrategyProjection(
      JSON.stringify({
        tokenRadar: { symbol: " SOL ", liquidityUsd: "100", volume1hUsd: 100, ageSeconds: "2" },
        riskAssessment: { result: "WARN", riskFlags: ["", "A", 5] },
        strategyScore: {
          facts: { maxPriceImpactPct: 1.2 },
          factors: [
            { passed: false, name: "named" },
            { passed: false, rule: "fallback" },
            { passed: false },
            { passed: true, name: "ignored" },
            null,
          ],
        },
        extra: "ignored",
      }),
    );
    expect(result.status).toBe("INVALID_FIELDS");
    expect(result.value).toEqual({
      symbol: " SOL ",
      riskResult: "WARN",
      riskFlags: ["", "A"],
      blockingFactors: ["named", "fallback", "unknown_rule"],
      liquidityUsd: "100",
      volume1hUsd: undefined,
      ageSeconds: undefined,
      maxPriceImpactPct: 1.2,
    });
  });
  it("rejects unusable required quote fields but salvages optional defects", () => {
    expect(
      readQuoteBudgetProjection('{"quoteBudget":{"selected":"true","selectionReason":"SELECTED"}}')
        .value,
    ).toBeUndefined();
    const result = readQuoteBudgetProjection(
      '{"quoteBudget":{"selected":true,"selectionReason":" SELECTED ","rank":"1","candidateSignals":["",1,"A"]},"enrichment":{"buyQuote":{}}}',
    );
    expect(result.status).toBe("INVALID_FIELDS");
    expect(result.value).toEqual({
      selected: true,
      selectionReason: " SELECTED ",
      rank: undefined,
      candidateSignals: ["", "A"],
      buyQuoteObserved: true,
    });
  });
  it("keeps finite numbers only and emits no payload in diagnostic codes", () => {
    const result = readStrategyProjection(
      '{"tokenRadar":{"ageSeconds":1e999,"symbol":"valid"},"secret":"never disclose"}',
    );
    expect(result.value.ageSeconds).toBeUndefined();
    expect(result.value.symbol).toBe("valid");
    expect(result.status).toBe("INVALID_FIELDS");
    expect(JSON.stringify(result)).not.toContain("never disclose");
  });
  it("computes independent counts at every legacy rank boundary", () => {
    const rows = [0, 5, 6, 10, 11, 20, 21].map((rank, i) => ({
      selected: i % 2 === 0,
      selectionReason: "X",
      rank,
      candidateSignals: ["A", "A"],
      buyQuoteObserved: true,
    }));
    expect(buildQuoteBudgetReport([...rows, undefined])).toEqual({
      assessmentsWithPlan: 7,
      selectedCount: 4,
      notSelectedCount: 3,
      skippedLiveCallsEstimate: 3,
      selectionReasonCounts: { X: 7 },
      signalCounts: { A: 14 },
      rankBucketCounts: { "1-5": 2, "6-10": 2, "11-20": 2, "21+": 1 },
      quoteSuccessCount: 4,
    });
    expect(buildQuoteBudgetReport([]).assessmentsWithPlan).toBe(0);
  });
});
