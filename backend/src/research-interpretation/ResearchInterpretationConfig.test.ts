import { describe, expect, it } from "vitest";

import { parseResearchInterpretationArgs } from "./ResearchInterpretationConfig.js";

describe("parseResearchInterpretationArgs", () => {
  it("parses Phase 9.25 research interpretation options", () => {
    const config = parseResearchInterpretationArgs([
      "--once",
      "--json",
      "--label-run=T1:data/archive/phase9.2B/test1",
      "--label-run=T2:data/archive/phase9.2B/test2",
      "--output-dir=data/phase9.25",
      "--min-score=55",
      "--source-decisions=BUY,WATCH",
      "--target-pcts=10,25",
      "--stop-pcts=10,20",
      "--max-hold-minutes=15,60",
      "--top-opportunities=10",
      "--top-blockers=8",
      "--market-window-minutes=30",
      "--score-bucket-size=10",
      "--dedupe-mode=best_per_mint",
    ]);

    expect(config.once).toBe(true);
    expect(config.json).toBe(true);
    expect(config.runSources).toEqual([
      { label: "T1", path: "data/archive/phase9.2B/test1" },
      { label: "T2", path: "data/archive/phase9.2B/test2" },
    ]);
    expect(config.outputDir).toBe("data/phase9.25");
    expect(config.minScore).toBe(55);
    expect(config.sourceDecisions).toEqual(["BUY", "WATCH"]);
    expect(config.targetPcts).toEqual([10, 25]);
    expect(config.stopPcts).toEqual([10, 20]);
    expect(config.maxHoldMinutes).toEqual([15, 60]);
    expect(config.topOpportunities).toBe(10);
    expect(config.topBlockers).toBe(8);
    expect(config.marketWindowMinutes).toBe(30);
    expect(config.scoreBucketSize).toBe(10);
    expect(config.dedupeMode).toBe("best_per_mint");
  });

  it("requires at least one labeled run", () => {
    expect(() => parseResearchInterpretationArgs(["--once"])).toThrow(/runSources/i);
  });

  it("rejects duplicate labels and invalid dedupe modes", () => {
    expect(() =>
      parseResearchInterpretationArgs([
        "--label-run=T1:data/archive/one",
        "--label-run=T1:data/archive/two",
      ]),
    ).toThrow(/duplicate run label/i);

    expect(() =>
      parseResearchInterpretationArgs(["--label-run=T1:data/archive/one", "--dedupe-mode=maybe"]),
    ).toThrow(/dedupe-mode/i);
  });
});
