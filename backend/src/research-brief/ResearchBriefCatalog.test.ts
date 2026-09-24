import { describe, expect, it } from "vitest";

import { parseResearchBriefArgs, resolveResearchBriefArchiveRoot } from "./ResearchBriefConfig.js";
import { ResearchBriefCatalog } from "./ResearchBriefCatalog.js";

const config = parseResearchBriefArgs([
  "--archive-root=data/archive",
  "--include-phase=phase9.28",
  "--include-phase=phase9.29",
  "--include-cohort=phase9.29/combined-valid-three-20260818-1539",
]);

describe("ResearchBriefCatalog", () => {
  it("discovers only the fixed canonical JSON evidence in deterministic order", () => {
    const catalog = new ResearchBriefCatalog({
      archiveRoot: resolveResearchBriefArchiveRoot(config),
      config,
    });
    const result = catalog.discover();

    expect(result.phase928RunnerSources).toHaveLength(5);
    expect(result.phase929AttributionSources).toHaveLength(1);
    expect(result.phase928RunnerSources.map((source) => source.relativePath)).toEqual([
      "phase9.28/smoke-phase9.28-smoke-20260817-1714/runner-output/terminal_476f8ef5-0c31-46f8-a95f-0b44cbc8af8e.json",
      "phase9.28/smoke-phase9.28-smokeREDO-20260817-1821/runner-output/terminal_ff474b1d-0da4-4fbb-bdd4-2fc8b20cc209.json",
      "phase9.28/test1-phase9.28-test1-20260817-1921/runner-output/terminal_edd05f07-1b3d-4262-baa9-17cb85c68aee.json",
      "phase9.28/test2-phase9.28-test2-20260817-2203/runner-output/terminal_c5e1afe2-b25d-4dfe-bd79-222ee21fa5de.json",
      "phase9.28/test3-phase9.28-test3-20260818-1153/runner-output/terminal_c440d73f-2245-4679-883b-32e3b9b758bb.json",
    ]);
    expect(
      result.phase928RunnerSources.every(
        (source) => !source.relativePath.includes("legacy-root-artifacts-"),
      ),
    ).toBe(true);
    expect(result.phase929AttributionSources[0]?.relativePath).toBe(
      "phase9.29/combined-valid-three-20260818-1539/shadow-fast-attribution-2026-08-18T22-37-25-084Z.json",
    );
    expect(result.skippedInputs).toEqual([
      { path: "phase9.28/legacy-root-artifacts-20260818", reason: "LEGACY_CLEANUP_COPY" },
    ]);
  });
});
