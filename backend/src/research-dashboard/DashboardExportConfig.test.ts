import { describe, expect, it } from "vitest";

import {
  parseDashboardExportArgs,
  resolveDashboardArchiveRoot,
  resolveDashboardOutputDir,
} from "./DashboardExportConfig.js";

const validArgs = [
  "--archive-root=data/archive",
  "--include-phase=phase9.28",
  "--include-phase=phase9.29",
  "--include-cohort=phase9.29/combined-valid-three-20260818-1539",
  "--output-dir=frontend/public/research-dashboard-data/test-output",
];

describe("parseDashboardExportArgs", () => {
  it("requires an explicit, bounded archive selection", () => {
    expect(() => parseDashboardExportArgs([])).toThrow("--archive-root");
    expect(() =>
      parseDashboardExportArgs(validArgs.filter((arg) => !arg.startsWith("--include-phase"))),
    ).toThrow("--include-phase");
    expect(() => parseDashboardExportArgs([...validArgs, "--include-phase=phase9.28"])).toThrow(
      "unique",
    );
    expect(() => parseDashboardExportArgs([...validArgs, "--archive-root=data/archive"])).toThrow(
      "exactly one --archive-root",
    );
    expect(() =>
      parseDashboardExportArgs([
        ...validArgs,
        "--output-dir=frontend/public/research-dashboard-data/other-output",
      ]),
    ).toThrow("exactly one --output-dir");
  });

  it("rejects active, network, and traversal-shaped inputs", () => {
    expect(() => parseDashboardExportArgs([...validArgs, "--provider=JUPITER"])).toThrow(
      "active-runtime or network",
    );
    expect(() => parseDashboardExportArgs([...validArgs, "--url=https://example.test"])).toThrow(
      "active-runtime or network",
    );
    expect(() =>
      parseDashboardExportArgs([
        ...validArgs.filter((arg) => !arg.startsWith("--include-cohort")),
        "--include-cohort=phase9.29/../outside",
      ]),
    ).toThrow("direct-archive-directory");
    expect(() =>
      parseDashboardExportArgs([...validArgs, "--include-phase=phase9.28/child"]),
    ).toThrow("direct canonical phase name");
    expect(() => parseDashboardExportArgs([...validArgs, "--unknown=value"])).toThrow(
      "Unknown dashboard export option",
    );
  });

  it("retains the explicit phase and cohort allowlists", () => {
    expect(parseDashboardExportArgs(validArgs)).toEqual({
      archiveRoot: "data/archive",
      includePhases: ["phase9.28", "phase9.29"],
      includeCohorts: ["phase9.29/combined-valid-three-20260818-1539"],
      outputDir: "frontend/public/research-dashboard-data/test-output",
    });
  });

  it("contains archive and generated-output paths", () => {
    expect(resolveDashboardArchiveRoot("data/archive")).toMatch(/data[\\/]archive$/);
    expect(() => resolveDashboardArchiveRoot("data/nexus_paper.db")).toThrow("canonical");
    expect(
      resolveDashboardOutputDir("frontend/public/research-dashboard-data/test-output"),
    ).toMatch(/research-dashboard-data[\\/]test-output$/);
    expect(() => resolveDashboardOutputDir("data/archive")).toThrow("must stay under");
    expect(() =>
      resolveDashboardOutputDir("frontend/public/research-dashboard-data/../../outside"),
    ).toThrow("must stay under");
  });
});
