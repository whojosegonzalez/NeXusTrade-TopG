import { describe, expect, it } from "vitest";

import { parseCalibrationArgs } from "./CalibrationConfig.js";

describe("parseCalibrationArgs", () => {
  it("uses conservative calibration defaults", () => {
    const config = parseCalibrationArgs(["--once"]);

    expect(config.once).toBe(true);
    expect(config.json).toBe(false);
    expect(config.targetPcts).toEqual([10, 25, 39]);
    expect(config.drawdownPcts).toEqual([10, 25, 50]);
    expect(config.maxHoldMinutes).toBe(60);
    expect(config.thresholdScenarios.map((scenario) => scenario.buyScoreThreshold)).toEqual([
      90, 75, 75, 65, 55,
    ]);
  });

  it("parses datasets, horizons, decisions, and threshold scenarios", () => {
    const config = parseCalibrationArgs([
      "--json",
      "--label-db=Con75:data/Conservative75_nexus_paper.db",
      "--target-pcts=10,25",
      "--drawdown-pcts=8,20",
      "--horizons=3,5,15",
      "--source-decisions=BUY,SKIP",
      "--threshold-scenarios=75/60,65/55",
    ]);

    expect(config.json).toBe(true);
    expect(config.dbSources).toEqual([
      {
        label: "Con75",
        path: "data/Conservative75_nexus_paper.db",
      },
    ]);
    expect(config.targetPcts).toEqual([10, 25]);
    expect(config.drawdownPcts).toEqual([8, 20]);
    expect(config.horizonsMinutes).toEqual([3, 5, 15]);
    expect(config.sourceDecisions).toEqual(["BUY", "SKIP"]);
    expect(config.thresholdScenarios).toEqual([
      { buyScoreThreshold: 75, watchScoreThreshold: 60 },
      { buyScoreThreshold: 65, watchScoreThreshold: 55 },
    ]);
  });

  it("rejects invalid decision names", () => {
    expect(() => parseCalibrationArgs(["--source-decisions=BUY,NOPE"])).toThrow(
      "valid StrategyDecision values",
    );
  });

  it("rejects threshold scenarios where BUY is lower than WATCH", () => {
    expect(() => parseCalibrationArgs(["--threshold-scenarios=55/65"])).toThrow(
      "buyScoreThreshold must be greater than or equal to watchScoreThreshold",
    );
  });
});
