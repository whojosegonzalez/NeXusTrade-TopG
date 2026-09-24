import { describe, expect, it } from "vitest";

import { parseShadowArgs, resolveShadowSourceDecisions } from "./ShadowConfig.js";

describe("ShadowConfig", () => {
  it("parses safe defaults", () => {
    const config = parseShadowArgs(["--once"]);

    expect(config.once).toBe(true);
    expect(config.sourceDecisions).toEqual(["BUY"]);
    expect(config.targetPcts).toEqual([10, 15, 25]);
    expect(config.stopPcts).toEqual([10, 15, 25]);
    expect(config.startingBalanceSol).toBe(1);
    expect(config.positionSizeSol).toBe(0.01);
  });

  it("expands default source decisions when shadow scores are included", () => {
    const config = parseShadowArgs(["--include-shadow-scores"]);

    expect(resolveShadowSourceDecisions(config)).toEqual(["BUY", "WATCH", "SKIP"]);
  });

  it("parses explicit target and stop lists", () => {
    const config = parseShadowArgs([
      "--target-pcts=8,10",
      "--stop-pcts=5,10",
      "--horizons=1,3,5",
      "--max-hold-scenarios-minutes=5,15",
    ]);

    expect(config.targetPcts).toEqual([8, 10]);
    expect(config.stopPcts).toEqual([5, 10]);
    expect(config.horizonsMinutes).toEqual([1, 3, 5]);
    expect(config.maxHoldScenariosMinutes).toEqual([5, 15]);
  });

  it("rejects invalid position sizing", () => {
    expect(() => parseShadowArgs(["--starting-balance-sol=1", "--position-size-sol=2"])).toThrow(
      /positionSizeSol/,
    );
  });
});
