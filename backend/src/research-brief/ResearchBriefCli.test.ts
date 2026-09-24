import { describe, expect, it } from "vitest";

import { formatResearchBriefError } from "./ResearchBriefErrors.js";
import { runResearchBriefCli } from "./ResearchBriefCli.js";

const validArgs = [
  "--archive-root=data/archive",
  "--include-phase=phase9.28",
  "--include-phase=phase9.29",
  "--include-cohort=phase9.29/combined-valid-three-20260818-1539",
  "--format=json",
];

describe("runResearchBriefCli", () => {
  it("writes one JSON brief to the supplied stdout writer only", () => {
    const output: string[] = [];
    const brief = runResearchBriefCli(validArgs, (value) => output.push(value));

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      contentFingerprint: brief.contentFingerprint,
      recordedConclusion: { status: "NO_DEFENSIBLE_HYPOTHESIS" },
    });
  });

  it("formats an unsafe scope as exactly one public error code", () => {
    try {
      runResearchBriefCli([...validArgs, "--output=brief.md"], () => undefined);
    } catch (error: unknown) {
      expect(formatResearchBriefError(error).match(/RESEARCH_BRIEF_[A-Z_]+/g)).toEqual([
        "RESEARCH_BRIEF_INVALID_SCOPE",
      ]);
      return;
    }
    throw new Error("Expected an invalid-scope error.");
  });
});
