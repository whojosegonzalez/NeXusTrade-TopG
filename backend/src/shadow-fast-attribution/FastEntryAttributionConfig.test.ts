import { describe, expect, it } from "vitest";

import { parseFastEntryAttributionArgs } from "./FastEntryAttributionConfig.js";

describe("parseFastEntryAttributionArgs", () => {
  it("accepts only labeled archive sources and report options", () => {
    expect(
      parseFastEntryAttributionArgs([
        "--once",
        "--json",
        "--label-run=T1:data/archive/phase9.28/test1",
        "--output-dir=data/archive/phase9.29/smoke",
      ]),
    ).toEqual({
      once: true,
      json: true,
      runSources: [{ label: "T1", path: "data/archive/phase9.28/test1" }],
      outputDir: "data/archive/phase9.29/smoke",
    });
  });

  it("rejects active runtime, execution, and override options", () => {
    for (const option of [
      "--db=x",
      "--session-id=x",
      "--provider=JUPITER",
      "--score=65",
      "--wallet",
      "--submit",
    ]) {
      expect(() =>
        parseFastEntryAttributionArgs(["--label-run=T1:data/archive/phase9.28/test1", option]),
      ).toThrow("rejects active-runtime or override option");
    }
  });

  it("requires unique labels and archive paths", () => {
    expect(() => parseFastEntryAttributionArgs(["--label-run=T1:not-an-archive"])).toThrow(
      "under data/archive",
    );
    expect(() =>
      parseFastEntryAttributionArgs([
        "--label-run=T1:data/archive/a",
        "--label-run=T1:data/archive/b",
      ]),
    ).toThrow("labels must be unique");
  });
});
