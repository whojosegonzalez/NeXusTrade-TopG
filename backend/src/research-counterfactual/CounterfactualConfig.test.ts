import { describe, expect, it } from "vitest";

import { parseCounterfactualArgs } from "./CounterfactualConfig.js";

describe("parseCounterfactualArgs", () => {
  it("parses archive-only replay options", () => {
    expect(
      parseCounterfactualArgs([
        "--once",
        "--json",
        "--label-run=A:data/archive/phase9.4D/full1",
        "--label-run=B:data/archive/phase9.4D/full2",
        "--output-dir=data/archive/phase9.26/smoke",
        "--min-score=55",
        "--source-decisions=SKIP,WATCH",
        "--target-pcts=10,25",
        "--stop-pcts=10,20",
        "--max-hold-minutes=15,60",
        "--dedupe-mode=best_per_mint",
        "--scenario-set=gates",
        "--scenarios=RISK_ELIGIBILITY_OVERRIDE,PRICE_IMPACT_GATE_OVERRIDE",
        "--top-results=10",
      ]),
    ).toMatchObject({
      once: true,
      json: true,
      minScore: 55,
      sourceDecisions: ["SKIP", "WATCH"],
      targetPcts: [10, 25],
      stopPcts: [10, 20],
      maxHoldMinutes: [15, 60],
      dedupeMode: "best_per_mint",
      scenarioSet: "gates",
      scenarioIds: ["RISK_ELIGIBILITY_OVERRIDE", "PRICE_IMPACT_GATE_OVERRIDE"],
      topResults: 10,
    });
  });

  it("requires labeled archives and rejects unknown scenarios", () => {
    expect(() => parseCounterfactualArgs(["--once"])).toThrow(/label-run/i);
    expect(() =>
      parseCounterfactualArgs(["--label-run=A:data/archive/a", "--scenarios=NOT_A_SCENARIO"]),
    ).toThrow(/known IDs/i);
  });
});
