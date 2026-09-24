import path from "node:path";

import { describe, expect, it } from "vitest";

import { getRepoRoot } from "../db/utils/paths.js";
import { ArchiveCatalogBuilder } from "./ArchiveCatalogBuilder.js";

const archiveRoot = path.join(getRepoRoot(), "data", "archive");

describe("ArchiveCatalogBuilder", () => {
  it("discovers direct canonical archives deterministically and excludes cleanup copies", () => {
    const catalog = new ArchiveCatalogBuilder({
      archiveRoot,
      includePhases: ["phase9.28"],
      includeCohorts: [],
    });

    expect(catalog.validateIncludedPhases()).toEqual(["phase9.28"]);
    expect(
      catalog.directDirectories("phase9.28").map((directory) => path.basename(directory)),
    ).toEqual([
      "combined-valid-three-20260818-1418",
      "smoke-phase9.28-smoke-20260817-1714",
      "smoke-phase9.28-smokeREDO-20260817-1821",
      "test1-phase9.28-test1-20260817-1921",
      "test2-phase9.28-test2-20260817-2203",
      "test3-phase9.28-test3-20260818-1153",
    ]);
  });

  it("uses an explicit cohort to bound report discovery and rejects unavailable phases", () => {
    const catalog = new ArchiveCatalogBuilder({
      archiveRoot,
      includePhases: ["phase9.29"],
      includeCohorts: ["phase9.29/combined-valid-three-20260818-1539"],
    });
    expect(
      catalog.selectedCohortDirectories("phase9.29").map((directory) => path.basename(directory)),
    ).toEqual(["combined-valid-three-20260818-1539"]);

    expect(() =>
      new ArchiveCatalogBuilder({
        archiveRoot,
        includePhases: ["phase9.99"],
        includeCohorts: [],
      }).validateIncludedPhases(),
    ).toThrow("phase archive is unavailable");
  });
});
