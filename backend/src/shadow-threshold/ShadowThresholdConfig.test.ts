import { describe, expect, it } from "vitest";

import { parseShadowThresholdArgs } from "./ShadowThresholdConfig.js";

describe("parseShadowThresholdArgs", () => {
  it("accepts only labeled archive inputs and output formatting options", () => {
    expect(
      parseShadowThresholdArgs([
        "--once",
        "--json",
        "--label-run=Morning:data/archive/phase9.4D/full1",
        "--label-run=Evening:data/archive/phase9.4D/full2",
        "--output-dir=data/archive/phase9.27/smoke",
      ]),
    ).toMatchObject({
      once: true,
      json: true,
      outputDir: "data/archive/phase9.27/smoke",
      runSources: [
        { label: "Morning", path: "data/archive/phase9.4D/full1" },
        { label: "Evening", path: "data/archive/phase9.4D/full2" },
      ],
    });
  });

  it("requires labeled archives and rejects mutable profile options", () => {
    expect(() => parseShadowThresholdArgs(["--once"])).toThrow(/label-run/i);
    expect(() =>
      parseShadowThresholdArgs(["--label-run=A:data/archive/a", "--score-min=64"]),
    ).toThrow(/immutable T65N@v1/i);
    expect(() =>
      parseShadowThresholdArgs(["--label-run=A:data/archive/a", "--label-run=A:data/archive/b"]),
    ).toThrow(/unique/i);
  });
});
