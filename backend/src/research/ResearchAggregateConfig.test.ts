import { describe, expect, it } from "vitest";

import { parseResearchAggregateArgs } from "./ResearchAggregateConfig.js";

describe("parseResearchAggregateArgs", () => {
  it("parses Phase 9.1 run sources and promotion options", () => {
    const config = parseResearchAggregateArgs([
      "--once",
      "--label-run=T1:data/archive/phase9/test1",
      "--label-run=T2:data/archive/phase9/test2",
      "--output-dir=data/phase9.1-reports",
      "--min-runs=2",
      "--min-unique-mints=12",
      "--min-observed-decisions=150",
      "--max-single-run-win-share-pct=35",
      "--target-pcts=10,25",
      "--stop-pcts=10,20",
      "--max-hold-minutes=15,60",
      "--min-score=55",
      "--source-decisions=BUY,WATCH",
    ]);

    expect(config.once).toBe(true);
    expect(config.runSources).toEqual([
      { label: "T1", path: "data/archive/phase9/test1" },
      { label: "T2", path: "data/archive/phase9/test2" },
    ]);
    expect(config.outputDir).toBe("data/phase9.1-reports");
    expect(config.minRuns).toBe(2);
    expect(config.minUniqueMintsForPromotion).toBe(12);
    expect(config.minObservedDecisionsForPromotion).toBe(150);
    expect(config.maxSingleRunWinSharePct).toBe(35);
    expect(config.targetPcts).toEqual([10, 25]);
    expect(config.stopPcts).toEqual([10, 20]);
    expect(config.maxHoldMinutes).toEqual([15, 60]);
    expect(config.minScore).toBe(55);
    expect(config.sourceDecisions).toEqual(["BUY", "WATCH"]);
  });

  it("requires at least one labeled run", () => {
    expect(() => parseResearchAggregateArgs(["--once"])).toThrow(/runSources/i);
  });

  it("rejects duplicate run labels", () => {
    expect(() =>
      parseResearchAggregateArgs([
        "--label-run=T1:data/archive/phase9/test1",
        "--label-run=T1:data/archive/phase9/test2",
      ]),
    ).toThrow(/duplicate run label/i);
  });
});
