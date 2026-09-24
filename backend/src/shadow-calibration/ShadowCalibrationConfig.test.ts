import { describe, expect, it } from "vitest";

import { parseShadowCalibrationArgs } from "./ShadowCalibrationConfig.js";

describe("parseShadowCalibrationArgs", () => {
  it("parses Phase 8.91 source and scenario options", () => {
    const config = parseShadowCalibrationArgs([
      "--once",
      "--label-db=RunA:data/archive/run-a",
      "--label-db=RunB:data/archive/run-b/nexus_paper.db",
      "--target-pcts=10,15",
      "--stop-pcts=10,25",
      "--max-hold-minutes=15,60",
      "--confirmation-horizons=1,3",
      "--confirmation-min-return-pcts=0,2",
      "--confirmation-max-drawdown-pcts=5,10",
      "--min-score=50",
      "--source-decisions=BUY,WATCH,SKIP",
      "--dedupe-mode=mint_best_entry",
      "--portfolio-starting-sol=1",
      "--portfolio-position-size-sol=0.01",
      "--portfolio-goal-pct=25",
      "--portfolio-max-positions=4",
    ]);

    expect(config.once).toBe(true);
    expect(config.dbSources).toEqual([
      {
        label: "RunA",
        path: "data/archive/run-a",
      },
      {
        label: "RunB",
        path: "data/archive/run-b/nexus_paper.db",
      },
    ]);
    expect(config.targetPcts).toEqual([10, 15]);
    expect(config.stopPcts).toEqual([10, 25]);
    expect(config.maxHoldMinutes).toEqual([15, 60]);
    expect(config.confirmationHorizonsMinutes).toEqual([1, 3]);
    expect(config.confirmationMinReturnPcts).toEqual([0, 2]);
    expect(config.confirmationMaxDrawdownPcts).toEqual([5, 10]);
    expect(config.dedupeMode).toBe("mint_best_entry");
    expect(config.portfolioMaxPositions).toBe(4);
  });

  it("rejects duplicate source labels", () => {
    expect(() =>
      parseShadowCalibrationArgs([
        "--label-db=RunA:data/archive/run-a",
        "--label-db=RunA:data/archive/run-b",
      ]),
    ).toThrow(/duplicate database label/i);
  });

  it("rejects impossible portfolio sizing", () => {
    expect(() =>
      parseShadowCalibrationArgs(["--portfolio-starting-sol=1", "--portfolio-position-size-sol=2"]),
    ).toThrow(/must not exceed/i);
  });
});
